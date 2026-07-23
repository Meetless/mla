// The one place the kb/add request budget is derived.
//
// It used to be derived in prose, three separate times (`ingest.ts`, `commands/kb_add.ts`, and
// `commands/enrich.ts`'s own copy of `ingestTimeoutMs`). All three agreed with each other, and
// all three were wrong in the same direction, because they were all derived from the wrong
// ceiling. Three copies is not three checks: it is one mistake with three witnesses.
//
// `intel.meetless.ai` is Cloudflare-proxied in front of Cloud Run. Verify it in one command:
// `curl -sSD- -o/dev/null https://intel.meetless.ai/health` returns `server: cloudflare` and a
// `cf-ray`, AND `via: 1.1 google`. Two hops means two ceilings on one request, and only the
// tighter one can ever fire:
//
//   Cloudflare origin-response timeout    100s   -> client sees 524    <-- BINDING
//   Cloud Run `timeoutSeconds`            300s   -> client sees 504
//
// The old comments sized a 10-document batch at "200s against a 300s ceiling, a full 100s
// under the wall". 200s is 100s OVER the wall that actually fires. A budget written against
// the looser of two ceilings is not a budget; the proxy in front of it was never consulted.
//
// What makes this expensive rather than merely wrong: a severed request is NOT a clean
// failure. `kb_add.py` commits per document as it walks the batch, so the origin keeps working
// and keeps writing after the edge has already handed the client a 524. The client is told
// nothing landed while documents are landing. That false-negative receipt is the whole of
// BUG-8 (2026-07-14, workspace `comb-and-calm`): the report said "0 persisted"; three
// documents were in fact already committed. Retrying is safe only because kb/add is an
// idempotent upsert and a re-sent document comes back `noop_unchanged`.

// The wall. Cloudflare's origin-response timeout on non-Enterprise plans. No client setting
// and no Cloud Run setting can raise it; only a plan change can. It is here so the next person
// sizing a request against intel finds the real number before they find the 300s one.
export const EDGE_ORIGIN_TIMEOUT_MS = 100_000;

// The client's own budget for one kb/add POST. Flat, deliberately: a curve was the original
// error. The binding constraint is a fixed wall, not a per-document allowance, so scaling the
// budget by document count only ever produced numbers on the far side of it (the old
// `max(120s, 20s * docCount)` was already past the wall at its FLOOR, which means the client
// budget could never once have fired first).
//
// What scales with document count is the BATCH SIZE below. That is the knob that actually
// keeps a request under the wall; the timeout's only remaining job is to lose the race to the
// edge on purpose. 90s asks for essentially everything the edge will give and still aborts on
// our side first, so an operator gets `mla`'s own error naming the batch instead of an opaque
// 524 that names nothing.
export const INGEST_TIMEOUT_MS = 90_000;

// How many documents ride in ONE kb/add POST.
//
// Measured, not chosen: since the billing fix landed on 2026-07-14, prod served 65 kb/add
// requests at batches of up to 10, and the worst single request took 70.02s. Against the 300s
// the code believed in, 70s looks like comfort. Against the real 100s wall it is 70% of the
// budget spent, and a repository ~40% heavier than the worst one observed reproduces BUG-8.
//
// 5 halves the worst observed request to roughly 35s, about a third of the wall, and bounds
// the blast radius of any single severed request to five documents instead of ten.
export const INGEST_BATCH_SIZE = 5;
