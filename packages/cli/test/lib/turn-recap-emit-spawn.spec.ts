import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Phase 3 / Layer D: the Stop hook's detached per-turn Langfuse emission glue.
// Stop fires spawn_turn_recap_emit "$SESSION_ID" "$REPORT_TURN", which (when
// enabled) detaches `mla _internal turn-recap --session <sid> --turn <N>
// --emit-langfuse` so intel attaches the mla_ran / mla_assist scores + recap
// metadata to that turn's Langfuse trace. The glue is thin: the CLI behaviour
// (and the intel POST) is covered by internal-turn-recap.spec.ts +
// turn-recap-emit.spec.ts. Here we lock (1) the default-on kill switch
// (MEETLESS_TURN_RECAP_LANGFUSE -- its OWN flag, INDEPENDENT of the Layer C-lite
// injection's MEETLESS_TURN_RECAP), (2) that the detach invokes the CLI with the
// right argv, (3) that a non-positive turn (no real turn ran) is a no-op, and
// (4) that stop.sh actually calls it (drift guard).
//
// The Langfuse half of the injection x Langfuse 2x2 decoupling matrix lives here;
// the injection half lives in intercept-hook.spec.ts. Together they prove the four
// combinations An asked for. On THIS (Langfuse) surface the spawn must fire iff
// MEETLESS_TURN_RECAP_LANGFUSE != off, REGARDLESS of MEETLESS_TURN_RECAP.
// See notes/20260609-mla-per-turn-assist-recap-plan.md §4.4 / Test 5.

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-recapspawn-"));
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
    ["-c", `source "${COMMON}"; turn_recap_langfuse_enabled; echo "rc=$?"`],
    { encoding: "utf8", env: { ...process.env, MEETLESS_HOME: os.tmpdir(), ...env } },
  );
  const m = /rc=(\d+)/.exec(r.stdout);
  return m ? Number(m[1]) : -1;
}

describe("common.sh turn_recap_langfuse_enabled (Layer D kill switch)", () => {
  beforeAll(() => {
    if (spawnSync("jq", ["--version"]).status !== 0) throw new Error("jq required");
  });

  it("is enabled by default (unset)", () => {
    expect(gate({})).toBe(0);
  });

  it("is enabled when MEETLESS_TURN_RECAP_LANGFUSE=on", () => {
    expect(gate({ MEETLESS_TURN_RECAP_LANGFUSE: "on" })).toBe(0);
  });

  it("is disabled (non-zero) when MEETLESS_TURN_RECAP_LANGFUSE=off", () => {
    expect(gate({ MEETLESS_TURN_RECAP_LANGFUSE: "off" })).not.toBe(0);
  });

  // Independence from the Layer C-lite injection flag: the Langfuse gate reads
  // ONLY MEETLESS_TURN_RECAP_LANGFUSE. MEETLESS_TURN_RECAP must not move it in
  // either direction.
  it("ignores MEETLESS_TURN_RECAP=off (injection off must not disable Langfuse)", () => {
    expect(gate({ MEETLESS_TURN_RECAP: "off" })).toBe(0);
  });

  it("stays off under MEETLESS_TURN_RECAP=on when its own flag is off", () => {
    expect(
      gate({ MEETLESS_TURN_RECAP: "on", MEETLESS_TURN_RECAP_LANGFUSE: "off" }),
    ).not.toBe(0);
  });
});

