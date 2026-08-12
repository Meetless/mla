import { mkdtempSync, writeFileSync, readFileSync, statSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { scrubTraceLine, scrubTraceFile, scrubSidecarText, scrubSidecarDir } from "../../src/lib/trace-scrub";

// `~/.meetless/logs/ask-traces.jsonl` used to persist the RAW operator prompt in
// `input.prompt`. The writer stopped doing that (user-prompt-submit.sh, "NO prompt
// body"), and redaction-instead-of-dropping was considered and REJECTED there for a
// reason that governs this file too: redaction keeps text, so every secret shape the
// scanner does not yet know still lands on disk. Dropping the field cannot fail open.
//
// The writer fix is forward-only. On the dogfood machine 4,302 of 4,319 rows predate it
// and still carry the body, including four live credential shapes reported on 2026-08-04
// and still unrotated on 2026-08-06. This is the one-shot drain for those rows.
//
// Scope: the field is REMOVED, never rewritten in place. `prompt_chars` and
// `raw_prompt_hash` are present on every row in the corpus (4,319 of 4,319), so nothing
// downstream loses a field it had, and the length + hash that the current contract keeps
// both survive.

// A credential-SHAPED value, generated to look like the real ones without being one.
// Deliberately not a real key: a test fixture that ships a live secret is the very
// defect under test.
const CREDENTIAL_SHAPED = `sk-ant-api03-${"A1b2C3d4E5f6G7h8".repeat(5)}`;

function row(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    trace_id: "t1",
    ts: "2026-07-12T02:01:15Z",
    session_id: "6bba7648",
    input: { prompt: `deploy with ${CREDENTIAL_SHAPED} please`, prompt_chars: 42, raw_prompt_hash: "abc123" },
    hook: { injected: true },
    ...overrides,
  });
}

describe("scrubTraceLine", () => {
  it("removes the raw prompt body from a row that carries one", () => {
    const { line, changed } = scrubTraceLine(row());

    expect(changed).toBe(true);
    expect(JSON.parse(line).input).not.toHaveProperty("prompt");
  });

  it("keeps the length and hash the current writer still records", () => {
    const { line } = scrubTraceLine(row());

    expect(JSON.parse(line).input).toEqual({ prompt_chars: 42, raw_prompt_hash: "abc123" });
  });

  it("does not carry the credential text anywhere else in the scrubbed line", () => {
    const { line } = scrubTraceLine(row());

    expect(line).not.toContain(CREDENTIAL_SHAPED);
    expect(line).not.toContain("sk-ant-");
  });

  it("leaves a row the current writer produced byte-identical", () => {
    // Rows written after the writer fix have no `input.prompt` at all. Rewriting them
    // would churn 17 rows for nothing and, worse, re-serialize JSON whose key order the
    // hook's jq chose -- making a diff of this file unreadable for no gain.
    const clean = JSON.stringify({ trace_id: "t2", input: { prompt_chars: 6, raw_prompt_hash: "d" } });

    const { line, changed } = scrubTraceLine(clean);

    expect(changed).toBe(false);
    expect(line).toBe(clean);
  });

  it("leaves a line it cannot parse untouched rather than dropping it", () => {
    // A truncated final line is the normal shape of a file being appended to under a
    // lock. Dropping it would destroy a row to protect a field that line may not even
    // have. Preserve and report; never delete data we failed to understand.
    const junk = '{"trace_id":"t3","input":{"prom';

    const { line, changed, unparseable } = scrubTraceLine(junk);

    expect(line).toBe(junk);
    expect(changed).toBe(false);
    expect(unparseable).toBe(true);
  });
});

describe("scrubTraceFile", () => {
  function fixture(lines: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "mla-scrub-"));
    const path = join(dir, "ask-traces.jsonl");
    writeFileSync(path, lines.join("\n") + "\n");
    return path;
  }

  it("drops every prompt body in the file and reports how many", () => {
    const path = fixture([row(), row(), JSON.stringify({ trace_id: "t9", input: { prompt_chars: 1 } })]);

    const report = scrubTraceFile(path);

    expect(report.scrubbed).toBe(2);
    expect(report.total).toBe(3);
    expect(readFileSync(path, "utf8")).not.toContain("sk-ant-");
  });

  it("preserves every row, so the line count is unchanged", () => {
    const path = fixture([row(), row(), row()]);

    scrubTraceFile(path);

    expect(readFileSync(path, "utf8").trimEnd().split("\n")).toHaveLength(3);
  });

  it("leaves the file readable only by its owner", () => {
    // The live file is 0600 (`ml_private_file`). An atomic replace writes a NEW inode, so
    // the mode is whatever the umask says unless this sets it. Scrubbing secrets out of a
    // file while widening its permissions would be a net loss.
    const path = fixture([row()]);
    chmodSync(path, 0o600);

    scrubTraceFile(path);

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("reports the credential kinds it found without returning their values", () => {
    // The skill rule is fingerprints only: an operator needs to know WHICH credential
    // families were exposed in order to rotate them, and needs the report itself not to
    // become a second copy of the secret.
    const path = fixture([row()]);

    const report = scrubTraceFile(path);

    expect(report.credentialKinds.length).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toContain(CREDENTIAL_SHAPED);
  });

  it("is a no-op the second time, so re-running cannot corrupt the file", () => {
    const path = fixture([row(), row()]);

    scrubTraceFile(path);
    const afterFirst = readFileSync(path, "utf8");
    const second = scrubTraceFile(path);

    expect(second.scrubbed).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(afterFirst);
  });
});

