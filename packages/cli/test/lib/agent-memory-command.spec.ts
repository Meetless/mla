// test/lib/agent-memory-command.spec.ts
//
// `mla agent-memory push` performs a LIVE upload, so it must refuse without an
// explicit --yes confirmation. That refusal returns BEFORE the collector is ever
// constructed, so this test is hermetic: it touches neither the network nor the
// real ledger/config. (The collector's own gates -- a consented binding and a
// resolvable actor -- and its upload behavior are covered in
// live-collector.spec.ts with injected dependencies.)
import { runAgentMemory } from "../../src/commands/agent-memory";

describe("mla agent-memory push (confirmation gate)", () => {
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  function output(spy: jest.SpyInstance): string {
    return spy.mock.calls.map((c) => String(c[0])).join("\n");
  }

  it("refuses (no upload) when --yes is absent, and explains the gate", async () => {
    const code = await runAgentMemory(["push"]);
    expect(code).toBe(0);
    const msg = output(logSpy);
    expect(msg).toContain("UPLOAD"); // describes what a confirmed push would do
    expect(msg).toContain("--yes"); // tells the operator exactly how to confirm
  });

  it("rejects an unknown flag with exit 2", async () => {
    const code = await runAgentMemory(["push", "--bogus"]);
    expect(code).toBe(2);
  });
});
