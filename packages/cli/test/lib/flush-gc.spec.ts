import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// RC2 wiring: `mla flush --gc` runs the age-gated reaper after the drain.
//
// QUEUE_DIR is import-time-derived from MEETLESS_HOME, so we point MEETLESS_HOME
// at a tmp dir and `require` the command fresh (jest.resetModules) per test. We
// seed ONLY dead sidecars (no `.jsonl`/`.draining`), so listActiveSessions()
// returns [] (the drain loop is a no-op) and the test isolates the reaper hop
// without needing flush.sh or a control server.

describe("mla flush --gc (reaper wiring)", () => {
  let tmp: string;
  let queueDir: string;
  let logSpy: jest.SpyInstance;
  let logged: string[];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-flushgc-"));
    queueDir = path.join(tmp, "queue");
    fs.mkdirSync(queueDir, { recursive: true });
    process.env.MEETLESS_HOME = tmp;
    jest.resetModules();
    logged = [];
    logSpy = jest.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logged.push(a.map(String).join(" "));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    delete process.env.MEETLESS_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function seedDeadSession(sid: string, ageSec: number): string[] {
    const t = (Date.now() - ageSec * 1000) / 1000;
    const files = [`${sid}.lock`, `${sid}.turn`, `${sid}.repoPath`];
    for (const f of files) {
      const full = path.join(queueDir, f);
      fs.writeFileSync(full, f.endsWith(".turn") ? "4" : "");
      fs.utimesSync(full, t, t);
    }
    return files.map((f) => path.join(queueDir, f));
  }

  it("reaps aged dead-session litter and prints a [gc] summary", async () => {
    const { runFlush } = require("../../src/commands/flush");
    const files = seedDeadSession("dead-sid", 2 * 86_400); // 2 days idle

    const code = await runFlush(["--gc"]);
    expect(code).toBe(0);

    for (const f of files) expect(fs.existsSync(f)).toBe(false);
    expect(logged.some((l) => /^\[gc\] reaped 1 stale session/.test(l))).toBe(true);
  });

  it("does NOT reap when --gc is absent (plain flush leaves litter)", async () => {
    const { runFlush } = require("../../src/commands/flush");
    const files = seedDeadSession("dead-sid", 2 * 86_400);

    const code = await runFlush([]);
    expect(code).toBe(0);

    for (const f of files) expect(fs.existsSync(f)).toBe(true);
    expect(logged.some((l) => l.includes("[gc]"))).toBe(false);
  });

  // --reap-only is the Stop-hook path: it must reap dead litter WITHOUT touching
  // the drain loop. If it ran the drain it would spawn flush.sh for every active
  // session on every Stop -- the exact O(sessions) fan-out that produced the
  // 99-lock pile-up. So the discriminator is: an active session's non-empty
  // spool survives AND no `[flush]` line is ever emitted, while aged dead litter
  // is still reaped. The error spy is needed because a drain attempt against the
  // tmp hooks dir (no flush.sh) would log a `[flush] ... FAILED` to console.error.
  // A stranded spool is undelivered work that can never drain (e.g. a session
  // that never resolved a workspace target). reapQueue normally refuses it
  // forever; past the 7d stranded gate it is definitively dead and gets
  // reclaimed, discarding its undeliverable events. This closes the queue-litter
  // leak where no-workspace strands accumulated without bound.
  function seedStrandedSpool(sid: string, ageSec: number, events: number): string {
    const t = (Date.now() - ageSec * 1000) / 1000;
    const spool = path.join(queueDir, `${sid}.jsonl`);
    fs.writeFileSync(spool, '{"event":"tool_used_bash"}\n'.repeat(events));
    fs.utimesSync(spool, t, t);
    return spool;
  }

  it("--reap-only reclaims a stranded spool past the 7d gate but spares one within it", async () => {
    const { runFlush } = require("../../src/commands/flush");
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const deadStranded = seedStrandedSpool("dead-stranded", 8 * 86_400, 3); // 8d, undeliverable
      const freshStranded = seedStrandedSpool("fresh-stranded", 3 * 86_400, 2); // 3d, still spared

      const code = await runFlush(["--reap-only"]);
      expect(code).toBe(0);

      expect(fs.existsSync(deadStranded)).toBe(false); // reclaimed
      expect(fs.existsSync(freshStranded)).toBe(true); // < 7d: still refused
      expect(
        logged.some((l) => /reclaimed 1 stranded session\(s\) discarding 3 undeliverable event/.test(l)),
      ).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("--reap-only reaps litter but never runs the drain loop (active spool untouched)", async () => {
    const { runFlush } = require("../../src/commands/flush");
    const errLogged: string[] = [];
    const errSpy = jest
      .spyOn(console, "error")
      .mockImplementation((...a: unknown[]) => {
        errLogged.push(a.map(String).join(" "));
      });
    try {
      const dead = seedDeadSession("dead-sid", 2 * 86_400);
      // an active session: non-empty spool that a drain WOULD pick up
      const spool = path.join(queueDir, "active-sid.jsonl");
      fs.writeFileSync(spool, '{"event":"prompt_submitted"}\n');

      const code = await runFlush(["--reap-only"]);
      expect(code).toBe(0);

      // dead litter reaped...
      for (const f of dead) expect(fs.existsSync(f)).toBe(false);
      // ...active spool preserved (reapQueue skips pending work)...
      expect(fs.existsSync(spool)).toBe(true);
      // ...drain loop never ran (no per-session flush attempt on stdout or stderr)
      expect(logged.some((l) => l.startsWith("[flush]"))).toBe(false);
      expect(errLogged.some((l) => l.startsWith("[flush]"))).toBe(false);
      // ...and the reaper summary was still printed
      expect(logged.some((l) => /^\[gc\] reaped 1 stale session/.test(l))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });
});
