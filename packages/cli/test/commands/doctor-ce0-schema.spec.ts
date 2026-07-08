import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import Database from "better-sqlite3";

import {
  schemaVersionCheck,
  walModeCheck,
  foreignKeysCheck,
  busyTimeoutCheck,
  managedPreToolUseHookCheck,
  attestedPathRootCheck,
  denyEmissionAccountingCheck,
  failOpenEnforcementCheck,
  ce0IntegrityCheck,
  ce0QuickCheckResult,
} from "../../src/commands/doctor";
import { resolveAttestedPathRoot } from "../../src/lib/rules/deny-admission";
import {
  openCe0Store,
  closeCe0Store,
  type Ce0Store,
} from "../../src/lib/rules/ce0-store";
import { CE0_INTERCEPTION_SCHEMA_VERSION } from "../../src/lib/rules/interception-schema";
import {
  resolveInputAuthority,
  type HookConfigLayer,
} from "../../src/lib/rules/input-authority-resolver";

// Slice 9 (Phase B.9): the four `mla doctor` checks that gate the R1 notes-location deny pilot.
// notes/20260615-rules-as-node-and-action-interception-consolidated-proposal.md §10.1 step 1(d).
// Each check is a pure function of an already-read value so it is unit-pinned here exactly like
// sessionCaptureCheck, while the IO that reads the pragmas and the settings layers lives in
// runDoctor. The pure helpers are exercised against real values (a real CE0 store, a real
// resolveInputAuthority result) so the contract is proven without mocking any internal service.

describe("schemaVersionCheck (CE0 interception schema version stamp)", () => {
  test("passes when the stamped version matches what this binary expects", () => {
    const c = schemaVersionCheck(CE0_INTERCEPTION_SCHEMA_VERSION, CE0_INTERCEPTION_SCHEMA_VERSION);
    expect(c.ok).toBe(true);
  });

  test("fails when the stamped version differs from what this binary expects", () => {
    const c = schemaVersionCheck(0, CE0_INTERCEPTION_SCHEMA_VERSION);
    expect(c.ok).toBe(false);
    expect(c.detail).toContain(String(CE0_INTERCEPTION_SCHEMA_VERSION));
  });
});

describe("walModeCheck (PreToolUse reads must never block on a writer)", () => {
  test("passes for WAL journal mode regardless of case", () => {
    expect(walModeCheck("wal").ok).toBe(true);
    expect(walModeCheck("WAL").ok).toBe(true);
  });

  test("fails for any non-WAL journal mode", () => {
    const c = walModeCheck("delete");
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("delete");
  });
});

describe("foreignKeysCheck (evaluation rows must never orphan their attempt or version)", () => {
  test("passes when foreign keys are enforced", () => {
    expect(foreignKeysCheck(1).ok).toBe(true);
  });

  test("fails when foreign keys are off", () => {
    expect(foreignKeysCheck(0).ok).toBe(false);
  });
});

// P0.15 locks a SQLite busy_timeout of <= 50 ms so a lock-contended read fails fast as a degraded
// event instead of stalling the hook's wall-clock guard before it fails open. doctor already verifies
// the other two hot-path pragmas openCe0Store hardcodes (WAL, foreign_keys); this guards the third
// against drift. NOTE: the detail must NOT quote a "500ms" hard timeout: that proposal number is NOT
// the implemented guard (the managed pre-tool-use.sh wrapper uses a 5 s `timeout`, see 3.8 of the
// dogfood report), and asserting an unimplemented figure as fact is exactly the overclaim we strip.
describe("busyTimeoutCheck (P0.15, busy_timeout stays inside the hook budget)", () => {
  test("passes when busy_timeout is the locked 50 ms", () => {
    expect(busyTimeoutCheck(50).ok).toBe(true);
  });

  test("passes for any value at or under the 50 ms ceiling", () => {
    expect(busyTimeoutCheck(25).ok).toBe(true);
    expect(busyTimeoutCheck(0).ok).toBe(true);
  });

  test("fails when busy_timeout exceeds 50 ms (a contended read could stall the hook before it fails open)", () => {
    const c = busyTimeoutCheck(5000);
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("5000");
    // The consequence is named truthfully...
    expect(c.detail).toContain("fails open");
    // ...without fabricating an unimplemented "500ms" deadline.
    expect(c.detail).not.toContain("500ms");
  });
});

