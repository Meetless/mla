import { compareSteers, formatCoordinationShadow, runCoordinationShadow } from "../../src/lib/coordination-shadow";

const steer = (id: string) => ({ id, directive: "d", caseId: null, createdAt: "t0" });

describe("compareSteers", () => {
  it("calls the same delivered ids the same: legacy steer.id vs canonical commandId", () => {
    const cmp = compareSteers([steer("st_1"), steer("st_2")], {
      commands: [{ commandId: "st_2" }, { commandId: "st_1" }],
    });
    expect(cmp.same).toBe(true);
    expect(cmp.overlap).toBe(2);
    expect(cmp.onlyLegacy).toEqual([]);
    expect(cmp.onlyCanonical).toEqual([]);
  });

  it("names what each side claimed that the other did not", () => {
    const cmp = compareSteers([steer("st_1"), steer("st_gone")], {
      commands: [{ commandId: "st_1" }, { commandId: "st_new" }],
    });
    expect(cmp.same).toBe(false);
    expect(cmp.onlyLegacy).toEqual(["st_gone"]);
    expect(cmp.onlyCanonical).toEqual(["st_new"]);
    expect(cmp.overlap).toBe(1);
  });

  it("treats two empty sets as agreement, not a missing comparison (the common every-turn case)", () => {
    // Most turns have no pending steers; an empty legacy set and an empty canonical set agree.
    expect(compareSteers([], { commands: [] }).same).toBe(true);
  });

  it("does not choke on a malformed canonical body", () => {
    expect(compareSteers([steer("st_1")], null).canonical).toEqual([]);
    expect(compareSteers([steer("st_1")], { commands: "nope" }).canonical).toEqual([]);
  });

  it("dedupes so a repeated id is not counted twice", () => {
    expect(compareSteers([steer("st_1"), steer("st_1")], { commands: [{ commandId: "st_1" }] }).legacy).toEqual([
      "st_1",
    ]);
  });
});

describe("runCoordinationShadow never affects the flush drain", () => {
  it("does nothing when disabled", async () => {
    const cmp = await runCoordinationShadow({
      enabled: false,
      platformUrl: "http://127.0.0.1:3020",
      accessToken: "t",
      sessionId: "s",
      legacySteers: [],
    });
    expect(cmp).toEqual({ ran: false, skipped: "disabled" });
  });

  it("SKIPS rather than errors on a shared-key CLI", async () => {
    const cmp = await runCoordinationShadow({
      enabled: true,
      platformUrl: "http://127.0.0.1:3020",
      accessToken: undefined,
      sessionId: "s",
      legacySteers: [],
    });
    expect(cmp.ran).toBe(false);
    expect(cmp.skipped).toMatch(/shared-key/);
  });

  it("SKIPS when no platform URL is configured", async () => {
    const cmp = await runCoordinationShadow({
      enabled: true,
      platformUrl: undefined,
      accessToken: "t",
      sessionId: "s",
      legacySteers: [],
    });
    expect(cmp.ran).toBe(false);
    expect(cmp.skipped).toMatch(/MEETLESS_PLATFORM_URL/);
  });

  it("swallows an unreachable tier: a shadow must never break a drain", async () => {
    const cmp = await runCoordinationShadow({
      enabled: true,
      platformUrl: "http://127.0.0.1:9",
      accessToken: "t",
      sessionId: "s",
      legacySteers: [],
    });
    expect(cmp.ran).toBe(false);
    expect(cmp.error ?? cmp.skipped).toBeTruthy();
  });
});

describe("formatCoordinationShadow", () => {
  it("is one greppable line and says whether the id sets matched", () => {
    const line = formatCoordinationShadow(compareSteers([steer("st_1")], { commands: [{ commandId: "st_1" }] }));
    expect(line).toBe("d3_shadow same=true overlap=1 legacy=1 canonical=1");
  });

  it("names the divergence when there is one, so the log is actionable", () => {
    const line = formatCoordinationShadow(compareSteers([steer("st_1")], { commands: [] }));
    expect(line).toContain("same=false");
    expect(line).toContain("only_legacy=[st_1]");
  });

  it("reports a skip as a skip, distinct from a divergence", () => {
    expect(formatCoordinationShadow({ ran: false, skipped: "canonical HTTP 403" })).toBe(
      "d3_shadow skipped=canonical HTTP 403",
    );
  });
});
