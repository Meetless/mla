import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  ACTIVE_CONFLICT_TTL_SECONDS,
  DEFAULT_CONFLICT_GATE_MODE,
  activeConflictCachePath,
  readActiveConflicts,
  resolveConflictGateMode,
  writeActiveConflictCache,
  type ActiveConflict,
} from "../../src/lib/active-conflict-cache";

// The zero-network hand-off between the turn-boundary sync (writes the complete
// open-conflict snapshot) and the PreToolUse hook (reads it for a SOFT warning).
// G8 / D1, notes/20260626-g8-cross-session-conflict-redesign.md §11.3 (CRITICAL-5).
// The load-bearing properties: a snapshot is overwritten whole every turn (never
// appended), a stale snapshot fails OPEN (no warning), and a malformed payload never
// throws. All assertions pass an explicit `home` tmpdir so the suite never touches the
// real $MEETLESS_HOME.

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "active-conflict-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function conflict(over: Partial<ActiveConflict> = {}): ActiveConflict {
  return {
    caseId: "case_1",
    openedAt: "2026-06-26T00:00:00.000Z",
    reason: "Another session is changing the same decision.",
    // coerceConflicts always emits this field on read (fail-closed default false),
    // so the canonical read shape carries it; the factory mirrors that shape so the
    // round-trip `toEqual` assertions below compare like against like (Task 8a).
    agentDismissEligible: false,
    ...over,
  };
}

describe("activeConflictCachePath", () => {
  it("places the snapshot beside the steer cache under logs/steer, keyed by session id verbatim", () => {
    expect(activeConflictCachePath("sess-OPAQUE_42", home)).toBe(
      path.join(home, "logs", "steer", "active-conflicts-sess-OPAQUE_42.json"),
    );
  });
});

describe("writeActiveConflictCache / readActiveConflicts round-trip", () => {
  it("reads back exactly the conflicts that were written (within the TTL)", () => {
    const conflicts = [conflict(), conflict({ caseId: "case_2", reason: "Second open conflict." })];
    writeActiveConflictCache("sess_1", conflicts, home, 1000);
    const read = readActiveConflicts("sess_1", { home, nowSeconds: 1005 });
    expect(read).toEqual(conflicts);
  });

  it("creates the logs/steer directory if it does not exist", () => {
    expect(fs.existsSync(path.join(home, "logs", "steer"))).toBe(false);
    writeActiveConflictCache("sess_1", [conflict()], home, 1000);
    expect(fs.existsSync(activeConflictCachePath("sess_1", home))).toBe(true);
  });

  it("overwrites the snapshot whole so a resolved conflict disappears on the next write", () => {
    writeActiveConflictCache("sess_1", [conflict(), conflict({ caseId: "case_2" })], home, 1000);
    // Next turn: only one conflict remains open. The snapshot is the COMPLETE current
    // set, not a delta, so the resolved one is simply gone.
    writeActiveConflictCache("sess_1", [conflict({ caseId: "case_2" })], home, 1010);
    const read = readActiveConflicts("sess_1", { home, nowSeconds: 1015 });
    expect(read).toEqual([conflict({ caseId: "case_2" })]);
  });

  it("returns an empty set when the writer recorded no open conflicts", () => {
    writeActiveConflictCache("sess_1", [], home, 1000);
    expect(readActiveConflicts("sess_1", { home, nowSeconds: 1005 })).toEqual([]);
  });
});

