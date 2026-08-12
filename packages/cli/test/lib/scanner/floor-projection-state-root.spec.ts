// test/lib/scanner/floor-projection-state-root.spec.ts
//
// THE SANDBOX ESCAPE. On 2026-08-02T19:44:24Z the flagship checkout's governing floor
// projection was replaced by a ONE-rule test fixture ("include a Mermaid diagram in design
// docs", bundleId rev-5) and stayed that way. Every write-capable subagent dispatched in
// that repo inherited 1 floor rule instead of 6 for the next day.
//
// Mechanism, measured rather than inferred:
//   - `MEETLESS_HOME` sandboxes every piece of MLA state (bundle cache, scan cache,
//     receipts) because they all resolve through resolveMeetlessHome().
//   - The projection does NOT. Its target is `resolveScanRoot(process.cwd())`, i.e. the
//     nearest .meetless.json marker dir. A run with a sandboxed home and a cwd inside a
//     REAL checkout writes that real checkout's .claude/rules/.
//   - internal-steer-sync.spec.ts is exactly that shape: MEETLESS_HOME -> tmpdir, and
//     runInternalSteerSync -> rescanAndCache({ cwd: resolveScanRoot(process.cwd()) }),
//     where cwd under jest is packages/cli, inside the real repo.
//
// The reason nothing self-healed: the resulting file is a WELL-FORMED, MLA-OWNED
// projection. Its declared payloadHash matches its body, so `foreign_file` and `edited`
// both pass, and every later writer accepted it. The header recorded `bundleId` and
// `payloadHash` and nothing about WHO wrote it, so no reader could tell a projection
// written by this machine's state from one written by a throwaway sandbox.
//
// The fix is the same shape as 3ae06e39e one layer down (the scan cache's owner stamp):
// give the projection an OWNER (its state root), refuse to overwrite one owned by a
// DIFFERENT state root that still exists, and transfer ownership when that root is gone.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  materializeFloorProjection,
} from "../../../src/lib/scanner/floor-projection-writer";
import {
  FLOOR_PROJECTION_RELPATH,
  declaredStateRoot,
  renderFloorProjection,
  splitProjection,
} from "../../../src/lib/scanner/floor-projection";
import { Directive, FloorMeta } from "../../../src/lib/scanner/types";
import { resolveProjectionOutcome } from "../../../src/commands/scan-context";

const floor = (over: Partial<Directive> = {}): Directive => ({
  id: "abc",
  text: "Work directly on main.",
  source: "rule-bundle",
  kind: "RULE",
  strength: "MUST_FOLLOW",
  attestation: "human_attested",
  ...over,
});

// The real floor: six rules. The shape the flagship checkout is supposed to carry.
const REAL_FLOOR = [
  floor({ text: "Work directly on main; never create feature branches." }),
  floor({ text: "We are a startup: never over-engineer." }),
  floor({ text: "Rebuild, rewire and exercise the change live before calling it done." }),
  floor({ text: "Save date-prefixed working notes in the sibling notes vault." }),
  floor({ text: "Include a Mermaid sequence diagram for every flow." }),
  floor({ text: "Prefer 127.0.0.1 over localhost for local services on macOS." }),
];

// The one-rule test fixture that actually landed on disk on 2026-08-02.
const TEST_FIXTURE_FLOOR = [floor({ text: "include a Mermaid diagram in design docs" })];

function targetPath(root: string): string {
  return join(root, FLOOR_PROJECTION_RELPATH);
}