describe("common.sh spawn_turn_recap_emit (detached Layer D glue)", () => {
  beforeAll(() => {
    if (spawnSync("jq", ["--version"]).status !== 0) throw new Error("jq required");
  });

  it("detaches `mla _internal turn-recap --session <sid> --turn <N> --emit-langfuse` when enabled", () => {
    const { recorded, tmp } = withRecordingMla('spawn_turn_recap_emit "sess-x" "5"');
    try {
      expect(recorded).toContain(
        "_internal turn-recap --session sess-x --turn 5 --emit-langfuse",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("is a no-op when the kill switch is off (MEETLESS_TURN_RECAP_LANGFUSE=off)", () => {
    const { recorded, tmp } = withRecordingMla('spawn_turn_recap_emit "sess-y" "3"', {
      MEETLESS_TURN_RECAP_LANGFUSE: "off",
    });
    try {
      expect(recorded).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("is a no-op when the turn index is 0 (no real turn ran)", () => {
    const { recorded, tmp } = withRecordingMla('spawn_turn_recap_emit "sess-z" "0"');
    try {
      expect(recorded).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// The Langfuse half of the injection x Langfuse 2x2: the detached spawn must fire
// iff MEETLESS_TURN_RECAP_LANGFUSE != off, REGARDLESS of MEETLESS_TURN_RECAP. The
// injection half (a prompt block fires iff MEETLESS_TURN_RECAP != off, regardless
// of MEETLESS_TURN_RECAP_LANGFUSE) is proven in intercept-hook.spec.ts. Together
// they pin all four combinations An asked for.
describe("spawn_turn_recap_emit x MEETLESS_TURN_RECAP decoupling (2x2 Langfuse half)", () => {
  beforeAll(() => {
    if (spawnSync("jq", ["--version"]).status !== 0) throw new Error("jq required");
  });

  const FIRES = "_internal turn-recap --session sess-m --turn 4 --emit-langfuse";

  // Combo 1 (both on): Langfuse spawn fires.
  it("both flags on -> spawn fires", () => {
    const { recorded, tmp } = withRecordingMla('spawn_turn_recap_emit "sess-m" "4"', {
      MEETLESS_TURN_RECAP: "on",
      MEETLESS_TURN_RECAP_LANGFUSE: "on",
    });
    try {
      expect(recorded).toContain(FIRES);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Combo 2 (injection off, Langfuse on): spawn STILL fires -- the injection flag
  // does not silence the Langfuse surface.
  it("injection off + Langfuse on -> spawn still fires", () => {
    const { recorded, tmp } = withRecordingMla('spawn_turn_recap_emit "sess-m" "4"', {
      MEETLESS_TURN_RECAP: "off",
      MEETLESS_TURN_RECAP_LANGFUSE: "on",
    });
    try {
      expect(recorded).toContain(FIRES);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Combo 3 (injection on, Langfuse off): spawn does NOT fire -- the injection flag
  // being on does not resurrect the Langfuse surface.
  it("injection on + Langfuse off -> spawn does not fire", () => {
    const { recorded, tmp } = withRecordingMla('spawn_turn_recap_emit "sess-m" "4"', {
      MEETLESS_TURN_RECAP: "on",
      MEETLESS_TURN_RECAP_LANGFUSE: "off",
    });
    try {
      expect(recorded).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Combo 4 (both off): spawn does not fire.
  it("both flags off -> spawn does not fire", () => {
    const { recorded, tmp } = withRecordingMla('spawn_turn_recap_emit "sess-m" "4"', {
      MEETLESS_TURN_RECAP: "off",
      MEETLESS_TURN_RECAP_LANGFUSE: "off",
    });
    try {
      expect(recorded).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("stop.sh wiring (drift guard)", () => {
  it("calls spawn_turn_recap_emit with the session id + the just-finished turn, after the evidence correlator", () => {
    const src = fs.readFileSync(STOP, "utf8");
    expect(src).toMatch(/spawn_turn_recap_emit "\$SESSION_ID" "\$REPORT_TURN"/);
    // REPORT_TURN (the just-finished turn N) must be computed before we emit it.
    expect(src.indexOf("REPORT_TURN=")).toBeLessThan(
      src.indexOf("spawn_turn_recap_emit"),
    );
    // Ordering: rides the same end-of-Stop tail as the other detached kickoffs,
    // after the cross-session evidence correlator so it never reshuffles GC.
    expect(src.indexOf("spawn_evidence_correlate")).toBeLessThan(
      src.indexOf("spawn_turn_recap_emit"),
    );
  });
});
