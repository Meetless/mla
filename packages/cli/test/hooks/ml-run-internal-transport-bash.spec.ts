// `ml_run_internal` (common.sh): the three-transport ladder that routes the two hot
// UserPromptSubmit subcommands through their LEAN sibling entrypoints.
//
// WHAT IT IS. Shipped in `451950ef5` ("a quarter of the enrich budget was spent importing
// commands the hook never calls"). `user-prompt-submit.sh` makes exactly two synchronous
// `mla` spawns before it dials intel, `_internal assemble-context` (the floor-rule head)
// and `_internal redact-capture` (the retrieval query). Both used to go through
// `dist/cli.js`, which eagerly imports 30+ command modules plus Sentry/analytics top-level
// init, so the cost was startup rather than work: `mla --version`, which does nothing,
// measured slower than `assemble-context`, which does the whole job. Routing each through
// its own lean sibling took live `pre_enrich_ms` from ~973ms to ~485ms, flat across prompt
// size. This file is the DIRECT coverage for the helper that picks the transport.
//
// WHY THE MIDDLE RUNG IS THE POINT. `pnpm pack` normalizes every packed file to 0644 and
// force-sets 0755 only on `bin` entries, so the `chmod +x` in our build script is real on
// disk and then discarded into the tarball: the sibling arrives from npm at 0644, forever.
// An `-x`-only guard would silently put EVERY npm install back on the slow path, on every
// turn, correctly and invisibly. That exact regression shipped on the pretool path up to
// 0.2.17 and was found by inspection, not by a test. It is pinned here.
//
// SCOPE. This covers the transport contract the helper already implements and nothing
// else: which of the three transports runs, that stdin reaches it, and that its exit code
// is forwarded. It does not test the entry programs (they have their own cores and specs),
// and it deliberately does NOT resurrect the withdrawn single-dispatcher `hook-entry`
// design, which lost on measurement (a shared entry drags assemble-context's ~144ms
// closure onto the ~26ms redaction spawn).
//
// It drives the REAL function sourced from common.sh, never a re-implementation, exactly
// like the classify_mcp_outcome and canonicalize_agent_session_id bash twins. A copy of
// the ladder in this file could drift from the hook; sourcing the real one cannot.
// `MEETLESS_HOME` containment comes from test/jest.setup-home.js, which gives every test
// FILE its own throwaway state root, so sourcing common.sh cannot touch the operator's.

import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COMMON_SH = join(__dirname, "..", "..", "src", "hooks-template", "common.sh");

interface RunResult {
  stdout: string;
  status: number;
  /** who-was-invoked log, appended by whichever stub actually ran */
  record: string;
  /** what the winning transport received on stdin */
  entryStdin: string;
}

/**
 * Plant an `mla` stub and (optionally) a sibling entry next to it, then drive the real
 * `ml_run_internal` and report which transport won.
 *
 * `commonSh` exists so the mutation check can point at a deliberately broken COPY of
 * common.sh. The repo file is never modified: this tree is shared by 10+ sessions.
 */
function run(opts: {
  entry?: { body: string; mode?: number; exitCode?: number };
  mlaBody?: string;
  stdin?: string;
  timeoutSecs?: string;
  commonSh?: string;
}): RunResult {
  const tmp = mkdtempSync(join(tmpdir(), "ml-run-internal-"));
  try {
    const record = join(tmp, "record.log");
    const entryStdinPath = join(tmp, "entry-stdin");

    // mla stub: drains stdin, records its argv, prints the fat-path body.
    const mlaPath = join(tmp, "mla");
    writeFileSync(
      mlaPath,
      [
        "#!/usr/bin/env bash",
        `cat > ${JSON.stringify(entryStdinPath)} 2>/dev/null || true`,
        `echo "mla:$*" >> ${JSON.stringify(record)}`,
        `printf '%s' ${JSON.stringify(opts.mlaBody ?? "FAT")}`,
        "",
      ].join("\n"),
    );
    chmodSync(mlaPath, 0o755);

    if (opts.entry) {
      const entryPath = join(tmp, "redact-entry.js");
      // A real node script, exactly like the shipped one: it has to be runnable BOTH by
      // its shebang (the +x transport) and as an argument to `node` (the npm transport).
      writeFileSync(
        entryPath,
        [
          "#!/usr/bin/env node",
          'const fs = require("fs");',
          `try { fs.writeFileSync(${JSON.stringify(entryStdinPath)}, fs.readFileSync(0, "utf8")); } catch {}`,
          `fs.appendFileSync(${JSON.stringify(record)}, "entry\\n");`,
          `process.stdout.write(${JSON.stringify(opts.entry.body)});`,
          `process.exit(${opts.entry.exitCode ?? 0});`,
          "",
        ].join("\n"),
      );
      // 0644 by default: what npm actually delivers.
      chmodSync(entryPath, opts.entry.mode ?? 0o644);
    }

    const script = [
      'source "$COMMON_SH" >/dev/null 2>&1;',
      'MLA_PATH="$MLA_STUB";',
      'ml_run_internal redact-entry.js "$TMO" _internal redact-capture',
    ].join(" ");

    let stdout = "";
    let status = 0;
    try {
      stdout = execFileSync("bash", ["-c", script], {
        input: opts.stdin ?? "",
        encoding: "utf8",
        env: {
          ...process.env,
          COMMON_SH: opts.commonSh ?? COMMON_SH,
          MLA_STUB: mlaPath,
          TMO: opts.timeoutSecs ?? "",
        },
      });
    } catch (e: unknown) {
      const err = e as { stdout?: Buffer | string; status?: number };
      stdout = String(err.stdout ?? "");
      status = err.status ?? 1;
    }

    const read = (p: string) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return "";
      }
    };
    return { stdout, status, record: read(record), entryStdin: read(entryStdinPath) };
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
}

