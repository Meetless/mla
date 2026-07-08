import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Behavioral lock for the latency-lever-A rewire of pre-tool-use.sh
// (notes/20260615-rules-as-node-and-action-interception-consolidated-proposal.md).
// The managed Write/Edit PreToolUse hook now PREFERS a minimal sibling entrypoint
// (`dist/pretool-entry.js`, next to the resolved mla path) over `mla _internal
// pretool-observe`: the sibling pays only the deny-decision require graph (~12ms cold)
// instead of cli.js's full command registry (~150ms). The contract this spec pins:
//
//   1. entry present  -> the hook runs the sibling, NOT `mla _internal pretool-observe`,
//                        and forwards the sibling's decision body verbatim.
//   2. entry absent    -> the hook falls back to `mla _internal pretool-observe`
//                        (pkg binary / older install path) and forwards its body.
//   3. either path empty/whitespace -> fail OPEN to the `{}` no-decision body, exit 0.
//
// The hook is driven for real (spawned bash) against stub executables that record how
// they were invoked, so the dispatch + fallback + fail-open behavior is asserted
// end to end with no build dependency (the only "external" seam, the mla binary, is
// the stub -- per the project rule, only external boundaries are stubbed).

const HOOK_SRC = path.resolve(__dirname, "../../src/hooks-template/pre-tool-use.sh");

interface HookRun {
  stdout: string;
  status: number;
  record: string; // who-was-invoked log written by the stubs
}

async function runHook(opts: {
  // When defined, plant an executable sibling pretool-entry.js that prints this body.
  // When undefined, no sibling exists (the fallback path).
  entryBody?: string;
  mlaBody: string; // what the mla stub prints for `_internal pretool-observe`
  input?: string;
}): Promise<HookRun> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pretool-hook-"));
  try {
    const home = path.join(tmp, "home");
    fs.mkdirSync(home);
    const bin = path.join(tmp, "bin");
    fs.mkdirSync(bin);
    const record = path.join(tmp, "record.log");

    // mla stub: drains stdin, records its argv, prints mlaBody only for the observe subcommand.
    const mlaPath = path.join(bin, "mla");
    fs.writeFileSync(
      mlaPath,
      `#!/usr/bin/env bash\ncat >/dev/null 2>&1 || true\necho "mla:$*" >> "${record}"\n` +
        `if [[ "$1" == "_internal" && "$2" == "pretool-observe" ]]; then printf '%s' '${opts.mlaBody}'; fi\n`,
    );
    fs.chmodSync(mlaPath, 0o755);

    if (opts.entryBody !== undefined) {
      const entryPath = path.join(bin, "pretool-entry.js");
      fs.writeFileSync(
        entryPath,
        `#!/usr/bin/env bash\ncat >/dev/null 2>&1 || true\necho "entry" >> "${record}"\nprintf '%s' '${opts.entryBody}'\n`,
      );
      fs.chmodSync(entryPath, 0o755);
    }

    fs.writeFileSync(path.join(home, "cli-config.json"), JSON.stringify({ mlaPath }));

    const hookPath = path.join(tmp, "pre-tool-use.sh");
    fs.copyFileSync(HOOK_SRC, hookPath);
    fs.chmodSync(hookPath, 0o755);

    const input =
      opts.input ??
      JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "notes/x.md" } });

    const { stdout, status } = await new Promise<{ stdout: string; status: number }>((resolve, reject) => {
      const child = spawn("bash", [hookPath], { cwd: tmp, env: { ...process.env, MEETLESS_HOME: home } });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", () => {});
      child.on("error", reject);
      child.on("close", (code) => resolve({ stdout: out, status: code ?? -1 }));
      child.stdin.write(input);
      child.stdin.end();
    });

    const rec = fs.existsSync(record) ? fs.readFileSync(record, "utf8") : "";
    return { stdout, status, record: rec };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("pre-tool-use.sh: latency-lever-A entrypoint dispatch + fallback", () => {
  beforeAll(() => {
    const jq = spawnSync("jq", ["--version"], { encoding: "utf8" });
    if (jq.status !== 0) throw new Error("jq must be installed to run pretool-entry-hook specs");
  });

  it("runs the sibling pretool-entry.js (not `mla _internal pretool-observe`) and forwards its body", async () => {
    const deny = '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"blocked"}}';
    const r = await runHook({ entryBody: deny, mlaBody: "{}" });

    expect(r.status).toBe(0);
    expect(r.stdout).toBe(deny);
    expect(r.record).toContain("entry");
    // the whole point of the lever: the slow `mla _internal pretool-observe` transport is bypassed.
    expect(r.record).not.toContain("mla:_internal pretool-observe");
  });

  it("falls back to `mla _internal pretool-observe` when no sibling entry exists", async () => {
    const deny = '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"blocked"}}';
    const r = await runHook({ mlaBody: deny }); // entryBody undefined -> no sibling

    expect(r.status).toBe(0);
    expect(r.stdout).toBe(deny);
    expect(r.record).toContain("mla:_internal pretool-observe");
    expect(r.record).not.toContain("entry");
  });

  it("fails open to {} when the sibling entry prints nothing (exit 0, never blocks)", async () => {
    const r = await runHook({ entryBody: "", mlaBody: "{}" });

    expect(r.status).toBe(0);
    expect(r.stdout).toBe("{}");
    expect(r.record).toContain("entry");
  });
});
