// E24: the trace records what was DELIVERED, not only what was selected.
//
// THE DEFECT (notes/20260809-mla-helpfulness-session-a4a779b2-the-budgeter-miscounts-its-own-items.md
// H4). `governed_kb_trace` carries `retrieved_citations`, `selected_count`,
// `selected_governed_count` and `selected_self_echo_count`. There is no
// `delivered_citations` anywhere in intel or the hook, and every one of those fields is
// computed BEFORE the hook's inline budget takes its cut.
//
// So on session a4a779b2 turn 3, `selected_count: 3`, `context_items[*].injected: true`
// and `hook.layer2_injected: true` all reported a three-document delivery; one document
// arrived. Every helpfulness audit ever published computes its evidence rate from those
// fields, which makes every such rate an upper bound nobody has ever validated. Proving
// the drop required re-running the bash budgeter over an archived sidecar by hand.
//
// `hook.delivered_citations` is the one field that describes the delivery. It is read
// back off the budgeted block through `evidence_item_citations`, which is
// `is_evidence_item_line`, which is the SAME predicate `budget_evidence_markdown`
// segments on: one parser, so a citation is reported delivered exactly when the
// segmenter agreed it was an item and its header survived the cut.
//
// Driven end to end through the REAL hook against a stub intel, in its own process. An
// assertion over a helper function would pass in a session where the field never reached
// the trace, which is precisely the failure mode this suite exists to catch.

import { cleanupHookRuns, envelope, runEnrichHook } from "../helpers/enrich-hook-run";

afterAll(cleanupHookRuns);

describe("E24: hook.delivered_citations names the citations that reached the model", () => {
  jest.setTimeout(60000);

  // THE IDENTITY, not the count. Selected is [A, B, C, ...]; A alone is delivered,
  // because A's body is larger than the whole inline evidence budget. Asserting only
  // "delivered < selected" would pass on a field that named the WRONG survivor, which is
  // exactly what turn 3 did (the one document that arrived was the irrelevant one).
  it("names A when A is delivered and B and C are dropped", async () => {
    const A = "NT:notes/20260101-the-one-that-survives.md";
    const B = "NT:notes/20260102-the-answering-document.md";
    const C = "NT:notes/20260103-also-dropped.md";
    // 40 items so the per-item share falls under `min_share` and the block takes the
    // single global cut, which is the regime where a document can still be lost. A is
    // first and enormous, so the cut lands inside it.
    const items = [
      { source_id: A, text: "A".repeat(12000) },
      { source_id: B, text: "the sentence that answers the prompt" },
      { source_id: C, text: "another candidate" },
      ...Array.from({ length: 37 }, (_, i) => ({
        source_id: `NT:notes/2026020${i % 9}-filler-${i}.md`,
        text: `filler ${i}`,
      })),
    ];
    const { trace, additionalContext } = await runEnrichHook(envelope(items));

    expect(trace.hook.layer2_injected).toBe(true);
    expect(trace.hook.truncated).toBe(true);
    expect(trace.governed_kb_trace.selected_count).toBe(40);

    // The delivery, by name.
    expect(trace.hook.delivered_citations).toEqual([A]);
    // And it agrees with the payload the model actually received.
    expect(additionalContext).toContain(A);
    expect(additionalContext).not.toContain(B);
    expect(additionalContext).not.toContain(C);
    // The OFFER still says all forty, which is the gap the field exists to expose.
    expect(trace.enrichment.context_items).toHaveLength(40);
    expect(trace.enrichment.context_items.map((c: any) => c.source_id)).toContain(B);
  });

  // Not vacuous in the other direction: an uncut turn records the whole selected set,
  // in order. A field that is always a singleton would satisfy the test above.
  it("records the whole selected set, in order, when nothing is cut", async () => {
    const ids = ["NT:notes/20260201-a.md", "NT:notes/20260202-b.md", "NT:notes/20260203-c.md"];
    const { trace } = await runEnrichHook(envelope(ids.map((source_id) => ({ source_id, text: "short body" }))));

    expect(trace.hook.truncated).toBe(false);
    expect(trace.hook.delivered_citations).toEqual(ids);
    expect(trace.hook.delivered_citations).toHaveLength(trace.governed_kb_trace.selected_count);
  });

  // H1 through the trace. Three documents, the third a markdown to-do list whose body is
  // twelve `- [ ]` / `- [x]` lines. Under the old `- [` segmenter this turn recorded
  // `selected_count: 3` and delivered ONE document. The count alone could never have said
  // which one; the identity can.
  it("delivers all three documents of the checklist payload that used to drop two", async () => {
    const ids = [
      "NT:notes/20260518-ask-pipeline-sota-overhaul-proposal-and-review.md",
      "NT:notes/20260804-did-mla-help-session-audit-and-fix-proposal.md",
      "NT:notes/20260624-notes.md",
    ];
    const checklist = [
      "notes: notes",
      "",
      "- [x] [[20260623-final-ai-tinkers-script]] 2026-06-24",
      "- [ ] public our cli repo #mla",
      "- [ ] make sure auto update work solidly #mla",
      "- [ ] make sure we can be installed with brew, etc #mla",
      "- [ ] review Kiro #mla",
      "- [ ] review posthog's wizard and context-mill #mla",
      "- [ ] ensure that mla is helpful on day zero #mla",
      "- [ ] test run prod mla on small greenfield project #mla",
      "- [ ] ensure that langfuse session tracking works correctly #mla",
      "- [x] [[20260624-jekyll-island-activities]] 2026-06-24",
      "- [the discovery doc](notes/20260601-onboarding-discovery.md) is the reference to add.",
    ].join("\n");
    const { trace, additionalContext } = await runEnrichHook(
      envelope([
        { source_id: ids[0], text: "implementation progress table. " + "row of evidence. ".repeat(500) },
        { source_id: ids[1], text: "Did MLA help this session? A measured audit. " + "body of the audit. ".repeat(500) },
        { source_id: ids[2], text: checklist },
      ]),
    );

    expect(trace.hook.truncated).toBe(true);
    expect(trace.hook.delivered_citations).toEqual(ids);
    for (const id of ids) expect(additionalContext).toContain(id);
  });

  // null, not []: "this turn rendered no evidence block" and "a block was rendered and
  // nothing survived the cut" are different facts and must not read the same.
  it("is null on a turn that rendered no evidence block at all", async () => {
    const { trace } = await runEnrichHook(envelope([]));
    expect(trace.hook.layer2_injected).toBe(false);
    expect(trace.hook.delivered_citations).toBeNull();
  });
});