// The sidecar (`logs/enrichments/<trace_id>.md`) is the SECOND door on the same material.
// `write_sidecar` no longer prints the body, but that fix is forward-only and the dogfood
// machine holds 4,323 pre-fix files, all at mode 0644, carrying the same four credential
// families the 2026-08-04 audit reported "in the trace".
const SIDECAR_CREDENTIAL = `ghp_${"aB3dE6gH9jK2mN5pQ8rS1tV4wX7yZ0aB3d".slice(0, 36)}`;

function sidecar(prompt: string): string {
  return [
    "# Meetless enrichment trace abc123",
    "",
    "- ts: 2026-07-12T02:01:15Z",
    "- layer2_injected: false",
    "",
    "## Prompt",
    "",
    prompt,
    "",
    "## Layer 2 enrichment (status=skipped, confidence=none)",
    "",
    "(none)",
    "",
  ].join("\n");
}

describe("scrubSidecarText", () => {
  it("removes the prompt section body", () => {
    const { text, changed } = scrubSidecarText(sidecar(`deploy with ${SIDECAR_CREDENTIAL}`));

    expect(changed).toBe(true);
    expect(text).not.toContain(SIDECAR_CREDENTIAL);
    expect(text).not.toContain("deploy with");
  });

  it("keeps a multi-line prompt from surviving in its later lines", () => {
    // The body is not one line. A fix that dropped only the first line after the heading
    // would pass a single-line fixture and leak every real pasted log.
    const { text } = scrubSidecarText(sidecar(`first line\nsecond line ${SIDECAR_CREDENTIAL}\nthird line`));

    expect(text).not.toContain(SIDECAR_CREDENTIAL);
    expect(text).not.toContain("third line");
  });

  it("says the body was removed rather than silently leaving a blank section", () => {
    // A section that just goes empty is indistinguishable from a turn with no prompt.
    // The file should state what happened to it.
    const { text } = scrubSidecarText(sidecar("hello"));

    expect(text).toMatch(/prompt body removed/i);
  });

  it("preserves every other section, including the enrichment payload", () => {
    const { text } = scrubSidecarText(sidecar("hello"));

    expect(text).toContain("# Meetless enrichment trace abc123");
    expect(text).toContain("- ts: 2026-07-12T02:01:15Z");
    expect(text).toContain("## Layer 2 enrichment (status=skipped, confidence=none)");
    expect(text).toContain("(none)");
  });

  it("leaves a file the current writer produced unchanged", () => {
    const current = ["# Meetless enrichment trace z", "", "- prompt_chars: 5", "", "## Layer 2 enrichment (status=skipped, confidence=none)", "", "(none)", ""].join("\n");

    const { text, changed } = scrubSidecarText(current);

    expect(changed).toBe(false);
    expect(text).toBe(current);
  });
});

describe("scrubSidecarDir", () => {
  function dirWith(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "mla-sidecars-"));
    for (const [name, body] of Object.entries(files)) {
      const p = join(dir, name);
      writeFileSync(p, body);
      chmodSync(p, 0o644);
    }
    return dir;
  }

  it("scrubs every sidecar carrying a body and counts them", () => {
    const dir = dirWith({
      "a.md": sidecar(`x ${SIDECAR_CREDENTIAL}`),
      "b.md": sidecar("y"),
      "c.md": "# Meetless enrichment trace c\n\n- prompt_chars: 3\n",
    });

    const report = scrubSidecarDir(dir);

    expect(report.scrubbed).toBe(2);
    expect(report.total).toBe(3);
    expect(readFileSync(join(dir, "a.md"), "utf8")).not.toContain(SIDECAR_CREDENTIAL);
  });

  it("tightens the mode to owner-only, which is why these leaked so widely", () => {
    const dir = dirWith({ "a.md": sidecar("x") });

    scrubSidecarDir(dir);

    expect(statSync(join(dir, "a.md")).mode & 0o777).toBe(0o600);
  });

  it("tightens the mode even on a file that had no body to scrub", () => {
    // A 0644 file with no prompt is still a 0644 file holding the injected payload. The
    // permission defect and the body defect are independent, and fixing only the rows that
    // happen to carry a prompt would leave most of the corpus world-readable.
    const dir = dirWith({ "c.md": "# Meetless enrichment trace c\n\n- prompt_chars: 3\n" });

    scrubSidecarDir(dir);

    expect(statSync(join(dir, "c.md")).mode & 0o777).toBe(0o600);
  });

  it("is a no-op the second time", () => {
    const dir = dirWith({ "a.md": sidecar("x"), "b.md": sidecar("y") });

    scrubSidecarDir(dir);
    const after = readFileSync(join(dir, "a.md"), "utf8");
    const second = scrubSidecarDir(dir);

    expect(second.scrubbed).toBe(0);
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe(after);
  });
});
