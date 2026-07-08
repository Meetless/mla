import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Behavioral lock for the Pass 1 + re-spool malformed-line tolerance
// (Wedge v6 Epoch 26).
//
// Pre-fix flush.sh Pass 1 ran `EVT="$(printf '%s' "$LINE" | jq -r '.event')"`
// inside a `while read` loop under `set -euo pipefail`. ONE malformed JSONL
// line caused jq to exit 5; the $() substitution propagated that exit; the
// whole flush crashed. The .draining.$$ snapshot was stranded, and the next
// flush's orphan recovery would `cat` it back into the queue file and crash
// again on the same bad line. Infinite reflush, OR permanent backlog if no
// new hook writes triggered a new flush. The same crash existed in the
// Pass 2 PATCH-failure re-spool loop.
//
// Post-fix both loops use `... 2>/dev/null || echo ""` INSIDE the subshell
// so the substitution can never return non-zero. EVT becomes "" on a bad
// line; the loop's category check skips it cleanly.

const FLUSH_SH = path.resolve(
  __dirname,
  "../../src/hooks-template/flush.sh",
);

function runSnippet(snippet: string): { status: number; stdout: string; stderr: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-flush-p1-"));
  const scriptPath = path.join(tmp, "test.sh");
  fs.writeFileSync(scriptPath, snippet, { mode: 0o755 });
  const r = spawnSync("bash", [scriptPath], { encoding: "utf8" });
  fs.rmSync(tmp, { recursive: true, force: true });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

// Exact replica of the Pass 1 parsing pattern in flush.sh. If flush.sh ever
// drops the `|| echo ""` tolerance, the drift guard (last spec below) flags
// it; this snippet test pins the behavior the pattern produces.
function pass1Snippet(input: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail
TMP=$(mktemp)
cat > "$TMP" <<'JSONL_EOF'
${input}
JSONL_EOF
while IFS= read -r LINE || [[ -n "$LINE" ]]; do
  [[ -z "$LINE" ]] && continue
  EVT="$(printf '%s' "$LINE" | jq -r '.event' 2>/dev/null || echo "")"
  if [[ "$EVT" != "session_started" ]]; then
    continue
  fi
  BODY="$(printf '%s' "$LINE" | jq -c '{sid: .sessionId}' 2>/dev/null || echo "")"
  if [[ -z "$BODY" ]]; then
    continue
  fi
  echo "POST $BODY"
done < "$TMP"
echo "DONE"
rm -f "$TMP"
`;
}

function preFixSnippet(input: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail
TMP=$(mktemp)
cat > "$TMP" <<'JSONL_EOF'
${input}
JSONL_EOF
while IFS= read -r LINE || [[ -n "$LINE" ]]; do
  [[ -z "$LINE" ]] && continue
  EVT="$(printf '%s' "$LINE" | jq -r '.event')"
  if [[ "$EVT" != "session_started" ]]; then
    continue
  fi
  echo "POST $LINE"
done < "$TMP"
echo "DONE"
rm -f "$TMP"
`;
}

describe("flush.sh Pass 1 + re-spool malformed-line tolerance", () => {
  beforeAll(() => {
    expect(fs.existsSync(FLUSH_SH)).toBe(true);
    const jq = spawnSync("jq", ["--version"], { encoding: "utf8" });
    if (jq.status !== 0) {
      throw new Error("jq must be installed to run flush-pass1-tolerance specs");
    }
  });

  it("pre-fix pattern CRASHES on a malformed line (proves the trap was real)", () => {
    const input = [
      '{"event":"session_started","sessionId":"s1"}',
      "{not_json",
      '{"event":"session_started","sessionId":"s2"}',
    ].join("\n");
    const r = runSnippet(preFixSnippet(input));
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("POST {\"event\":\"session_started\",\"sessionId\":\"s1\"}");
    expect(r.stdout).not.toContain("DONE");
  });

  it("post-fix pattern SURVIVES a malformed line and processes valid ones around it", () => {
    const input = [
      '{"event":"session_started","sessionId":"s1"}',
      "{not_json",
      '{"event":"prompt_submitted","sessionId":"s1"}',
      '{"event":"session_started","sessionId":"s2"}',
    ].join("\n");
    const r = runSnippet(pass1Snippet(input));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('POST {"sid":"s1"}');
    expect(r.stdout).toContain('POST {"sid":"s2"}');
    expect(r.stdout).toContain("DONE");
  });

  it("survives a batch where EVERY line is corrupt (no exit-5 cliff, just no POSTs)", () => {
    const input = ["{also bad", "garbage", "still bad"].join("\n");
    const r = runSnippet(pass1Snippet(input));
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("POST");
    expect(r.stdout).toContain("DONE");
  });

  it("skips lines that parse but lack .event (jq returns 'null')", () => {
    const input = [
      '{"missing_event":true,"sessionId":"sX"}',
      '{"event":"session_started","sessionId":"sY"}',
    ].join("\n");
    const r = runSnippet(pass1Snippet(input));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('POST {"sid":"sY"}');
    expect(r.stdout).not.toContain('"sid":"sX"');
    expect(r.stdout).toContain("DONE");
  });

  it("tolerates trailing newlines, empty lines, and whitespace-only lines", () => {
    const input = [
      "",
      '{"event":"session_started","sessionId":"sA"}',
      "",
      "   ",
      '{"event":"session_started","sessionId":"sB"}',
      "",
    ].join("\n");
    const r = runSnippet(pass1Snippet(input));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('POST {"sid":"sA"}');
    expect(r.stdout).toContain('POST {"sid":"sB"}');
    expect(r.stdout).toContain("DONE");
  });

  // Drift guard: if flush.sh ever drops the tolerance fallback, this fails.
  // The two `printf | jq -r '.event' 2>/dev/null || echo ""` invocations are
  // the load-bearing piece -- without them the pre-fix crash returns.
  it("flush.sh KEEPS the defensive `2>/dev/null || echo \"\"` pattern (drift guard)", () => {
    const flushSh = fs.readFileSync(FLUSH_SH, "utf8");
    const matches = flushSh.match(
      /jq -r '\.event' 2>\/dev\/null \|\| echo ""/g,
    );
    expect(matches).not.toBeNull();
    // Pass 1 has one; the Pass 2 re-spool loop has another.
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("flush.sh KEEPS the bare `jq -r '.event'` pattern OUT (no unguarded substitutions left)", () => {
    const flushSh = fs.readFileSync(FLUSH_SH, "utf8");
    // Strip comments (lines starting with `#`) and the guarded form, then
    // assert no naked `jq -r '.event'` remains anywhere in the live shell.
    const stripped = flushSh
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n")
      .replace(/jq -r '\.event' 2>\/dev\/null \|\| echo ""/g, "<<GUARDED>>");
    expect(stripped).not.toMatch(/jq -r '\.event'/);
  });
});