describe("managedPreToolUseHookCheck (P0.58, MLA is the sole effective Write/Edit authority)", () => {
  let dir: string;
  let mlaHooksDir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ce0-doctor-hook-"));
    mlaHooksDir = path.join(dir, "hooks");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("passes when the only Write/Edit PreToolUse hook is the managed MLA hook", () => {
    const mlaCommand = path.join(mlaHooksDir, "pre-tool-use.sh");
    const userLayer: HookConfigLayer = {
      name: "user",
      settings: {
        hooks: {
          PreToolUse: [
            { matcher: "Write|Edit", hooks: [{ type: "command", command: mlaCommand }] },
          ],
        },
      },
    };
    const resolution = resolveInputAuthority([userLayer], { mlaHooksDir });
    const c = managedPreToolUseHookCheck(resolution);
    expect(c.ok).toBe(true);
  });

  test("fails when a foreign Write/Edit PreToolUse mutator is also present", () => {
    const foreignLayer: HookConfigLayer = {
      name: "user",
      settings: {
        hooks: {
          PreToolUse: [
            { matcher: "", hooks: [{ type: "command", command: "/usr/local/bin/other.sh" }] },
          ],
        },
      },
    };
    const resolution = resolveInputAuthority([foreignLayer], { mlaHooksDir });
    const c = managedPreToolUseHookCheck(resolution);
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("FOREIGN_MUTATOR_PRESENT");
  });

  test("fails when no MLA PreToolUse hook governs Write or Edit", () => {
    const emptyLayer: HookConfigLayer = { name: "user", settings: {} };
    const resolution = resolveInputAuthority([emptyLayer], { mlaHooksDir });
    const c = managedPreToolUseHookCheck(resolution);
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("MLA_HOOK_ABSENT");
  });
});

// P0.63: a deny is admissible only when the attested forbidden root resolves against the active
// runtime root. doctor mirrors the seam's resolveAttestedPathRoot so an operator can see, before any
// tool call, whether a LIVE rule's path-root gate will admit a deny or silently fail open.
describe("attestedPathRootCheck (P0.63, the attested forbidden root resolves)", () => {
  test("passes when the path root is admitted, naming the resolved root", () => {
    const c = attestedPathRootCheck(
      resolveAttestedPathRoot({ configuredRelativeForbiddenPath: "notes", activeRuntimeProjectRoot: "/work/repo" }),
    );
    expect(c.ok).toBe(true);
    expect(c.detail).toContain(path.join("/work/repo", "notes"));
  });

  test("fails when the active runtime root will not resolve", () => {
    const c = attestedPathRootCheck(
      resolveAttestedPathRoot({ configuredRelativeForbiddenPath: "notes", activeRuntimeProjectRoot: "" }),
    );
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("ACTIVE_RUNTIME_ROOT_UNRESOLVED");
  });

  test("fails when the attested forbidden root content is missing", () => {
    const c = attestedPathRootCheck(
      resolveAttestedPathRoot({ configuredRelativeForbiddenPath: "", activeRuntimeProjectRoot: "/work/repo" }),
    );
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("ATTESTED_ROOT_CONTENT_MISSING");
  });
});

// P0.60: surfacing denies recorded but not yet emitted. A stuck DECISION_RECORDED row is an honest,
// recoverable crash-window leftover, NEVER corruption, so this check is informational and never RED;
// it only tells the operator the count.
describe("denyEmissionAccountingCheck (P0.60, deny decisions are honestly accounted)", () => {
  test("reports clean (info, non-failing) when nothing is awaiting emission", () => {
    const c = denyEmissionAccountingCheck(0);
    expect(c.ok).toBe(true);
    expect(c.level).toBe("info");
  });

  test("surfaces stuck deny decisions without going RED (honest, recoverable)", () => {
    const c = denyEmissionAccountingCheck(2);
    expect(c.ok).toBe(true);
    expect(c.level).toBe("info");
    expect(c.label).toContain("2");
  });
});

// Historical fail-open visibility. deny-admission.ts promises that when a DENY-ceiling violation cannot
// be denied (RULE_ENFORCEMENT_UNAVAILABLE, decision 5) "the action passes, an alert fires, and mla doctor
// fails". A fail-open is NOT recoverable: the prohibited action already passed un-governed. But the
// rule_evaluation_record ledger is append-only and an install-time transient fail-open must not pin doctor
// RED forever, so this is surfaced as info (the loud alert is the count itself), never a permanent RED.
describe("failOpenEnforcementCheck (historical fail-open visibility)", () => {
  test("reports clean (info, non-failing) when enforcement has never failed open", () => {
    const c = failOpenEnforcementCheck(0);
    expect(c.ok).toBe(true);
    expect(c.level).toBe("info");
    expect(c.label.toLowerCase()).toContain("never");
  });

  test("surfaces past fail-open violations as info, with the count", () => {
    const c = failOpenEnforcementCheck(3);
    expect(c.ok).toBe(true);
    expect(c.level).toBe("info");
    expect(c.label).toContain("3");
  });
});

