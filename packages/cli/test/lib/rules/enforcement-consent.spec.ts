import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  CONSENT_TTL_MS,
  actionKey,
  grantConsent,
  redeemConsent,
  type ConsentGrant,
} from "../../../src/lib/rules/enforcement-consent";

// INV-8 Phase B: the immediate, action-scoped override a hard DENY is required to have.
//
// The host's permission prompt cannot serve here. It is a good one-shot mechanism (one-time per
// call, no persistence across calls or sessions, hook does not re-run) but it REPLACES a block
// rather than overriding one, and turning DENY into ASK would be the enforcement-ceiling change this
// workstream must not make. So the grant lives on our side, and these specs pin that it stays
// narrow: every one of them is an attempt to make a grant leak somewhere it should not reach.

const RULE_V1 = "ver_1";
const SESSION = "s-1";
const ACTION = actionKey("Write", "notes/x.md");

function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mla-consent-"));
}

function grant(home: string, over: Partial<ConsentGrant> = {}, nowMs = 1_000_000): boolean {
  return grantConsent(home, {
    incidentId: "inc_1",
    ruleVersionId: RULE_V1,
    actionKey: ACTION,
    sessionId: SESSION,
    grantedAtMs: nowMs,
    ...over,
  });
}

function redeem(home: string, over: Partial<Parameters<typeof redeemConsent>[1]> = {}) {
  return redeemConsent(home, {
    ruleVersionId: RULE_V1,
    actionKey: ACTION,
    sessionId: SESSION,
    nowMs: 1_000_100,
    ...over,
  });
}

describe("INV-8 consent: the happy path is one action, once", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });

  it("redeems a matching grant", () => {
    expect(grant(home)).toBe(true);
    const r = redeem(home);
    expect(r.consumed).toBe(true);
  });

  it("is SINGLE USE: the second redemption of the same grant refuses", () => {
    grant(home);
    expect(redeem(home).consumed).toBe(true);
    const second = redeem(home);
    expect(second.consumed).toBe(false);
    expect(second).toMatchObject({ reason: "no_grant" });
  });

  it("refuses when no grant was ever made", () => {
    expect(redeem(home)).toMatchObject({ consumed: false, reason: "no_grant" });
  });
});

describe("INV-8 consent: a grant cannot leak past its four keys", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });

  it("approving one action does NOT approve a different PATH", () => {
    grant(home);
    const other = redeem(home, { actionKey: actionKey("Write", "notes/OTHER.md") });
    expect(other).toMatchObject({ consumed: false, reason: "action_mismatch" });
  });

  it("approving one action does NOT approve a different TOOL on the same path", () => {
    grant(home);
    const other = redeem(home, { actionKey: actionKey("Edit", "notes/x.md") });
    expect(other).toMatchObject({ consumed: false, reason: "action_mismatch" });
  });

  it("approving one rule version does NOT approve a SUPERSEDING version", () => {
    // A superseded rule is a different rule. Its successor has to earn its own block, and its own
    // override, or a consent granted against yesterday's wording would silently carry into today's.
    grant(home);
    const other = redeem(home, { ruleVersionId: "ver_2" });
    expect(other).toMatchObject({ consumed: false, reason: "rule_version_mismatch" });
  });

  it("approving in one session does NOT cross into another session", () => {
    grant(home);
    const other = redeem(home, { sessionId: "s-2" });
    expect(other).toMatchObject({ consumed: false, reason: "session_mismatch" });
  });

  it("a REFUSED redemption does not consume the grant, so the right retry still works", () => {
    // A near-miss must not burn the operator's approval. Otherwise a stray tool call in another
    // session would silently cancel a grant they are about to use.
    grant(home);
    expect(redeem(home, { sessionId: "s-2" }).consumed).toBe(false);
    expect(redeem(home).consumed).toBe(true);
  });
});

describe("INV-8 consent: expiry bounds an UNUSED grant", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });

  it("refuses a grant older than the TTL", () => {
    grant(home, {}, 0);
    expect(redeem(home, { nowMs: CONSENT_TTL_MS + 1 })).toMatchObject({
      consumed: false,
      reason: "expired",
    });
  });

  it("accepts a grant right at the TTL boundary", () => {
    grant(home, {}, 0);
    expect(redeem(home, { nowMs: CONSENT_TTL_MS }).consumed).toBe(true);
  });

  it("removes an expired grant so it cannot be redeemed by a later clock", () => {
    grant(home, {}, 0);
    redeem(home, { nowMs: CONSENT_TTL_MS + 1 });
    // Even asking again inside the window now finds nothing: the expired file is gone.
    expect(redeem(home, { nowMs: 1 })).toMatchObject({ consumed: false, reason: "no_grant" });
  });
});