describe("agentDismissEligible: the read boundary is fail-closed", () => {
  // The writer passes the control projection through verbatim; coerceConflicts is the
  // single choke point that decides whether a dismiss steer is allowed (Task 8a). Only
  // an explicit boolean `true` survives; anything else normalizes to `false` so a stale
  // or corrupted snapshot can never invite a dismiss steer control did not bless.
  it("preserves an explicit true across the round-trip", () => {
    writeActiveConflictCache("sess_1", [conflict({ agentDismissEligible: true })], home, 1000);
    const read = readActiveConflicts("sess_1", { home, nowSeconds: 1005 });
    expect(read).toEqual([conflict({ agentDismissEligible: true })]);
  });

  it("normalizes a missing field to false (older snapshot, written before the field existed)", () => {
    const file = activeConflictCachePath("sess_1", home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        ts: 1000,
        conflicts: [{ caseId: "case_1", openedAt: "2026-06-26T00:00:00.000Z", reason: "r" }],
      }),
    );
    const read = readActiveConflicts("sess_1", { home, nowSeconds: 1005 });
    expect(read).toEqual([{ caseId: "case_1", openedAt: "2026-06-26T00:00:00.000Z", reason: "r", agentDismissEligible: false }]);
  });

  it("normalizes a non-boolean field to false (corrupted snapshot)", () => {
    const file = activeConflictCachePath("sess_1", home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        ts: 1000,
        conflicts: [
          { caseId: "case_1", openedAt: "2026-06-26T00:00:00.000Z", reason: "r", agentDismissEligible: "true" },
          { caseId: "case_2", openedAt: "2026-06-26T00:00:00.000Z", reason: "r", agentDismissEligible: 1 },
        ],
      }),
    );
    const read = readActiveConflicts("sess_1", { home, nowSeconds: 1005 });
    expect(read.every((c) => c.agentDismissEligible === false)).toBe(true);
  });
});

describe("readActiveConflicts: the fail-open staleness guard", () => {
  it("returns [] (no warning) once the snapshot ages past the TTL", () => {
    writeActiveConflictCache("sess_1", [conflict()], home, 1000);
    const justInside = readActiveConflicts("sess_1", {
      home,
      nowSeconds: 1000 + ACTIVE_CONFLICT_TTL_SECONDS,
    });
    expect(justInside).toEqual([conflict()]);
    const justPast = readActiveConflicts("sess_1", {
      home,
      nowSeconds: 1000 + ACTIVE_CONFLICT_TTL_SECONDS + 1,
    });
    expect(justPast).toEqual([]);
  });

  it("returns [] when the snapshot has no timestamp (cannot be trusted)", () => {
    const file = activeConflictCachePath("sess_1", home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ conflicts: [conflict()] }));
    expect(readActiveConflicts("sess_1", { home, nowSeconds: 1000 })).toEqual([]);
  });
});

describe("readActiveConflicts: never throws, fails open on any malformed input", () => {
  it("returns [] when the file is absent", () => {
    expect(readActiveConflicts("never-written", { home, nowSeconds: 1000 })).toEqual([]);
  });

  it("returns [] on non-JSON content", () => {
    const file = activeConflictCachePath("sess_1", home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json");
    expect(readActiveConflicts("sess_1", { home, nowSeconds: 1000 })).toEqual([]);
  });

  it("drops entries that are not well-formed conflicts (coercion)", () => {
    const file = activeConflictCachePath("sess_1", home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        ts: 1000,
        conflicts: [
          conflict(),
          { caseId: 42, openedAt: "x", reason: "wrong type for caseId" },
          { caseId: "case_3" },
          null,
          "nope",
        ],
      }),
    );
    expect(readActiveConflicts("sess_1", { home, nowSeconds: 1005 })).toEqual([conflict()]);
  });

  it("returns [] when conflicts is not an array", () => {
    const file = activeConflictCachePath("sess_1", home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ts: 1000, conflicts: { caseId: "case_1" } }));
    expect(readActiveConflicts("sess_1", { home, nowSeconds: 1005 })).toEqual([]);
  });
});

describe("resolveConflictGateMode: soft by default, hard only on explicit opt-in", () => {
  it("defaults to soft when the env flag is unset", () => {
    expect(resolveConflictGateMode({})).toBe("soft");
    expect(DEFAULT_CONFLICT_GATE_MODE).toBe("soft");
  });

  it("returns hard only for the exact opt-in value", () => {
    expect(resolveConflictGateMode({ MEETLESS_D1_CONFLICT_GATE: "hard" })).toBe("hard");
  });

  it("degrades any unrecognized value to soft (fail-safe)", () => {
    expect(resolveConflictGateMode({ MEETLESS_D1_CONFLICT_GATE: "HARD" })).toBe("soft");
    expect(resolveConflictGateMode({ MEETLESS_D1_CONFLICT_GATE: "block" })).toBe("soft");
    expect(resolveConflictGateMode({ MEETLESS_D1_CONFLICT_GATE: "" })).toBe("soft");
  });
});
