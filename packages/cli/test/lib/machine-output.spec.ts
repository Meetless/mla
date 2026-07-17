import {
  MACHINE_PROTOCOL,
  MACHINE_SCHEMA_VERSION,
  emitEnvelope,
  emitUnsupportedOutputMode,
  errorEnvelope,
  failInMode,
  getMachineCommand,
  getOutputMode,
  hasOutputFlag,
  isMachineMode,
  outputFlagValue,
  resetMachineCommand,
  resetOutputMode,
  resolveOutputMode,
  setMachineCommand,
  setOutputMode,
  stripOutputFlag,
  successEnvelope,
  type MachineEnvelope,
} from "../../src/lib/machine-output";

// The pure half of the machine-output contract (§4.1-§4.2). Every invariant the
// connector relies on is asserted here: the discriminator, the exactly-one-of
// result/error shape, snake_case field names, the ok/exit-code lock, and the
// central precedence that decides the mode. The dispatch wiring is tested
// separately (command-registry / handler parity); this file never spawns a
// command.

// The mode + command are process-level singletons; reset between every test so
// one case can never leak its mode into the next (the §4.10 test bars).
beforeEach(() => {
  resetOutputMode();
  resetMachineCommand();
});

describe("output mode singleton", () => {
  it("defaults to human and reports isMachineMode false", () => {
    expect(getOutputMode()).toBe("human");
    expect(isMachineMode()).toBe(false);
  });

  it("both machine modes are machine mode; human is not", () => {
    setOutputMode("machine-best-effort");
    expect(isMachineMode()).toBe(true);
    setOutputMode("machine-strict");
    expect(isMachineMode()).toBe(true);
    setOutputMode("human");
    expect(isMachineMode()).toBe(false);
  });

  it("resetOutputMode returns to human", () => {
    setOutputMode("machine-strict");
    resetOutputMode();
    expect(getOutputMode()).toBe("human");
  });
});

describe("machine command singleton", () => {
  it("is null until set, then reads back the armed operation id", () => {
    expect(getMachineCommand()).toBeNull();
    setMachineCommand("enrich.plan");
    expect(getMachineCommand()).toBe("enrich.plan");
    resetMachineCommand();
    expect(getMachineCommand()).toBeNull();
  });
});

describe("flag helpers", () => {
  it("outputFlagValue reads the first --output= value or null", () => {
    expect(outputFlagValue(["enrich", "plan"])).toBeNull();
    expect(outputFlagValue(["enrich", "plan", "--output=json"])).toBe("json");
    expect(outputFlagValue(["--output=text", "--output=json"])).toBe("text");
  });

  it("hasOutputFlag detects any --output= token", () => {
    expect(hasOutputFlag(["enrich", "plan"])).toBe(false);
    expect(hasOutputFlag(["enrich", "--output=json", "plan"])).toBe(true);
  });

  it("stripOutputFlag removes every --output= token and nothing else", () => {
    expect(stripOutputFlag(["enrich", "plan", "--output=json"])).toEqual([
      "enrich",
      "plan",
    ]);
    expect(
      stripOutputFlag(["enrich", "--output=json", "accept", "--output=x"]),
    ).toEqual(["enrich", "accept"]);
    // A bare `--output` (no `=`) is NOT the flag; leave it for the parser to reject.
    expect(stripOutputFlag(["x", "--output"])).toEqual(["x", "--output"]);
  });
});

describe("resolveOutputMode precedence (§4.1)", () => {
  it("--output=json flag wins as strict, even against the env", () => {
    expect(resolveOutputMode(["a", "--output=json"], "json")).toBe(
      "machine-strict",
    );
    expect(resolveOutputMode(["a", "--output=json"], undefined)).toBe(
      "machine-strict",
    );
  });

  it("MEETLESS_OUTPUT=json is best-effort when no flag is present", () => {
    expect(resolveOutputMode(["a"], "json")).toBe("machine-best-effort");
  });

  it("an --output=<other> value is human, never machine (still stripped elsewhere)", () => {
    expect(resolveOutputMode(["a", "--output=yaml"], "json")).toBe("human");
    expect(resolveOutputMode(["a", "--output="], undefined)).toBe("human");
  });

  it("no flag and no env is human", () => {
    expect(resolveOutputMode(["a"], undefined)).toBe("human");
    expect(resolveOutputMode(["a"], "")).toBe("human");
  });
});