describe("INV-8 consent: it is not a bypass", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });

  it("refuses a grant missing any of its four keys", () => {
    expect(grant(home, { sessionId: "" })).toBe(false);
    expect(grant(home, { ruleVersionId: "" })).toBe(false);
    expect(grant(home, { actionKey: "" })).toBe(false);
    expect(grant(home, { incidentId: "" })).toBe(false);
    expect(redeem(home)).toMatchObject({ consumed: false, reason: "no_grant" });
  });

  it("reports failure rather than silently granting when the store is unwritable", () => {
    // An override that cannot be persisted must not be reported as granted: the record IS the
    // override, so no record means no override.
    //
    // Rooted under /dev/null, NOT /proc. Both are unwritable, but they fail differently, and
    // only one of them fails. On Linux, procfs returns ENOENT for a mkdir under /proc, so
    // Node's RECURSIVE mkdir walks up to create the missing parent, gets ENOENT again, and
    // retries forever. That livelock spins the event loop, so Jest's per-test timeout never
    // fires and --forceExit (which runs on completion) is never reached: the whole job hangs
    // until the workflow's 15 minute backstop kills it, with 0 failures reported.
    //
    // macOS has no /proc at all, so the same line fails fast locally and the suite is green on
    // a developer machine. This is the SECOND time this exact trap has been set here; see the
    // note in .github/workflows/mla-ci.yml, which records failure-telemetry.spec.ts doing it
    // first. /dev/null is a file, so mkdir under it fails immediately with ENOTDIR on both
    // platforms, which is the same assertion without the livelock.
    expect(grant("/dev/null/nonexistent-root/nope")).toBe(false);
  });

  it("discards a corrupt grant rather than treating it as a pass", () => {
    grant(home);
    const f = path.join(home, "enforcement-consent", "inc_1.json");
    fs.writeFileSync(f, "{not json", "utf8");
    expect(redeem(home)).toMatchObject({ consumed: false });
    expect(fs.existsSync(f)).toBe(false);
  });

  it("normalizes tool casing but never conflates two different targets", () => {
    expect(actionKey("write", "notes/x.md")).toBe(actionKey("WRITE", "notes/x.md"));
    expect(actionKey("Write", "notes/x.md")).not.toBe(actionKey("Write", "notes/y.md"));
  });

  it("stores no raw path: the action is a digest, not the operator's filesystem", () => {
    grant(home);
    const body = fs.readFileSync(path.join(home, "enforcement-consent", "inc_1.json"), "utf8");
    expect(body).not.toContain("notes/x.md");
  });
});

describe("INV-8: the override is a DISTINCT event on the SAME episode", () => {
  it("does not reuse the block's event id, or control's primary key silently discards it", async () => {
    // Found live: the block and its override both hashed to
    // ccf3fae51aea...29a because the deterministic event id was keyed on the incident id alone.
    // analytics_events has eventId as its PRIMARY KEY, so the override was dropped at INGEST, not
    // merely mis-collapsed. The incident id must stay shared (one enforcement episode, per the
    // ruling) while each lifecycle event carries its own id.
    const { enforcementIncidentEventId } = await import(
      "../../../src/lib/analytics/enforcement-incident"
    );
    const block = enforcementIncidentEventId("inc_1", undefined);
    const override = enforcementIncidentEventId("inc_1", "overridden");
    expect(block).not.toBe(override);
  });

  it("stays deterministic per lifecycle stage, so a RETRIED delivery still dedups", async () => {
    const { enforcementIncidentEventId } = await import(
      "../../../src/lib/analytics/enforcement-incident"
    );
    expect(enforcementIncidentEventId("inc_1", "overridden")).toBe(
      enforcementIncidentEventId("inc_1", "overridden"),
    );
    expect(enforcementIncidentEventId("inc_1", undefined)).toBe(
      enforcementIncidentEventId("inc_1", undefined),
    );
  });

  it("keeps distinct episodes distinct", async () => {
    const { enforcementIncidentEventId } = await import(
      "../../../src/lib/analytics/enforcement-incident"
    );
    expect(enforcementIncidentEventId("inc_1", "overridden")).not.toBe(
      enforcementIncidentEventId("inc_2", "overridden"),
    );
  });
});
