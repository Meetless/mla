// A workspaceId (and a runId) is not just a key: it is a PATH COMPONENT of every
// per-workspace state file under `<state root>/workspaces/<id>/`. Nothing validated it.
//
// The evidence that opened this: `~/.meetless/workspaces/` on the operator's own machine
// holds a directory literally named `'cmexample0000000000000001'`, quotes and all, sitting
// NEXT TO the legitimate `cmexample0000000000000001`. A shell-quoted id reached `join()`
// verbatim on 2026-07-15 and silently FORKED that workspace's state into a second
// directory, so everything written under one id was invisible to the other. Same family as
// the scan-cache slot stomp and the floor-projection ownership bug: a silent split brain
// that no reader could see.
//
// The sharper end of the same defect is containment. `path.join` normalizes `..`, so an id
// shaped like `../../x` does not land in a badly-named directory, it lands OUTSIDE the
// state root entirely. The id's provenance is a `.meetless.json` marker (activation.ts
// accepts any non-empty string), `MEETLESS_WORKSPACE_ID`, or `--workspace`; a runId can
// also arrive inside a parsed sidecar payload.
//
// These rows fix the boundary at the SINK, where every id becomes a path, rather than at
// the many sources: same posture as the scan-cache owner stamp (3ae06e39e) and the floor
// projection's foreign-root guard, both of which guard the write rather than the caller.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  assembleAuditPath,
  deliveryReceiptPath,
  projectionReceiptPath,
  resolveStateRoot,
  reviewCardsPath,
  scanCachePath,
  scanCachePathForRoot,
  scanCacheRootsDir,
  verdictsPath,
  writeScanCache,
} from "../../src/lib/scanner/cache";
import { runRecordPath, runsDir } from "../../src/lib/enrichment/plan";
import { onboardingLockPath } from "../../src/lib/enrichment/lock";
import { candidatesSidecarPath, statePath } from "../../src/lib/enrichment/ingest";
import { ScanResult } from "../../src/lib/scanner/types";

// The directory name found on disk, quotes included. The cuid itself is the synthetic
// `cmexample*` placeholder rather than the operator's actual workspace id: this package is
// the source of the PUBLIC mirror github.com/Meetless/mla, and scrub gate 2 in
// tools/export-mla-public.sh refuses to export a tree containing a real cuid. Nothing in
// this suite depends on the value, only on its SHAPE (quoted vs bare), so the substitution
// costs the tests nothing. Do not re-pin the real one.
const QUOTED_ID = "'cmexample0000000000000001'";
const REAL_ID = "cmexample0000000000000001";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mla-wsid-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

