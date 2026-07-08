import { MANAGED_HOOK_SCRIPTS } from "../../src/lib/wire";

describe("MANAGED_HOOK_SCRIPTS", () => {
  it("lists exactly the nine managed (event, script) pairs install can wire", () => {
    // Five load-bearing capture hooks plus the four CE0 evidence hooks. Three ride
    // the EXISTING UserPromptSubmit/PostToolUse/Stop events as second managed entries;
    // the fourth (ce0-session-start.sh) rides SessionStart and projects the CE0 store's
    // two §6.4 denominator events (memory_requirement_assessed, evidence_obligation_finalized)
    // into the analytics log on each session start, giving the offline sweep an automatic
    // caller so the precision/recall denominator flows without a human running it.
    const pairs = MANAGED_HOOK_SCRIPTS.map((h) => `${h.event}:${h.script}`).sort();
    expect(pairs).toEqual(
      [
        "PostToolUse:post-tool-use.sh",
        "PreToolUse:pre-tool-use.sh",
        "SessionStart:session-start.sh",
        "Stop:stop.sh",
        "UserPromptSubmit:user-prompt-submit.sh",
        "UserPromptSubmit:ce0-user-prompt-submit.sh",
        "PostToolUse:ce0-post-tool-use.sh",
        "Stop:ce0-stop.sh",
        "SessionStart:ce0-session-start.sh",
      ].sort(),
    );
  });

  it("carries the timeout/matcher metadata install needs", () => {
    const ups = MANAGED_HOOK_SCRIPTS.find((h) => h.script === "user-prompt-submit.sh");
    expect(ups?.timeout).toBe(30);
    const ptu = MANAGED_HOOK_SCRIPTS.find((h) => h.script === "post-tool-use.sh");
    expect(ptu?.matcher).toBe("");
    // The observe-only PreToolUse pilot is scoped to file-writing tools ONLY.
    // Unlike PostToolUse (catch-all so the heartbeat fires on every tool), this
    // hook must not fire on Bash/Read/etc., so it carries a narrow exact-match
    // matcher rather than the empty catch-all.
    const pre = MANAGED_HOOK_SCRIPTS.find((h) => h.script === "pre-tool-use.sh");
    expect(pre?.matcher).toBe("^(Write|Edit)$");
  });

  it("scopes the CE0 PostToolUse hook to the meetless MCP tools (narrow, not the catch-all)", () => {
    // The CE0 evidence hook only needs the governed memory pulls, so it carries a
    // meetless-prefix matcher rather than post-tool-use.sh's empty catch-all; the
    // CE0 UserPromptSubmit/Stop hooks ride every prompt/stop (no matcher).
    const ce0Ptu = MANAGED_HOOK_SCRIPTS.find((h) => h.script === "ce0-post-tool-use.sh");
    expect(ce0Ptu?.event).toBe("PostToolUse");
    expect(ce0Ptu?.matcher).toBe("mcp__meetless__");
    const ce0Ups = MANAGED_HOOK_SCRIPTS.find((h) => h.script === "ce0-user-prompt-submit.sh");
    expect(ce0Ups?.event).toBe("UserPromptSubmit");
    expect(ce0Ups?.matcher).toBeUndefined();
    const ce0Stop = MANAGED_HOOK_SCRIPTS.find((h) => h.script === "ce0-stop.sh");
    expect(ce0Stop?.event).toBe("Stop");
    expect(ce0Stop?.matcher).toBeUndefined();
  });

  it("rides the CE0 telemetry-projection hook on SessionStart with a bounded timeout", () => {
    // ce0-session-start.sh projects the two offline §6.4 denominator events on each
    // session start. It carries no matcher (every session start) but DOES carry a
    // timeout: unlike the other three CE0 hooks (pure local SQLite), the sweep ends
    // in a best-effort network flush, so the timeout bounds worst-case session-start
    // latency. The local projection runs synchronously before the flush, so even a
    // timed-out invocation still lands the denominator events in the analytics log.
    const ce0Session = MANAGED_HOOK_SCRIPTS.find((h) => h.script === "ce0-session-start.sh");
    expect(ce0Session?.event).toBe("SessionStart");
    expect(ce0Session?.matcher).toBeUndefined();
    expect(ce0Session?.timeout).toBe(30);
  });
});