describe("ml_run_internal transport ladder", () => {
  it("rung 1: runs an EXECUTABLE sibling directly and never reaches the fat cli", () => {
    const r = run({ entry: { body: "LEAN", mode: 0o755 } });
    expect(r.stdout).toBe("LEAN");
    expect(r.record).toContain("entry");
    expect(r.record).not.toContain("mla:");
  });

  it("rung 2: runs a NON-executable sibling through node, which is the npm case", () => {
    // The rung that regressed on the pretool path up to 0.2.17. `pnpm pack` ships this
    // file at 0644; an `-x`-only guard sends every npm install down the slow path.
    const r = run({ entry: { body: "LEAN", mode: 0o644 } });
    expect(r.stdout).toBe("LEAN");
    expect(r.record).toContain("entry");
    expect(r.record).not.toContain("mla:");
  });

  it("rung 3: falls back to the fat `mla _internal <sub>` when no sibling exists", () => {
    // A pkg single-file binary, or an install predating the entries. The slow path is a
    // latency lever's fallback, not a correctness gate: it must stay CORRECT.
    const r = run({ mlaBody: "FAT" });
    expect(r.stdout).toBe("FAT");
    expect(r.record).toContain("mla:_internal redact-capture");
    expect(r.record).not.toContain("entry");
  });

  it("forwards stdin to whichever transport wins", () => {
    const payload = '{"query":"hello","profile":"retrieval"}';
    expect(run({ entry: { body: "LEAN", mode: 0o644 }, stdin: payload }).entryStdin).toBe(payload);
    // ...and the same payload reaches the fat fallback when there is no sibling.
    expect(run({ mlaBody: "FAT", stdin: payload }).entryStdin).toBe(payload);
  });

  it("FORWARDS A NON-ZERO EXIT so the redaction caller can fail closed", () => {
    // The security-critical rung. `runInternalRedactCapture` returns 1 on any read /
    // parse / serialize fault WITHOUT writing a body, and the hook turns an empty result
    // into contentStatus "redaction_failed", keeping only safe metadata. If this helper
    // swallowed the exit code, a redaction fault would read as a successful EMPTY
    // redaction, which is how an unredacted secret reaches disk.
    const r = run({ entry: { body: "", mode: 0o644, exitCode: 1 } });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
  });

  it("honors a timeout argument, and treats an empty one as no timeout", () => {
    // The two redact sites pass 5; the assemble site passes "". A hung redactor must not
    // become a hung prompt, and the assemble site must not acquire a ceiling it never had.
    expect(run({ entry: { body: "LEAN", mode: 0o644 }, timeoutSecs: "5" }).stdout).toBe("LEAN");
    expect(run({ entry: { body: "LEAN", mode: 0o644 }, timeoutSecs: "" }).stdout).toBe("LEAN");
  });

  it("catches a broken middle rung (mutation check on a COPY, never the repo file)", () => {
    // The requirement that this coverage be load-bearing rather than decorative: break
    // the exact behavior that silently regressed on the pretool path, and prove the suite
    // notices. Dropping the `-f` rung is the real-world mutation: everything still works,
    // just via the fat fallback, on every npm install forever.
    const tmp = mkdtempSync(join(tmpdir(), "ml-run-internal-mut-"));
    try {
      const broken = join(tmp, "common.sh");
      const src = readFileSync(COMMON_SH, "utf8");
      const needle = '    if [[ -f "$_entry" ]] && command -v node >/dev/null 2>&1; then';
      expect(src).toContain(needle); // the ladder still has the shape this mutates
      writeFileSync(broken, src.replace(needle, '    if false; then'));

      const r = run({ entry: { body: "LEAN", mode: 0o644 }, mlaBody: "FAT", commonSh: broken });
      // With the rung removed, a 0644 sibling silently falls through to the fat cli.
      expect(r.stdout).toBe("FAT");
      expect(r.record).toContain("mla:_internal redact-capture");
    } finally {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });
});
