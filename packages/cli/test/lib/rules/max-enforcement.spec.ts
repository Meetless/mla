// test/lib/rules/max-enforcement.spec.ts
//
// The session enforcement ceiling, and the sweep that must obey it.
//
// Two things are pinned here:
//   1. The shipped ceiling is WARN (owner ruling, An, 2026-07-12: "we will only ship
//      warn and never block"). A stock install cannot take a user's tool call away.
//   2. The PostToolUse sweep, which DELETES files, reads that same ceiling. It used not
//      to: the lever was private to the PreToolUse gate, so `MEETLESS_ACTION_INTERCEPT_MAX=warn`
//      would let a write through as an advisory and then the sweep would silently delete
//      the file the gate had just allowed. That is a kill-switch bypass and a data-loss
//      path, and it is what the second describe block forbids.
import {
  DEFAULT_MAX_ENFORCEMENT,
  mayRevertFiles,
  parseMaxEnforcement,
  resolveMaxEnforcement,
} from "../../../src/lib/rules/max-enforcement";
import * as bundleCacheModule from "../../../src/lib/rules/bundle-cache";
import * as workspaceModule from "../../../src/lib/workspace";
import * as principalModule from "../../../src/lib/rules/bundle-principal";
import { runInternalPosttoolSweep } from "../../../src/commands/internal-enforcement-sweep";

describe("the shipped enforcement ceiling", () => {
  it("is WARN: we ship warn and never block", () => {
    expect(DEFAULT_MAX_ENFORCEMENT).toBe("WARN");
    expect(parseMaxEnforcement(undefined)).toBe("WARN");
  });

  it("honors an explicit opt-in in either direction", () => {
    expect(resolveMaxEnforcement({ MEETLESS_ACTION_INTERCEPT_MAX: "deny" })).toBe("DENY");
    expect(resolveMaxEnforcement({ MEETLESS_ACTION_INTERCEPT_MAX: "ask" })).toBe("ASK");
    expect(resolveMaxEnforcement({ MEETLESS_ACTION_INTERCEPT_MAX: "observe" })).toBe("OBSERVE");
  });

  it("treats an unrecognized value as the default, never as an escalation", () => {
    expect(resolveMaxEnforcement({ MEETLESS_ACTION_INTERCEPT_MAX: "block" })).toBe("WARN");
    expect(resolveMaxEnforcement({})).toBe("WARN");
  });
});

describe("mayRevertFiles: deleting a user's file needs an explicit DENY ceiling", () => {
  it("is false at the shipped ceiling", () => {
    expect(mayRevertFiles({})).toBe(false);
    expect(mayRevertFiles({ MEETLESS_ACTION_INTERCEPT_MAX: "warn" })).toBe(false);
  });

  it("is false at ASK: an interactive prompt is not consent to delete after the fact", () => {
    expect(mayRevertFiles({ MEETLESS_ACTION_INTERCEPT_MAX: "ask" })).toBe(false);
  });

  it("is true only at DENY", () => {
    expect(mayRevertFiles({ MEETLESS_ACTION_INTERCEPT_MAX: "deny" })).toBe(true);
  });
});

describe("runInternalPosttoolSweep honors the ceiling (kill-switch bypass regression)", () => {
  const OLD = process.env.MEETLESS_ACTION_INTERCEPT_MAX;
  let out = "";

  beforeEach(() => {
    out = "";
    jest.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out += String(chunk);
      return true;
    });
    // stdin: the hook reads a PostToolUse body. Feed it one and end.
    jest.spyOn(process.stdin, "on").mockImplementation(function (this: unknown, ev: string, cb: (...a: unknown[]) => void) {
      if (ev === "data") cb(Buffer.from(JSON.stringify({ session_id: "s1", cwd: process.cwd() })));
      if (ev === "end") cb();
      return process.stdin;
    } as never);
    // A resolvable principal, so the ONLY thing that can stop the sweep is the ceiling.
    jest.spyOn(workspaceModule, "resolveWorkspaceIdWithEnv").mockReturnValue("ws_test");
    jest
      .spyOn(principalModule, "resolveBundlePrincipal")
      .mockReturnValue({ workspaceId: "ws_test" } as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (OLD === undefined) delete process.env.MEETLESS_ACTION_INTERCEPT_MAX;
    else process.env.MEETLESS_ACTION_INTERCEPT_MAX = OLD;
  });

  it("does not even READ the rule bundle at the shipped WARN ceiling", async () => {
    delete process.env.MEETLESS_ACTION_INTERCEPT_MAX;
    const read = jest.spyOn(bundleCacheModule, "readRuleBundleCache");

    const code = await runInternalPosttoolSweep([]);

    expect(code).toBe(0);
    expect(out).toBe("{}"); // pure pass-through: nothing reverted, nothing to say
    // If it never reads the bundle it can never compute a forbidden root, and if it has
    // no forbidden root it can never delete a file. That is the guarantee, structurally.
    expect(read).not.toHaveBeenCalled();
  });

  it("does not read the bundle at an ASK ceiling either", async () => {
    process.env.MEETLESS_ACTION_INTERCEPT_MAX = "ask";
    const read = jest.spyOn(bundleCacheModule, "readRuleBundleCache");

    await runInternalPosttoolSweep([]);

    expect(out).toBe("{}");
    expect(read).not.toHaveBeenCalled();
  });

  it("consults the bundle only when an operator has explicitly opted in to DENY", async () => {
    process.env.MEETLESS_ACTION_INTERCEPT_MAX = "deny";
    const read = jest
      .spyOn(bundleCacheModule, "readRuleBundleCache")
      .mockReturnValue({ status: "unavailable" } as never);

    await runInternalPosttoolSweep([]);

    expect(read).toHaveBeenCalled();
  });
});
