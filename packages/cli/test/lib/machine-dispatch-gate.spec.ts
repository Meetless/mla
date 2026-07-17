import { dispatch } from "../../src/cli";
import {
  resetMachineCommand,
  resetOutputMode,
  setOutputMode,
  type MachineEnvelope,
} from "../../src/lib/machine-output";

// The capability gate at the single dispatch choke point (§4.3). The bootstrap
// (env consumption, mode resolution, flag strip) is exercised live against the
// built binary; here we drive dispatch() with the mode already resolved -- exactly
// the state the bootstrap leaves -- and assert the gate's two decisive early
// returns for a STRICT request against an operation with no machine emitter. Those
// return BEFORE any handler runs, so no workspace/config is needed.

function captureStdout(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const spy = jest
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      writes.push(String(chunk));
      return true;
    });
  return { writes, restore: () => spy.mockRestore() };
}

beforeEach(() => {
  resetOutputMode();
  resetMachineCommand();
});

describe("dispatch capability gate: strict + unsupported operation", () => {
  it("an UNRESOLVED operation (`enrich frobnicate`) emits unsupported_output_mode with the family fallback", async () => {
    setOutputMode("machine-strict");
    const cap = captureStdout();
    try {
      // The resolver returns null for an unknown subcommand; the gate falls back to
      // the family name for the envelope `command` (`op ?? command`) and still emits
      // exactly one unsupported error, never running the enrich handler.
      const code = await dispatch(["enrich", "frobnicate"]);
      expect(code).toBe(2);
      expect(cap.writes).toHaveLength(1);
      const env = JSON.parse(cap.writes[0]) as MachineEnvelope;
      expect(env.ok).toBe(false);
      if (!env.ok) {
        expect(env.error.code).toBe("unsupported_output_mode");
        expect(env.command).toBe("enrich");
      }
    } finally {
      cap.restore();
    }
  });

  it("`activate --repair` (the diagnostic) emits unsupported_output_mode and exits 2", async () => {
    setOutputMode("machine-strict");
    const cap = captureStdout();
    try {
      const code = await dispatch(["activate", "--repair"]);
      expect(code).toBe(2);
      expect(cap.writes).toHaveLength(1);
      const env = JSON.parse(cap.writes[0]) as MachineEnvelope;
      expect(env.ok).toBe(false);
      if (!env.ok) {
        expect(env.error.code).toBe("unsupported_output_mode");
        expect(env.command).toBe("activate.repair");
      }
    } finally {
      cap.restore();
    }
  });
});
