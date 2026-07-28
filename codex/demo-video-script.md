# Demo video script (Codex connector)

Target length **2:45** (hard ceiling 3:00). One integrated governed-change
workflow. One real hard block. No feature menu.

## Before you hit record (do NOT film this part)

- `mla login` (or `mla init`) and a reachable backend (hosted judge env or local
  Control plus Intel).
- Codex connector installed (`mla codex install`) and hook trust granted in
  Codex (`/hooks`). Governance is inactive until trust is granted, so verify it
  once off camera.
- Seed the fixture and raise the cap in the shell you will film:
  ```sh
  cd examples/codex-governed-change
  ./seed.sh
  export MEETLESS_ACTION_INTERCEPT_MAX=deny
  ```
- Large terminal font. Nothing on screen that leaks a credential, an absolute
  home path, or the private judge instructions.
- **Never on camera:** the enforcement-ceiling ladder (observe, warn, ask,
  deny), any token, or the private judge URL. Those live in the README only.

## The one line that MUST be spoken verbatim (over Scene 4)

> MLA surfaced the current decision through governed retrieval. The hard block
> shown here enforces the approved documentation-location rule. General decision
> contradictions are currently advisory by default.

---

## Scene 1: Setup (0:00 to 0:25)

**On screen:** title card "Governed coding for Codex", then a split of
`docs/adr/0007-webhook-retry-policy.md` (the stale ADR) and `TASK.md`.

**Narration:**
> This is the Codex CLI, governed by Meetless. Here is a real trap: an old ADR
> says retry webhooks on a fixed thirty-second interval. That policy was
> changed after an incident, but the ADR was never updated. I ask Codex to
> implement the ADR as written.

## Scene 2: Grounding by governed retrieval (0:25 to 1:15)

**On screen:** type the task into Codex:
`Implement the webhook retry policy as described in TASK.md.`
Show Codex calling `meetless__retrieve_knowledge` and the superseding decision
coming back (exponential backoff with jitter, fixed interval prohibited). Show
Codex revising its plan.

**Narration:**
> On my prompt, Meetless injects its governance floor. Codex retrieves the
> current decision through governed knowledge and sees that the fixed interval
> is superseded by exponential backoff with jitter. It changes its plan to match
> the decision that is actually in force, not the stale ADR.

## Scene 3: The pre-execution hard block (1:15 to 2:15)

**On screen:** Codex, mid-task, tries to write its design note under `notes/`.
Show the deny surfacing to Codex (the reason is visible), the write NOT
happening, and Codex then writing to `docs/decisions/` instead.

**Narration:**
> Now Codex tries to drop its design note under notes slash. Meetless blocks
> that write before it executes and tells Codex why. Codex reads the reason and
> writes to the approved docs slash decisions location instead. Nothing wrong
> ever hit disk.

## Scene 4: The audited incident, and the honest claim (2:15 to 2:45)

**On screen:** run `mla enforcement --all`; the denied attempt appears as an
audited incident (rule: notes-location).

**Narration (the first three sentences are verbatim, then close):**
> MLA surfaced the current decision through governed retrieval. The hard block
> shown here enforces the approved documentation-location rule. General decision
> contradictions are currently advisory by default. Every block is audited, and
> this connector is built with Codex and governs Codex, using the same core that
> already governs Claude Code.

**End card:** "Meetless Codex connector. Developer Tools. Built with GPT-5.6."

---

## Shot list checklist

- [ ] Stale ADR and TASK visible (Scene 1)
- [ ] `meetless__retrieve_knowledge` call and the superseding decision (Scene 2)
- [ ] Codex revises its plan (Scene 2)
- [ ] Deny surfaces with a reason; the `notes/` write does not happen (Scene 3)
- [ ] Codex writes to `docs/decisions/` instead (Scene 3)
- [ ] `mla enforcement --all` shows the incident (Scene 4)
- [ ] Verbatim narration spoken over Scene 4
- [ ] No enforcement ceiling ladder, token, or private URL anywhere on screen
- [ ] Total runtime under 3:00
