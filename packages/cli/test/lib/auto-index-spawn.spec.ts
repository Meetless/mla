import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Phase C: the Stop hook's detached Zone 2 auto-index glue. Stop fires
// spawn_auto_index "$SESSION_ID", which (when enabled) detaches
// `mla _internal auto-index --session <sid>` so the session's produced prose
// docs land in the owner's Personal KB as SHADOW (never grounds anyone;
// INV-GROUNDING-APPROVED). The glue is thin: the CLI behavior itself is covered
// by internal-auto-index.spec.ts. Here we lock (1) the default-on kill switch
// (MEETLESS_AUTO_INDEX), (2) that the detach invokes the CLI with the right argv,
// and (3) that stop.sh actually calls it (drift guard).
// See notes/20260605-mla-auto-index-loop-implementation-plan.md (Phase C).

const HOOKS_DIR = path.resolve(__dirname, "../../src/hooks-template");
const COMMON = path.join(HOOKS_DIR, "common.sh");
const STOP = path.join(HOOKS_DIR, "stop.sh");

// Source common.sh in a clean MEETLESS_HOME whose cli-config.json points mlaPath
// at a recording shim, then run one command. Returns the shim's recorded argv
// lines (the detached child writes them; we poll until they appear).
function withRecordingMla(
  body: string,
  env: Record<string, string> = {},
): { recorded: string[]; tmp: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-aispawn-"));
  const home = path.join(tmp, "home");
  fs.mkdirSync(path.join(home, "logs"), { recursive: true });

  const recFile = path.join(tmp, "invoked.args");
  const shim = path.join(tmp, "mla-shim.sh");
  fs.writeFileSync(shim, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${recFile}"\n`);
  fs.chmodSync(shim, 0o755);

  fs.writeFileSync(
    path.join(home, "cli-config.json"),
    JSON.stringify({
      controlUrl: "http://127.0.0.1:1",
      controlToken: "x",
      workspaceId: "ws_test",
      mlaPath: shim,
    }),
  );

  spawnSync("bash", ["-c", `source "${COMMON}"; ${body}`], {
    encoding: "utf8",
    env: { ...process.env, MEETLESS_HOME: home, MEETLESS_DEBUG: "0", ...env },
  });

  // The detach double-forks; poll briefly for the recorded argv.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (fs.existsSync(recFile)) break;
    spawnSync("sleep", ["0.05"]);
  }
  const recorded = fs.existsSync(recFile)
    ? fs.readFileSync(recFile, "utf8").split("\n").filter((l) => l.trim().length > 0)
    : [];
  return { recorded, tmp };
}

// Deterministic gate check: source common.sh, call the predicate, read exit code.
function gate(env: Record<string, string>): number {
  const r = spawnSync(
    "bash",
    ["-c", `source "${COMMON}"; auto_index_enabled; echo "rc=$?"`],
    { encoding: "utf8", env: { ...process.env, MEETLESS_HOME: os.tmpdir(), ...env } },
  );
  const m = /rc=(\d+)/.exec(r.stdout);
  return m ? Number(m[1]) : -1;
}

describe("common.sh auto_index_enabled (Zone 2 kill switch)", () => {
  beforeAll(() => {
    if (spawnSync("jq", ["--version"]).status !== 0) throw new Error("jq required");
  });

  it("is enabled by default (unset)", () => {
    expect(gate({})).toBe(0);
  });

  it("is enabled when MEETLESS_AUTO_INDEX=1", () => {
    expect(gate({ MEETLESS_AUTO_INDEX: "1" })).toBe(0);
  });

  it("is disabled (non-zero) when MEETLESS_AUTO_INDEX=0", () => {
    expect(gate({ MEETLESS_AUTO_INDEX: "0" })).not.toBe(0);
  });
});

describe("common.sh spawn_auto_index (detached Zone 2 glue)", () => {
  beforeAll(() => {
    if (spawnSync("jq", ["--version"]).status !== 0) throw new Error("jq required");
  });

  it("detaches `mla _internal auto-index --session <sid>` when enabled", () => {
    const { recorded, tmp } = withRecordingMla('spawn_auto_index "sess-x"');
    try {
      expect(recorded).toContain("_internal auto-index --session sess-x");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("is a no-op when the kill switch is off (MEETLESS_AUTO_INDEX=0)", () => {
    const { recorded, tmp } = withRecordingMla('spawn_auto_index "sess-y"', {
      MEETLESS_AUTO_INDEX: "0",
    });
    try {
      expect(recorded).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("stop.sh wiring (drift guard)", () => {
  it("calls spawn_auto_index with the session id, after the reap sweep", () => {
    const src = fs.readFileSync(STOP, "utf8");
    expect(src).toMatch(/spawn_auto_index "\$SESSION_ID"/);
    // Ordering: the auto-index spawn comes after the stale-session reap so it
    // never delays the GC and rides the same end-of-Stop tail.
    expect(src.indexOf("spawn_reap")).toBeLessThan(src.indexOf("spawn_auto_index"));
  });
});