describe("successEnvelope shape (§4.2)", () => {
  it("carries the protocol, version, command, ok:true, and result", () => {
    const env = successEnvelope("enrich.plan", { hi: 1 });
    expect(env.protocol).toBe(MACHINE_PROTOCOL);
    expect(env.schema_version).toBe(MACHINE_SCHEMA_VERSION);
    expect(env.command).toBe("enrich.plan");
    expect(env.ok).toBe(true);
    expect(env.result).toEqual({ hi: 1 });
    // No control directives unless asked.
    expect(env.next_action).toBeUndefined();
    expect(env.decision_request).toBeUndefined();
    expect(env.human_summary).toBeUndefined();
  });

  it("result may be a top-level array (§4.4)", () => {
    const env = successEnvelope("rules.list", [1, 2, 3]);
    expect(env.result).toEqual([1, 2, 3]);
  });

  it("attaches a next_action when given one", () => {
    const env = successEnvelope("activate", { ok: 1 }, {
      nextAction: { kind: "skill", ref: "onboard" },
    });
    expect(env.next_action).toEqual({ kind: "skill", ref: "onboard" });
  });

  it("attaches human_summary when given one", () => {
    const env = successEnvelope("enrich.plan", {}, { humanSummary: "3 scouts" });
    expect(env.human_summary).toBe("3 scouts");
  });

  it("throws if both next_action and decision_request are set (at most one, §4.2)", () => {
    expect(() =>
      successEnvelope("enrich.accept", {}, {
        nextAction: { kind: "skill", ref: "onboard" },
        decisionRequest: {
          kind: "enrich.accept",
          subject: { run_id: "r1" },
          prompt: "?",
          options: [],
        },
      }),
    ).toThrow(/at most one/);
  });
});

describe("errorEnvelope shape (§4.2)", () => {
  it("carries ok:false and the error body, never a result", () => {
    const env = errorEnvelope("enrich.plan", {
      code: "config_error",
      message: "bad",
      trace_id: "t1",
    });
    expect(env.ok).toBe(false);
    expect(env.error).toEqual({
      code: "config_error",
      message: "bad",
      trace_id: "t1",
    });
    expect((env as unknown as { result?: unknown }).result).toBeUndefined();
  });
});

describe("emitEnvelope (§4.2 stdout + invariant)", () => {
  let writes: string[];
  let spy: jest.SpyInstance;

  beforeEach(() => {
    writes = [];
    spy = jest
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        writes.push(String(chunk));
        return true;
      });
  });

  afterEach(() => spy.mockRestore());

  it("writes exactly one JSON line terminated by a single newline", () => {
    const env = successEnvelope("enrich.plan", { a: 1 });
    const code = emitEnvelope(env, 0);
    expect(code).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0].endsWith("\n")).toBe(true);
    expect(writes[0].indexOf("\n")).toBe(writes[0].length - 1);
    const parsed = JSON.parse(writes[0]) as MachineEnvelope;
    expect(parsed.protocol).toBe(MACHINE_PROTOCOL);
  });

  it("enforces ok === (exitCode === 0): success at 0, error at nonzero", () => {
    expect(emitEnvelope(successEnvelope("c", {}), 0)).toBe(0);
    expect(
      emitEnvelope(
        errorEnvelope("c", { code: "x", message: "y", trace_id: "" }),
        2,
      ),
    ).toBe(2);
  });

  it("throws when ok contradicts the exit code (a call-site bug, not runtime)", () => {
    expect(() => emitEnvelope(successEnvelope("c", {}), 1)).toThrow(
      /contradicts exit code/,
    );
    expect(() =>
      emitEnvelope(
        errorEnvelope("c", { code: "x", message: "y", trace_id: "" }),
        0,
      ),
    ).toThrow(/contradicts exit code/);
  });
});

describe("emitUnsupportedOutputMode (§4.3)", () => {
  it("emits one unsupported_output_mode error envelope and exits 2", () => {
    const writes: string[] = [];
    const spy = jest
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        writes.push(String(chunk));
        return true;
      });
    try {
      const code = emitUnsupportedOutputMode("enrich.accept.apply");
      expect(code).toBe(2);
      const env = JSON.parse(writes[0]) as MachineEnvelope;
      expect(env.ok).toBe(false);
      if (!env.ok) {
        expect(env.error.code).toBe("unsupported_output_mode");
        expect(env.command).toBe("enrich.accept.apply");
      }
    } finally {
      spy.mockRestore();
    }
  });
});

describe("failInMode (§4.2 drop-in for console.error; return N)", () => {
  it("in machine mode emits an error envelope and returns the exit code", () => {
    setOutputMode("machine-best-effort");
    const writes: string[] = [];
    const outSpy = jest
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        writes.push(String(chunk));
        return true;
      });
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const code = failInMode("enrich.plan", "config_error", "no config", 2);
      expect(code).toBe(2);
      // stderr stays silent; the failure is the single stdout envelope.
      expect(errSpy).not.toHaveBeenCalled();
      const env = JSON.parse(writes[0]) as MachineEnvelope;
      expect(env.ok).toBe(false);
      if (!env.ok) {
        expect(env.error.code).toBe("config_error");
        expect(env.error.message).toBe("no config");
      }
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("in human mode writes the message to stderr and returns the exit code (byte-for-byte legacy)", () => {
    const outSpy = jest
      .spyOn(process.stdout, "write")
      .mockImplementation((): boolean => true);
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const code = failInMode("enrich.plan", "config_error", "no config", 2);
      expect(code).toBe(2);
      expect(errSpy).toHaveBeenCalledWith("no config");
      // No envelope is written in human mode.
      expect(outSpy).not.toHaveBeenCalled();
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
