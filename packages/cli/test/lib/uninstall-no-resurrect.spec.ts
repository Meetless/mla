import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isTeardownCommand, homeWasTornDown } from "../../src/cli";

// BUG-1 D: `mla uninstall` deletes ~/.meetless as its whole purpose, but the
// post-command telemetry that runs after dispatch (the local mla_command jsonl
// append, and the trace-flush deadletter) both route through ensureHome(), which
// mkdir's ~/.meetless straight back into existence. So a "clean" uninstall left a
// resurrected ~/.meetless/events.jsonl behind and the user's rm-everything intent
// silently failed. The guard is homeWasTornDown(): once a teardown command has
// actually removed HOME, every disk-writing teardown bows out.

describe("isTeardownCommand", () => {
  it("is true only for uninstall", () => {
    expect(isTeardownCommand("uninstall")).toBe(true);
  });

  it("is false for unwire (it keeps HOME, only strips settings.json hooks)", () => {
    expect(isTeardownCommand("unwire")).toBe(false);
  });

  it("is false for ordinary commands and the no-command case", () => {
    for (const c of ["review", "doctor", "init", "flush", "(none)", ""]) {
      expect(isTeardownCommand(c)).toBe(false);
    }
  });
});

describe("homeWasTornDown", () => {
  it("uninstall that actually removed HOME -> true (skip teardown)", () => {
    expect(homeWasTornDown("uninstall", () => false)).toBe(true);
  });

  it("uninstall that left HOME in place (dry-run / cancelled) -> false (telemetry runs)", () => {
    expect(homeWasTornDown("uninstall", () => true)).toBe(false);
  });

  it("a non-teardown command never tears down, even if HOME happens to be absent", () => {
    // A fresh box running `mla --version` before init has no HOME; that must NOT
    // be mistaken for a teardown (its capture legitimately creates HOME today).
    expect(homeWasTornDown("review", () => false)).toBe(false);
    expect(homeWasTornDown("(none)", () => false)).toBe(false);
  });

  it("the homeExists probe is lazy: it is never invoked for a non-teardown command", () => {
    const probe = jest.fn(() => false);
    expect(homeWasTornDown("doctor", probe)).toBe(false);
    // The existsSync must stay off the hot path of every normal command.
    expect(probe).not.toHaveBeenCalled();
  });

  it("the homeExists probe IS invoked for uninstall (the one command that needs it)", () => {
    const probe = jest.fn(() => true);
    expect(homeWasTornDown("uninstall", probe)).toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

// Integration: prove the guard is load-bearing against the REAL store writer.
// We point HOME at a temp dir via MEETLESS_HOME, simulate an uninstall by deleting
// it, then show that (a) the unguarded append recreates it -- the bug -- and
// (b) gating that same append on homeWasTornDown() leaves it gone -- the fix.
describe("uninstall teardown does not resurrect HOME (real store writer)", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.MEETLESS_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "mla-bug1d-"));
    process.env.MEETLESS_HOME = home;
    // The HOME const in config.ts is frozen at import from MEETLESS_HOME, so drop
    // the module cache and re-require the store against the temp home.
    jest.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.MEETLESS_HOME;
    else process.env.MEETLESS_HOME = prevHome;
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  });

  function loadStore(): typeof import("../../src/lib/analytics/store") {
    return require("../../src/lib/analytics/store");
  }

  const sampleEvent = {
    event_id: "evt_bug1d",
    event_type: "mla_command",
    ts: "2026-07-09T00:00:00.000Z",
    payload: {},
  } as unknown as Parameters<
    typeof import("../../src/lib/analytics/store").appendEvent
  >[0];

  it("baseline: the store append DOES recreate a removed HOME (the bug it guards)", () => {
    const store = loadStore();
    // Live install: HOME exists with a captured event.
    fs.writeFileSync(store.eventsPath(), "{}\n", "utf8");
    expect(fs.existsSync(home)).toBe(true);

    // Uninstall removed the whole footprint.
    fs.rmSync(home, { recursive: true, force: true });
    expect(fs.existsSync(home)).toBe(false);

    // Unguarded post-command capture: this is exactly what runCliBootstrap used
    // to do, and it mkdir's HOME back to life.
    store.appendEvent(sampleEvent);
    expect(fs.existsSync(home)).toBe(true);
    expect(fs.existsSync(store.eventsPath())).toBe(true);
  });

  it("fix: gating the append on homeWasTornDown() leaves HOME gone", () => {
    const store = loadStore();
    fs.writeFileSync(store.eventsPath(), "{}\n", "utf8");
    fs.rmSync(home, { recursive: true, force: true });
    expect(fs.existsSync(home)).toBe(false);

    // The runCliBootstrap guard: skip every disk-writing teardown once HOME is
    // gone after a teardown command.
    const homeRemoved = homeWasTornDown("uninstall", () => fs.existsSync(home));
    expect(homeRemoved).toBe(true);
    if (!homeRemoved) store.appendEvent(sampleEvent);

    // Nothing recreated the directory.
    expect(fs.existsSync(home)).toBe(false);
  });
});
