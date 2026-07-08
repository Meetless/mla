import { REQUIRED_HOOKS, OPTIONAL_HOOKS, REQUIRED_HOOK_EVENTS } from "../../src/commands/doctor";

// `mla doctor` must SEE the CE0 evidence-consultation measurement harness.
//
// The four ce0-*.sh scripts (ce0-user-prompt-submit.sh / ce0-post-tool-use.sh /
// ce0-stop.sh / ce0-session-start.sh) are installed unconditionally by `mla rewire`
// (unlike post-tool-use.sh, they carry NO opt-out flag). Before this guard a MISSING
// CE0 script was invisible to doctor: it is not in REQUIRED_HOOKS, and the byte
// drift check explicitly ignores absent files ("presence is checked separately").
// An operator who upgraded the binary but never re-ran `mla rewire` would silently
// under-record every turn (the three turn hooks) or stop projecting the §6.4
// denominator events (ce0-session-start.sh) under a GREEN doctor, the exact failure
// mode that made event-batch-filter.jq a REQUIRED hook. So the CE0 scripts belong in
// REQUIRED_HOOKS: surfaced per-script, and RED-on-missing to force the re-rewire.
describe("mla doctor: the CE0 evidence hooks are required, surfaced infra", () => {
  const CE0_SCRIPTS = [
    "ce0-user-prompt-submit.sh",
    "ce0-post-tool-use.sh",
    "ce0-stop.sh",
    "ce0-session-start.sh",
  ];

  it("lists every CE0 hook script as a REQUIRED (RED-on-missing) hook", () => {
    for (const s of CE0_SCRIPTS) {
      expect(REQUIRED_HOOKS).toContain(s);
    }
  });

  it("does NOT treat any CE0 hook as optional (they have no opt-out flag)", () => {
    for (const s of CE0_SCRIPTS) {
      expect(OPTIONAL_HOOKS).not.toContain(s);
    }
  });
});

// A1 made the R1 notes-location pilot LIVE: pre-tool-use.sh is the hook that runs the enforce seam
// and emits the deny on the wire. Like the CE0 scripts it is installed unconditionally by `mla rewire`
// (only PostToolUse carries the --no-post-tool-use opt-out, wire.ts), so a binary upgrade that skipped
// a re-rewire would leave it absent and silently stop enforcing under a GREEN doctor. It is therefore
// a REQUIRED (RED-on-missing) hook, and PreToolUse is a verified registered event.
describe("mla doctor: the live PreToolUse enforcement hook is required, surfaced infra", () => {
  it("lists pre-tool-use.sh as a REQUIRED (RED-on-missing) hook", () => {
    expect(REQUIRED_HOOKS).toContain("pre-tool-use.sh");
  });

  it("does NOT treat pre-tool-use.sh as optional (it has no opt-out flag)", () => {
    expect(OPTIONAL_HOOKS).not.toContain("pre-tool-use.sh");
  });

  it("verifies PreToolUse as a registered hook event (RED-on-missing)", () => {
    expect(REQUIRED_HOOK_EVENTS).toContain("PreToolUse");
  });
});
