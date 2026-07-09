import { parseFlushResult } from "../../src/lib/spool";
import { describeFlush } from "../../src/commands/flush";

// BUG-1 E / BUG-2 H: `mla flush` must report the TRUE per-session outcome. The
// old code keyed "[flush] <sid> ok" purely on flush.sh's exit code, which is
// ALWAYS 0 (capture must never break a session), so a 401/403/404 that silently
// re-spooled every event still printed "ok". These tests pin the marker parser
// and the honest describer so a blocked drain can never masquerade as ok again.

describe("parseFlushResult", () => {
  it("parses a clean delivery -> ok, delivered count, no auth code", () => {
    const r = parseFlushResult("MLA_FLUSH_RESULT status=ok delivered=5 respooled=0 authcode=");
    expect(r).toEqual({ ok: true, status: "ok", delivered: 5, respooled: 0, authCode: "" });
  });

  it("parses a 403-blocked drain -> NOT ok, carries the auth code + respool count", () => {
    const r = parseFlushResult("MLA_FLUSH_RESULT status=blocked delivered=0 respooled=7 authcode=403");
    expect(r).toEqual({ ok: false, status: "blocked", delivered: 0, respooled: 7, authCode: "403" });
  });

  it("parses a deferred drain (control 5xx / missing filter) -> NOT ok, no auth code", () => {
    const r = parseFlushResult("MLA_FLUSH_RESULT status=deferred delivered=0 respooled=3 authcode=");
    expect(r).toEqual({ ok: false, status: "deferred", delivered: 0, respooled: 3, authCode: "" });
  });

  it("treats empty / locked / noworkspace as valid statuses (ok only for empty)", () => {
    expect(parseFlushResult("MLA_FLUSH_RESULT status=empty delivered=0 respooled=0 authcode=")?.ok).toBe(true);
    expect(parseFlushResult("MLA_FLUSH_RESULT status=locked delivered=0 respooled=0 authcode=")?.status).toBe(
      "locked",
    );
    expect(parseFlushResult("MLA_FLUSH_RESULT status=locked delivered=0 respooled=0 authcode=")?.ok).toBe(false);
    expect(
      parseFlushResult("MLA_FLUSH_RESULT status=noworkspace delivered=0 respooled=0 authcode=")?.status,
    ).toBe("noworkspace");
  });

  it("picks the marker out of noisy stdout (finalize-session inherits stdout)", () => {
    // Pass 3 runs `mla _internal finalize-session`, whose output interleaves on
    // the same stdout. The marker is the LAST line (EXIT trap fires at real exit).
    const noisy = [
      "Pass 3: finalizing session",
      "some finalize-session chatter that is not a marker",
      "MLA_FLUSH_RESULT status=ok delivered=2 respooled=0 authcode=",
    ].join("\n");
    expect(parseFlushResult(noisy)).toEqual({
      ok: true,
      status: "ok",
      delivered: 2,
      respooled: 0,
      authCode: "",
    });
  });

  it("maps an unrecognized status word to 'unknown' (forward-compat)", () => {
    const r = parseFlushResult("MLA_FLUSH_RESULT status=weird delivered=0 respooled=0 authcode=");
    expect(r?.status).toBe("unknown");
    expect(r?.ok).toBe(false);
  });

  it("returns null when no marker is present (stale pre-fix hook)", () => {
    expect(parseFlushResult("just some log output\nno marker here")).toBeNull();
    expect(parseFlushResult("")).toBeNull();
  });
});

describe("describeFlush", () => {
  const base = { delivered: 0, respooled: 0, authCode: "", stderr: "" };

  it("blocked drain is reported as BLOCKED and counts as bad (the core regression)", () => {
    const line = describeFlush("sess-1", { ...base, ok: false, status: "blocked", respooled: 7, authCode: "403" });
    expect(line.bad).toBe(true);
    expect(line.text).toContain("BLOCKED");
    expect(line.text).toContain("403");
    expect(line.text).toContain("7");
    // The exact thing the bug was about: a blocked drain must NEVER read as "ok".
    expect(line.text).not.toMatch(/\bok\b/);
  });

  it("clean delivery reads ok with the delivered count and is not bad", () => {
    const line = describeFlush("sess-2", { ...base, ok: true, status: "ok", delivered: 4 });
    expect(line.bad).toBe(false);
    expect(line.text).toContain("ok");
    expect(line.text).toContain("4");
  });

  it("deferred is surfaced honestly but does NOT fail the command (transient retry)", () => {
    const line = describeFlush("sess-3", { ...base, ok: false, status: "deferred", respooled: 3 });
    expect(line.bad).toBe(false);
    expect(line.text).toContain("deferred");
    expect(line.text).toContain("3");
  });

  it("empty / locked / noworkspace are non-fatal and distinctly worded", () => {
    expect(describeFlush("s", { ...base, ok: true, status: "empty" }).bad).toBe(false);
    expect(describeFlush("s", { ...base, ok: false, status: "locked" }).text).toContain("busy");
    expect(describeFlush("s", { ...base, ok: false, status: "noworkspace" }).text).toContain("no workspace");
    expect(describeFlush("s", { ...base, ok: false, status: "noworkspace" }).bad).toBe(false);
  });

  it("unknown falls back to the exit-code-derived ok (stale hook stays green, real crash is bad)", () => {
    // Stale hook that emitted no marker but exited 0 -> runFlushScript set ok=true.
    expect(describeFlush("s", { ...base, ok: true, status: "unknown" }).bad).toBe(false);
    // A genuine failure (flush.sh missing) -> ok=false -> reported FAILED.
    expect(
      describeFlush("s", { ...base, ok: false, status: "unknown", stderr: "flush.sh not found" }).bad,
    ).toBe(true);
  });
});
