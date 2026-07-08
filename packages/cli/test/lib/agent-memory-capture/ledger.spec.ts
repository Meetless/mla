import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { readLedger, writeLedger } from "../../../src/lib/agent-memory-capture/ledger";
import { ledgerPath } from "../../../src/lib/agent-memory-capture/paths";
import type { Ledger } from "../../../src/lib/agent-memory-capture/types";

describe("ledger", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "aml-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns an empty ledger when none exists (fail-open)", () => {
    const l = readLedger("b1", home);
    expect(l.version).toBe(1);
    expect(l.entries).toEqual({});
  });

  it("round-trips a written ledger", () => {
    const l: Ledger = {
      version: 1,
      entries: {
        "x.md": { lastObservedHash: "abc", lastDecision: "eligible", lastObservedAt: "t0" },
        "y.md": {
          lastObservedHash: "def",
          lastDecision: "blocked",
          blockedScannerVersion: "v1",
          lastObservedAt: "t1",
        },
      },
    };
    writeLedger("b1", l, home);
    const back = readLedger("b1", home);
    expect(back).toEqual(l);
  });

  it("fails open to empty on corrupt JSON", () => {
    // Seed a valid ledger so the on-disk directory exists, then corrupt the bytes.
    writeLedger("b1", { version: 1, entries: {} }, home);
    writeFileSync(ledgerPath("b1", home), "{ not json", { mode: 0o600 });
    expect(readLedger("b1", home).entries).toEqual({});
  });

  it("keeps separate ledgers per binding id", () => {
    writeLedger("a", { version: 1, entries: { "f.md": { lastObservedHash: "1", lastDecision: "eligible", lastObservedAt: "t" } } }, home);
    writeLedger("b", { version: 1, entries: {} }, home);
    expect(Object.keys(readLedger("a", home).entries)).toEqual(["f.md"]);
    expect(readLedger("b", home).entries).toEqual({});
  });
});
