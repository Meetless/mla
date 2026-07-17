import {
  resolveOperation,
  supportsMachineOutput,
  type OperationId,
} from "../../src/lib/machine-capability";

// Operation-grained capability (§4.3). Two pure functions decide, at the dispatch
// choke point, whether an invocation may emit an envelope. The resolver is
// CONSERVATIVE: a known operation only when the argv shape is unambiguous, null
// otherwise. These tests pin the Phase-1 + Phase-3 support set and every argv split.

describe("resolveOperation: activate (§A6)", () => {
  it("plain activate resolves to activate", () => {
    expect(resolveOperation("activate", ["activate"])).toBe("activate");
    expect(resolveOperation("activate", ["activate", "--here"])).toBe(
      "activate",
    );
  });

  it("--repair is a distinct, unconverted operation", () => {
    expect(resolveOperation("activate", ["activate", "--repair"])).toBe(
      "activate.repair",
    );
  });
});

describe("resolveOperation: enrich subcommands", () => {
  it("plan and ingest resolve by the subcommand word", () => {
    expect(resolveOperation("enrich", ["enrich", "plan"])).toBe("enrich.plan");
    expect(resolveOperation("enrich", ["enrich", "ingest"])).toBe(
      "enrich.ingest",
    );
  });

  it("accept with NO selection flag is the read-only review (Phase 1)", () => {
    expect(resolveOperation("enrich", ["enrich", "accept"])).toBe(
      "enrich.accept",
    );
    expect(
      resolveOperation("enrich", ["enrich", "accept", "--run-id", "r1"]),
    ).toBe("enrich.accept");
  });

  it("accept WITH a selection flag is the mutation (Phase 3, distinct id)", () => {
    expect(resolveOperation("enrich", ["enrich", "accept", "--all"])).toBe(
      "enrich.accept.apply",
    );
    expect(
      resolveOperation("enrich", ["enrich", "accept", "--only", "c1"]),
    ).toBe("enrich.accept.apply");
    expect(
      resolveOperation("enrich", ["enrich", "accept", "--only=c1,c2"]),
    ).toBe("enrich.accept.apply");
  });

  it("an unknown enrich subcommand is null (conservative)", () => {
    expect(resolveOperation("enrich", ["enrich", "frobnicate"])).toBeNull();
    expect(resolveOperation("enrich", ["enrich"])).toBeNull();
  });
});

describe("resolveOperation: unknown families are null", () => {
  it("returns null for any command with no machine operation", () => {
    expect(resolveOperation("doctor", ["doctor"])).toBeNull();
    expect(resolveOperation("kb", ["kb", "list"])).toBeNull();
    expect(resolveOperation("mcp", ["mcp"])).toBeNull();
  });
});

describe("supportsMachineOutput: the Phase-1 + Phase-3 set (§A6)", () => {
  it("supports the Phase-1 read path plus the Phase-3 accept mutation", () => {
    const supported: OperationId[] = [
      "activate",
      "enrich.plan",
      "enrich.ingest",
      "enrich.accept",
      // Phase 3 (§A6 line 570): the accept mutation gains full envelope coverage.
      "enrich.accept.apply",
    ];
    for (const op of supported) expect(supportsMachineOutput(op)).toBe(true);
  });

  it("does NOT support the repair diagnostic (deferred to Phase 4)", () => {
    const unsupported: OperationId[] = ["activate.repair"];
    for (const op of unsupported) expect(supportsMachineOutput(op)).toBe(false);
  });
});
