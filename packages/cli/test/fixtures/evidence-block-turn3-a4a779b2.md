
Pending / unconfirmed (retrieved, not accepted):
- [pending][NT:notes/20260518-ask-pipeline-sota-overhaul-proposal-and-review.md] notes/20260518-ask-pipeline-sota-overhaul-proposal-and-review.md: ## Implementation Progress

Track | ID | Task | Status | Notes
A | A1 | AskAnswer contract + validation | DONE | meetless@525efb72 / intel@6fa40ff
A | A2 | LLM query classifier | DONE | `query_classifier.py`: single LLM call fills QueryClassification (A2+A3 share call), 3-rung fallback ladder (llm → regex → hard_default), Langfuse `ask.query_classifier.v1`, settings flag `ask_query_classifier_enabled`, wired into `agentic_service._pre_loop`; 30 tests pass.
A | A3 | LLM answer-type classifier | DONE | Same `query_classifier.py` call (answerType is one of yes_no/freeform/list/number/comparison/not_found in same QueryClassification payload).
A | A4 | LLM yes/no classifier (en+vi) | DONE | `yes_no_extractor.py`: runs on synthesizer's DRAFT (not the user question) gated by `answerType=="yes_no"`; 3-rung ladder (llm → polarity_validator._detect_polarity en+vi → None); Langfuse `ask.yes_no_extractor.v1`; settings flag `ask_yes_no_extractor_enabled`; NEVER raises. Wired into `agentic_service._run_answer_verifier` so the verifier's polarity rule actually has a `yes_no_claim` to validate. Telemetry: `yes_no_claim`, `yes_no_extractor_source`, `yes_no_extractor_latency_ms`. 41 tests pass.
A | A5 | Polarity validator (en+vi) | DONE | `polarity_validator.py`: en+vi affirmative/negative matrices, ambiguous-prefix guard ("Yesterday" ≠ "Yes"), wired into `answer_verifier._polarity_failures` (H2 rule 5); 8 tests pass. A4 now lights up the seam in production.
A | A6 | Note UNKNOWN warning fix | DONE | `meetless/tools/meetless-mcp/status_fallback.js`: extracted from `server.js` for behavioral testability; only NOTE-typed results counted against the SHIPPED threshold (diffs/threads have unrelated lifecycles); warning fires ONLY when at least one returned note's status is OUTSIDE wantedSet (genuine fallback). 25 behavioral tests pin exact warning text + empty `[]` across the result-mix × wanted-statuses × note-status axes.
A | A7 | Lexical mirror regression test | DONE | notes_pipelin...
- [pending][NT:notes/20260804-did-mla-help-session-audit-and-fix-proposal.md] Did MLA help this session? A measured audit, and a fix proposal: # Did MLA help this session? A measured audit, and a fix proposal

**Date**: 2026-08-04
**Session**: `607da042-b692-4cea-8d01-0fd53dee25f3`, 6 operator turns
**Status**: proposal, for review. Two defects already fixed and shipped; the rest is unfunded.
**Doctrine**: `20260704-mla-durable-product-doctrine.md`
- [pending][NT:notes/20260624-notes.md] notes: notes

- [x] [[20260623-final-ai-tinkers-script]] ✅ 2026-06-24
- [ ] public our cli repo #mla
- [ ] make sure auto update work solidly #mla
- [ ] make sure we can be installed with brew, etc #mla
- [ ] review Kiro #mla
- [ ] review posthog's wizard and context-mill #mla
- [ ] ensure that sessions show what we ingest and any interaction that we may have bewteen mla and claude code #mla
- [ ] ensure that mla is helpful on day zero #mla
- [ ] test run prod mla on small greenfield project #mla
- [ ] ensure that langfuse session tracking works correctly #mla
- [ ] think about sending traces to stack trace #mla
- [x] [[20260624-jekyll-island-activities]] ✅ 2026-06-24

- Let's create a comprehensive document on this for further review.
- We have 2 cases of first time users: the very first user of workspace. A new user of an existing workspace.
- Check out our mla onboarding discovery seequence and add it to the doc, + the reference to the discovery doc. I think the autoseed suggestion that you had is already done.
- Is there a cheap way to avoid injection? If not, let's save it for later. We are very early looking for early usage, don't over engineer.
- The drift should already be catched as the agents are making decisons throughout a session, all these decisions are captured and relationships are minted from them. So contradiction should also surface. Validate this for me carefully.
- A lot of what we collect from agent and user interaction are minted right? Add a table in our document on what being collected and what is not, where are room to collecto more. From what I understand, the things that we collected will be mined into claims and relationships, these then directly used in the current session or any other sessions. So human review is not strictly needed. If they are all aligned with each other, then fine. We only need human when there is contradiction. Validate this for me carefully.
- Your research finding should go into the doc as well. They are great.
- How do we prove mla is useful for brown field repo? I have people willing to experiment with it, but I don't know how to leverage them. Have them installed mla and use is clear, but what do we measure? What do we do to make it super intuitive and useful?