// P0.15: a PreToolUse hook fails OPEN on an invalid or unreadable local SQLite authority, which
// silently takes enforcement DOWN. The proposal requires that degraded store be "surfaced through
// mla doctor as a failure". doctor's other reads only catch corruption incidentally (if a query
// happens to touch a damaged page); ce0IntegrityCheck runs a deliberate full-database quick_check so
// a corrupt authority is reported authoritatively. Unlike the append-only accounting checks this is a
// LIVE infrastructure failure (enforcement is down now), so it is RED, never info.
describe("ce0IntegrityCheck (P0.15, the local SQLite authority is structurally sound)", () => {
  test("passes (green, not info) when quick_check reports ok, case- and whitespace-tolerant", () => {
    expect(ce0IntegrityCheck("ok").ok).toBe(true);
    const c = ce0IntegrityCheck("OK\n");
    expect(c.ok).toBe(true);
    expect(c.level).not.toBe("info");
  });

  test("fails RED (never info) when quick_check throws a malformed-image error", () => {
    const c = ce0IntegrityCheck("database disk image is malformed");
    expect(c.ok).toBe(false);
    expect(c.level).not.toBe("info");
    expect((c.detail ?? "").toLowerCase()).toContain("malformed");
  });

  test("fails RED when quick_check reports structural errors as rows", () => {
    const c = ce0IntegrityCheck("row 12 missing from index idx_eval; *** in database main ***");
    expect(c.ok).toBe(false);
    expect(c.level).not.toBe("info");
    expect((c.detail ?? "").toLowerCase()).toContain("index");
  });
});

describe("ce0QuickCheckResult against a real database (no mocks)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ce0-quickcheck-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("returns 'ok' for a sound, freshly opened CE0 store, so ce0IntegrityCheck passes", () => {
    const store = openCe0Store(path.join(dir, "evidence.db"));
    const result = ce0QuickCheckResult(store);
    closeCe0Store(store);
    expect(result.trim().toLowerCase()).toBe("ok");
    expect(ce0IntegrityCheck(result).ok).toBe(true);
  });

  test("flags a genuinely corrupt store as RED (the deliberate scan catches what incidental reads miss)", () => {
    const dbPath = path.join(dir, "evidence.db");
    const store = openCe0Store(dbPath);
    const pageSize = store.db.pragma("page_size", { simple: true }) as number;
    // Fold the WAL into the main file so the corruption lands on durable pages.
    store.db.pragma("wal_checkpoint(TRUNCATE)");
    closeCe0Store(store);

    // Zero every page after the header/schema page (page 1): the file still opens because the header
    // and sqlite_master survive, but the table b-trees are unreadable, which is exactly the regime
    // openCe0Store can survive while the store is in fact corrupt.
    const size = fs.statSync(dbPath).size;
    const corruptFrom = pageSize; // start of page 2
    const fd = fs.openSync(dbPath, "r+");
    const zeros = Buffer.alloc(Math.max(0, size - corruptFrom), 0);
    if (zeros.length > 0) fs.writeSync(fd, zeros, 0, zeros.length, corruptFrom);
    fs.closeSync(fd);

    const raw = new Database(dbPath);
    const result = ce0QuickCheckResult({ db: raw } as unknown as Ce0Store);
    raw.close();

    expect(result.trim().toLowerCase()).not.toBe("ok");
    const c = ce0IntegrityCheck(result);
    expect(c.ok).toBe(false);
    expect(c.level).not.toBe("info");
  });
});

describe("CE0 store posture against a real database (no mocks)", () => {
  let dir: string;
  let store: Ce0Store;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ce0-doctor-posture-"));
    store = openCe0Store(path.join(dir, "evidence.db"));
  });

  afterEach(() => {
    closeCe0Store(store);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a freshly opened CE0 store passes all three posture checks", () => {
    const version = store.db.pragma("user_version", { simple: true }) as number;
    const journalMode = store.db.pragma("journal_mode", { simple: true }) as string;
    const foreignKeys = store.db.pragma("foreign_keys", { simple: true }) as number;

    expect(schemaVersionCheck(version, CE0_INTERCEPTION_SCHEMA_VERSION).ok).toBe(true);
    expect(walModeCheck(journalMode).ok).toBe(true);
    expect(foreignKeysCheck(foreignKeys).ok).toBe(true);
  });
});