// True when `p` resolves inside `root` (or is `root`). Uses path arithmetic, not string
// prefixing, so `/a/b-sibling` is not read as being inside `/a/b`.
function isInside(root: string, p: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

describe("workspace id path safety: containment", () => {
  it("a traversal-shaped id must not resolve OUTSIDE the state root", () => {
    const stateRoot = resolveStateRoot(home);
    // ARRANGE: an id that `path.join` will normalize straight back out of the state root.
    const evil = "../../escaped";

    // ACT + ASSERT: every per-workspace path builder must refuse it. Before the fix each
    // one happily returned a path under `<home>/escaped`, two levels above the state root.
    expect(() => scanCachePath(evil, home)).toThrow(/workspace id/i);
    expect(() => scanCacheRootsDir(evil, home)).toThrow(/workspace id/i);
    expect(() => scanCachePathForRoot(evil, "/some/root", home)).toThrow(/workspace id/i);
    expect(() => verdictsPath(evil, home)).toThrow(/workspace id/i);
    expect(() => projectionReceiptPath(evil, home)).toThrow(/workspace id/i);
    expect(() => reviewCardsPath(evil, home)).toThrow(/workspace id/i);
    expect(() => assembleAuditPath(evil, home)).toThrow(/workspace id/i);
    expect(() => deliveryReceiptPath(evil, home)).toThrow(/workspace id/i);

    // And the containment property the throws exist to protect, stated directly.
    expect(isInside(stateRoot, path.join(stateRoot, "workspaces", evil))).toBe(false);
  });

  it("the WRITE side must not materialize state outside the state root", () => {
    const stateRoot = resolveStateRoot(home);
    const evil = "../../escaped";
    const result = { floorRulesXml: "", directives: [] } as unknown as ScanResult;

    // ACT: the write must fail loudly rather than plant a file above the state root.
    expect(() => writeScanCache(home, evil, result)).toThrow(/workspace id/i);

    // ASSERT: nothing was created outside. This is the row that makes the defect concrete:
    // before the fix `<home>/escaped/scan-cache.json` existed after this call.
    const escaped = path.join(home, "escaped");
    expect(fs.existsSync(escaped)).toBe(false);
    expect(isInside(stateRoot, escaped)).toBe(false);
  });

  it("an absolute-looking id must not nest state under a fabricated tree", () => {
    // `join` swallows the leading separator rather than escaping, so this one does not
    // leave the state root; it silently invents `<state root>/workspaces/etc/passwd`.
    // Still a lie about identity, so it is refused on the same terms.
    expect(() => scanCachePath("/etc/passwd", home)).toThrow(/workspace id/i);
    expect(() => scanCachePath("C:\\Windows", home)).toThrow(/workspace id/i);
  });

  it("the dot components are refused (they name a directory that is not a workspace)", () => {
    expect(() => scanCachePath(".", home)).toThrow(/workspace id/i);
    expect(() => scanCachePath("..", home)).toThrow(/workspace id/i);
    expect(() => scanCachePath("", home)).toThrow(/workspace id/i);
    expect(() => scanCachePath("   ", home)).toThrow(/workspace id/i);
  });

  it("a NUL byte is refused (it truncates the path at the syscall boundary)", () => {
    expect(() => scanCachePath("ws\u00001", home)).toThrow(/workspace id/i);
  });
});

describe("workspace id path safety: the 2026-07-15 quoted-id fork", () => {
  it("a shell-quoted id is refused instead of forking the workspace's state", () => {
    // ARRANGE + ACT + ASSERT: this is the id that is on disk today.
    expect(() => scanCachePath(QUOTED_ID, home)).toThrow(/workspace id/i);
    expect(() => verdictsPath(QUOTED_ID, home)).toThrow(/workspace id/i);
    expect(() => assembleAuditPath(QUOTED_ID, home)).toThrow(/workspace id/i);
  });

  it("names the offending value, so an operator can see WHICH id was rejected", () => {
    // A guard that says only "invalid" leaves the operator staring at a directory listing.
    // The observed failure was invisible for three weeks precisely because nothing said it.
    expect(() => scanCachePath(QUOTED_ID, home)).toThrow(new RegExp(REAL_ID));
  });
});

describe("workspace id path safety: enrichment state paths", () => {
  it("refuses a traversal-shaped workspace id at every onboarding path builder", () => {
    const evil = "../../escaped";
    expect(() => runsDir(home, evil)).toThrow(/workspace id/i);
    expect(() => runRecordPath(home, evil, "run_1")).toThrow(/workspace id/i);
    expect(() => onboardingLockPath(home, evil)).toThrow(/workspace id/i);
    expect(() => statePath(home, evil, "run_1")).toThrow(/workspace id/i);
    expect(() => candidatesSidecarPath(home, evil, "run_1")).toThrow(/workspace id/i);
  });

  it("refuses a traversal-shaped RUN id too: it is the very next path component", () => {
    // A runId lands in `<...>/onboarding-runs/<runId>.json`, and one arrives inside a
    // parsed sidecar payload (mergeCandidatesSidecar). Same defect, one field over.
    expect(() => runRecordPath(home, REAL_ID, "../../evil")).toThrow(/run id/i);
    expect(() => statePath(home, REAL_ID, "../../evil")).toThrow(/run id/i);
    expect(() => candidatesSidecarPath(home, REAL_ID, "../../evil")).toThrow(/run id/i);
  });
});

describe("workspace id path safety: legitimate ids are untouched", () => {
  // The guard is worthless if it breaks the 19 real workspace directories already on disk,
  // or the id shapes the suite uses. Each of these must resolve exactly as it did before.
  it.each([REAL_ID, "ws_1", "ws-abc", "proj_9", "a.b-c_d", "0"])(
    "%s still resolves under the state root, unchanged",
    (id) => {
      const stateRoot = resolveStateRoot(home);
      const p = scanCachePath(id, home);
      expect(p).toBe(path.join(stateRoot, "workspaces", id, "scan-cache.json"));
      expect(isInside(stateRoot, p)).toBe(true);
    },
  );

  it("a real id round-trips through the enrichment builders unchanged", () => {
    expect(runsDir(home, REAL_ID)).toBe(path.join(home, "workspaces", REAL_ID, "onboarding-runs"));
    expect(onboardingLockPath(home, REAL_ID)).toBe(
      path.join(home, "workspaces", REAL_ID, "onboarding-active.json"),
    );
    expect(statePath(home, REAL_ID, "run_1")).toBe(
      path.join(home, "workspaces", REAL_ID, "onboarding-runs", "run_1.state.json"),
    );
  });

  it("a real write still lands where it always did", () => {
    const result = { floorRulesXml: "", directives: [] } as unknown as ScanResult;
    writeScanCache(home, REAL_ID, result);
    expect(fs.existsSync(scanCachePath(REAL_ID, home))).toBe(true);
  });
});