describe("floor projection: cross-state-root ownership", () => {
  let tmp: string;
  let checkout: string;
  let realHome: string;
  let sandboxHome: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mla-proj-owner-"));
    checkout = join(tmp, "checkout");
    realHome = join(tmp, "home", ".meetless");
    sandboxHome = join(tmp, "sandbox", ".meetless");
    mkdirSync(checkout, { recursive: true });
    mkdirSync(realHome, { recursive: true });
    mkdirSync(sandboxHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  // THE INCIDENT, reduced to one assertion.
  it("a sandboxed state root does NOT replace a projection owned by this machine's state", () => {
    const first = materializeFloorProjection(checkout, REAL_FLOOR, "rev-106", realHome);
    expect(first.projection).toBe("written");
    const before = readFileSync(targetPath(checkout), "utf8");

    const clobber = materializeFloorProjection(checkout, TEST_FIXTURE_FLOOR, "rev-5", sandboxHome);

    expect(clobber.projection).toBe("blocked");
    expect(clobber.reason).toBe("foreign_state_root");
    expect(readFileSync(targetPath(checkout), "utf8")).toBe(before);
    // The six governing rules are still there, which is the whole point.
    expect(readFileSync(targetPath(checkout), "utf8")).toContain("never create feature branches");
  });

  it("stamps the writing state root into the ownership header", () => {
    materializeFloorProjection(checkout, REAL_FLOOR, "rev-106", realHome);
    const parts = splitProjection(readFileSync(targetPath(checkout), "utf8"))!;
    expect(declaredStateRoot(parts.header)).toBe(realHome);
  });

  it("the owner stamp lives in the HEADER, so it never perturbs the body hash", () => {
    const a = renderFloorProjection(REAL_FLOOR, "rev-1", realHome);
    const b = renderFloorProjection(REAL_FLOOR, "rev-1", sandboxHome);
    expect(splitProjection(a)!.body).toBe(splitProjection(b)!.body);
  });

  it("the SAME state root rewrites its own projection normally", () => {
    materializeFloorProjection(checkout, REAL_FLOOR, "rev-106", realHome);
    const r = materializeFloorProjection(checkout, TEST_FIXTURE_FLOOR, "rev-107", realHome);
    expect(r.projection).toBe("written");
    expect(readFileSync(targetPath(checkout), "utf8")).toContain("include a Mermaid diagram");
  });

  // Self-heal. The 2026-08-02 sandbox home was deleted by the test's own afterEach, so
  // without this the checkout would be frozen on the fixture forever: the incumbent would
  // be owned by a root that can never run again. Ownership must follow the live root.
  it("ownership TRANSFERS once the stamping state root no longer exists on disk", () => {
    materializeFloorProjection(checkout, TEST_FIXTURE_FLOOR, "rev-5", sandboxHome);
    rmSync(join(tmp, "sandbox"), { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });

    const r = materializeFloorProjection(checkout, REAL_FLOOR, "rev-106", realHome);

    expect(r.projection).toBe("written");
    const parts = splitProjection(readFileSync(targetPath(checkout), "utf8"))!;
    expect(declaredStateRoot(parts.header)).toBe(realHome);
    expect(parts.body).toContain("never create feature branches");
  });

  // Upgrade path: every projection written before this change carries no stateRoot line.
  // A single-repo install must not freeze on it (that would be a self-inflicted outage
  // strictly worse than the bug).
  it("a LEGACY unstamped projection stays writable and gets adopted", () => {
    mkdirSync(join(checkout, ".claude", "rules"), { recursive: true });
    // Render without an owner: byte-for-byte what the pre-fix code produced.
    writeFileSync(targetPath(checkout), renderFloorProjection(TEST_FIXTURE_FLOOR, "rev-5"), "utf8");

    const r = materializeFloorProjection(checkout, REAL_FLOOR, "rev-106", realHome);

    expect(r.projection).toBe("written");
    expect(declaredStateRoot(splitProjection(readFileSync(targetPath(checkout), "utf8"))!.header)).toBe(
      realHome,
    );
  });

  it("an identical floor body from a foreign root is still unchanged, not blocked (no write, no harm)", () => {
    materializeFloorProjection(checkout, REAL_FLOOR, "rev-106", realHome);
    const r = materializeFloorProjection(checkout, REAL_FLOOR, "rev-5", sandboxHome);
    expect(r.projection).toBe("unchanged");
    expect(r.reason).toBe("same_hash");
  });

  it("a foreign root still writes when nothing is there (a fresh checkout is not owned)", () => {
    const r = materializeFloorProjection(checkout, TEST_FIXTURE_FLOOR, "rev-5", sandboxHome);
    expect(r.projection).toBe("written");
    expect(existsSync(targetPath(checkout))).toBe(true);
  });
});

// The wiring half. The guard above is inert unless the production chain actually passes
// the state root that MEETLESS_HOME resolves to; scan-context.ts is the only caller.
describe("floor projection: MEETLESS_HOME reaches the projection writer", () => {
  let tmp: string;
  let checkout: string;
  let realHome: string;
  let prevHome: string | undefined;

  const meta: FloorMeta = { bundleId: "rev-5", bundleHash: null, freshness: "fresh" };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mla-proj-env-"));
    checkout = join(tmp, "checkout");
    realHome = join(tmp, "home", ".meetless");
    mkdirSync(checkout, { recursive: true });
    mkdirSync(realHome, { recursive: true });
    prevHome = process.env.MEETLESS_HOME;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.MEETLESS_HOME;
    else process.env.MEETLESS_HOME = prevHome;
    rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  it("a scan under a sandboxed MEETLESS_HOME cannot rewrite another home's projection", () => {
    materializeFloorProjection(checkout, REAL_FLOOR, "rev-106", realHome);
    const before = readFileSync(targetPath(checkout), "utf8");

    // MEETLESS_HOME IS the .meetless dir (config.HOME convention), not the OS home.
    const sandboxHome = join(tmp, "sandbox", ".meetless");
    mkdirSync(sandboxHome, { recursive: true });
    process.env.MEETLESS_HOME = sandboxHome;
    const out = resolveProjectionOutcome(checkout, TEST_FIXTURE_FLOOR, meta);

    expect(out.projection).toBe("blocked");
    expect(out.reason).toBe("foreign_state_root");
    expect(readFileSync(targetPath(checkout), "utf8")).toBe(before);
  });

  it("a scan under the OWNING MEETLESS_HOME rewrites normally", () => {
    materializeFloorProjection(checkout, TEST_FIXTURE_FLOOR, "rev-5", realHome);

    process.env.MEETLESS_HOME = realHome;
    const out = resolveProjectionOutcome(checkout, REAL_FLOOR, meta);

    expect(out.projection).toBe("written");
    expect(readFileSync(targetPath(checkout), "utf8")).toContain("never create feature branches");
  });
});
