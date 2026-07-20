# Fixture: a governed change with Codex

This is the reproducible demo behind the Meetless Codex connector. It shows Codex
doing a normal coding task while Meetless (mla) governs it in-context: Codex
retrieves a superseding decision it would otherwise have missed, and a
documentation-location rule blocks a bad write before it executes.

One task, one coherent workflow, one real hard block. Under three minutes.

## The workflow (7 steps)

1. Codex is asked to implement a feature **based on a stale ADR**
   (`docs/adr/0007-webhook-retry-policy.md`, which says "retry on a fixed
   30-second interval").
2. The **MLA floor** (injected on `UserPromptSubmit`) leads Codex to **retrieve
   the superseding decision** through governed retrieval
   (`meetless__retrieve_knowledge`): the retry policy was changed to exponential
   backoff with jitter after an incident.
3. Codex **changes its plan** to match the current decision.
4. During the same task, Codex attempts to **write its Markdown design note under
   the prohibited `notes/` directory**.
5. MLA **blocks that write before it executes** (the notes-location rule, with
   the enforcement ceiling raised for this session).
6. Codex **writes to the approved location** (`docs/decisions/`) instead.
7. The denied attempt **appears in `mla enforcement`** as an audited incident.

Every step is mechanically proven. Whether the model changes course on the
retrieved context (steps 2-3) is a property of the model, exercised live at demo
time.

## Layout

```
codex-governed-change/
  TASK.md                              the prompt you give Codex
  docs/adr/0007-webhook-retry-policy.md  the STALE ADR (fixed interval)
  docs/decisions/                      the APPROVED doc location (corrected write lands here)
  notes/                               the PROHIBITED doc location (write here is blocked)
  governance/
    superseding-decision.md            the current decision, seeded into governed memory
    notes-location.md                  the one rule the demo's hard block relies on
  seed.sh                              seed the superseding decision into governed memory
  reset.sh                             remove it again (repeatable demo)
  expected-output.md                   what the retrieval, the deny, and the incident look like
```

## Prerequisites

- The `mla` CLI on your `PATH`, authenticated (`mla login` or `mla init`).
- The Codex connector installed: `mla codex install`, then grant trust in Codex
  with `/hooks`. Until you grant trust, hooks are skipped and governance is
  inactive (fail-open).
- The Meetless MCP plugin registered so Codex can retrieve
  (`codex plugin add mla@meetless`), and the repo bound with `mla activate`.
- A reachable backend: the hosted judge environment, or local Control + Intel.
- The **notes-location** rule active in the workspace (see
  `governance/notes-location.md`). In the hosted judge environment it is
  pre-seeded.

## Run it

```sh
# 1. Bind this fixture as its own repo and seed the current decision.
mla activate
./seed.sh
# (optional) accept the seeded claim so it is trusted, not just served:
#   mla kb claims --pending
#   mla kb accept <claimId>

# 2. Raise the enforcement ceiling for this session so the notes-location rule
#    can hard-block (see "Enforcement ceiling" below), then start Codex.
export MEETLESS_ACTION_INTERCEPT_MAX=deny
codex

# 3. In Codex, give it the task:
#      Implement the webhook retry policy as described in TASK.md.
#    Watch it retrieve the superseding decision, implement exponential backoff,
#    attempt to write a note under notes/, get blocked, and write to
#    docs/decisions/ instead.

# 4. See the audited block.
mla enforcement --all

# 5. Reset to run again. This clears only the files Codex wrote; the seeded
#    decision stays in governed memory (durable by design), so no re-seed.
./reset.sh
```

`expected-output.md` shows the retrieval hit, the deny envelope, and the incident
line so you know what a successful run looks like.

## Enforcement ceiling (read this; it is not in the demo video)

Meetless ships **WARN as the default enforcement ceiling**. By default a rule,
including a decision contradiction, surfaces evidence and warns; it does not
block. That is a deliberate product decision: adoption ramps from "notify and
acknowledge" to "block," and shipping silent hard blocks first would erode trust.

The notes-location rule is the one family that can **hard-deny before execution**,
and only when the session raises the ceiling:

```
MEETLESS_ACTION_INTERCEPT_MAX=deny     # observe | warn | ask | deny
```

The demo raises the ceiling for exactly this rule so the block is real and
visible. This is why the honest framing of the demo is:

> MLA surfaced the current decision through governed retrieval. The hard block
> shown here enforces the approved documentation-location rule. General decision
> contradictions are currently advisory by default.

We do not overclaim. The retrieval is real, the block is real, and the default
enforcement posture is advisory.

## Notes on seeding and reset

`seed.sh` points the KB vault root at this fixture directory
(`MEETLESS_NOTES_ROOT`) so the seeded decision lands with a self-contained,
purgeable identity (`notes/governance/superseding-decision.md`) and never touches
any real notes vault. Accepting a claim is a human verdict by design, so the
script seeds (which grounds retrieval immediately) and prints the accept command
rather than accepting on your behalf.

Governed memory is **durable**. The first `seed.sh` reports `ingested`; a re-run
reports `noop_unchanged`, which is expected, not a failure: the governed front
door is a content-addressed upsert with no restore branch, so identical bytes are
recognized and left as-is. You do **not** re-seed between demo runs. `reset.sh`
clears only the Markdown Codex wrote (under `docs/decisions/`, and any stray file
under `notes/` from an advisory-mode run), leaving the seeded decision in place so
retrieval stays grounded.

To fully retire the governed record from a scratch workspace, `reset.sh` prints an
`mla kb purge` command. Two honest caveats: slice A has no un-purge and re-adding
identical bytes is a `noop_unchanged` (edit the decision file first to re-ground),
and the authoritative serving state is `mla kb show` (`serving: NO` once
tombstoned) because the shadow retrieval index can briefly lag a tombstone.
