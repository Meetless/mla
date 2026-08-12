// MLA issue-list item 6: nothing detects a floor projection that has gone stale.
//
// MEASURED 2026-08-09, one workspace, three scan roots (paths genericized: this file is
// exported to the public mirror, and the operator's real roots are a scrub-gate violation):
//
//   ~/projects/acme/.claude/rules/          rev-126  4ac8de88  10 rules  written today
//   ~/projects/acme/backend/.claude/rules/  rev-126  4ac8de88  10 rules  written today
//   ~/projects/acme/intel/.claude/rules/    rev-67   5d25b8a3   7 rules  Jul 13
//
// The live bundle for this principal is rev-126 with 17 rules. The first two healed; intel did
// not, and has been four weeks stale. Every agent that opened `intel/` in that window loaded a
// 7-rule governing floor as project instructions while the governed floor said something else.
// Nothing reported it, because `mla doctor` has no projection check at all: it verifies the CACHE
// and the RECEIPT, never the file that actually reaches the model.
//
// WHY HASH AND NOT REVISION. The obvious check, "compare the header's bundleId to the live
// revision", is wrong twice over and the issue list says so. `bundleRevision` is scoped per
// (workspaceId, principalUserId), so two principals on one workspace produce two unrelated
// counters and every principal boundary reads as drift. And the writer skips the rewrite when the
// BODY is unchanged (`{projection: "unchanged", reason: "same_hash"}`), so the header's revision
// only refreshes when the content does: a projection can be byte-perfect and ten revisions
// "behind". The revision stamp is not provenance. The payload hash is.
//
// This module is the pure, read-only half: given the floor directives, what is the state of the
// file on disk. It never writes, because a governing instruction file changing under a running
// agent is worse than drift.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  FLOOR_PROJECTION_RELPATH,
  renderFloorProjection,
  renderProjectionBody,
} from "../../../src/lib/scanner/floor-projection";
import { inspectFloorProjection } from "../../../src/lib/scanner/floor-projection-writer";
import { Directive } from "../../../src/lib/scanner/types";

// A rule-bundle human-attested MUST: the ONLY shape isFloorRule accepts. Copied verbatim from
// floor-projection.spec.ts rather than re-derived, because guessing it produced an empty body and
// every assertion collapsed to "no_floor_rules".
const floor = (over: Partial<Directive> = {}): Directive => ({
  id: "abc",
  text: "Work directly on main.",
  source: "rule-bundle",
  kind: "RULE",
  strength: "MUST_FOLLOW",
  attestation: "human_attested",
  ...over,
});

const mkRoot = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "mla-drift-"));

const writeProjection = (root: string, dirs: Directive[], bundleId: string): void => {
  const target = path.join(root, FLOOR_PROJECTION_RELPATH);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, renderFloorProjection(dirs, bundleId, root));
};

describe("floor projection drift is detectable without rewriting anything", () => {
  it("reports MATCH when the file carries the same floor the bundle does", () => {
    const root = mkRoot();
    const dirs = [floor()];
    writeProjection(root, dirs, "rev-126");

    const got = inspectFloorProjection(root, dirs);
    expect(got.status).toBe("match");
    expect(got.declaredHash).toBe(got.intendedHash);
  });

  it("reports DRIFT when the file carries an older floor, which is the intel case", () => {
    // Exactly the shape measured above: the file was written from a smaller, older floor and the
    // bundle has moved on. No rewrite happened, so it sat there for four weeks.
    const root = mkRoot();
    writeProjection(root, [floor({ id: "old", text: "Work directly on main." })], "rev-67");

    const live = [
      floor({ id: "old", text: "Work directly on main." }),
      floor({ id: "new", text: "Commit frequently." }),
    ];
    const got = inspectFloorProjection(root, live);

    expect(got.status).toBe("drift");
    expect(got.declaredHash).not.toBe(got.intendedHash);
    // The operator has to be able to name the file, not just be told something is wrong.
    expect(got.path).toContain(FLOOR_PROJECTION_RELPATH);
  });

  it("a REVISION difference alone is NOT drift when the body matches", () => {
    // The false positive the issue list warns about. The writer refreshes the header only when the
    // body changes, so a stale-looking `bundleId` on identical content is normal and must stay
    // quiet. A check that flags this would cry wolf on every unchanged projection.
    const root = mkRoot();
    const dirs = [floor()];
    writeProjection(root, dirs, "rev-1");

    const got = inspectFloorProjection(root, dirs);
    expect(got.status).toBe("match");
    expect(got.declaredBundleId).toBe("rev-1");
  });

  it("reports ABSENT rather than drift when no projection was ever written", () => {
    // A root that never ran `mla scan` is not drifted, it is unstarted. Conflating the two would
    // send an operator hunting for a corruption that does not exist.
    expect(inspectFloorProjection(mkRoot(), [floor()]).status).toBe("absent");
  });

  it("reports FOREIGN for a file MLA does not own, and never claims it", () => {
    const root = mkRoot();
    const target = path.join(root, FLOOR_PROJECTION_RELPATH);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "# hand written rules\n\n- do the thing\n");

    expect(inspectFloorProjection(root, [floor()]).status).toBe("foreign");
  });

  it("reports EDITED when the body was changed under MLA's own marker", () => {
    // Ownership is the declared hash matching the body. A hand edit breaks that, and the writer
    // already refuses to overwrite it. The inspector must name it as edited rather than drift, so
    // nobody 'fixes' it by rescanning and silently discards someone's edit.
    const root = mkRoot();
    const dirs = [floor()];
    writeProjection(root, dirs, "rev-126");
    const target = path.join(root, FLOOR_PROJECTION_RELPATH);
    fs.writeFileSync(target, fs.readFileSync(target, "utf8") + "\n- a rule someone added by hand\n");

    expect(inspectFloorProjection(root, dirs).status).toBe("edited");
  });

  it("is read-only: inspecting a drifted projection leaves the bytes alone", () => {
    // The load-bearing property. Doctor runs this, and doctor must never mutate a governing
    // instruction file while an agent is mid-session reading it.
    const root = mkRoot();
    writeProjection(root, [floor()], "rev-67");
    const target = path.join(root, FLOOR_PROJECTION_RELPATH);
    const before = fs.readFileSync(target, "utf8");

    inspectFloorProjection(root, [floor(), floor({ id: "new", text: "Commit frequently." })]);

    expect(fs.readFileSync(target, "utf8")).toBe(before);
  });

  it("treats an empty floor as NOT_APPLICABLE, never as drift", () => {
    // `renderProjectionBody([])` is empty, and the writer's own contract is that a transient empty
    // read must not revoke the last-known floor. The inspector has to agree, or doctor would
    // report every bundle-unavailable moment as corruption.
    const root = mkRoot();
    writeProjection(root, [floor()], "rev-126");
    expect(renderProjectionBody([])).toBeFalsy();
    expect(inspectFloorProjection(root, []).status).toBe("no_floor_rules");
  });
});
