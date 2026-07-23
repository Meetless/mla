import {
  EDGE_ORIGIN_TIMEOUT_MS,
  INGEST_TIMEOUT_MS,
  INGEST_BATCH_SIZE,
} from "../../src/lib/intel-ingest-budget";
import { PERSIST_BATCH_SIZE } from "../../src/lib/enrichment/ingest";
import { KB_ADD_BATCH_SIZE } from "../../src/commands/kb_add";

// These are fences, not descriptions. Each one pins a relationship that was violated in prod
// (BUG-8, 2026-07-14) and that reads as harmless in a diff.
describe("intel ingest budget", () => {
  it("aborts on our side before the edge severs the connection", () => {
    // The failure this prevents is not "a slow request fails". It is "a slow request fails and
    // the operator is told nothing landed while documents were in fact committed". Losing the
    // race to the edge means the client raises its OWN error naming the batch, instead of an
    // opaque 524 that names nothing. `max(120s, 20s * n)` lost that race at its floor.
    expect(INGEST_TIMEOUT_MS).toBeLessThan(EDGE_ORIGIN_TIMEOUT_MS);
  });

  it("keeps the worst measured request well under the wall", () => {
    // 70.02s was the worst of 65 prod kb/add requests at batches of up to 10 (measured
    // 2026-07-15..21). Per-document worst case is that divided by the old batch size, and the
    // current batch has to fit inside the budget with room for a document heavier than any
    // observed so far. If a future batch size breaks this, re-measure before raising it.
    const worstObservedPerDocMs = 70_020 / 10;
    expect(INGEST_BATCH_SIZE * worstObservedPerDocMs).toBeLessThan(INGEST_TIMEOUT_MS / 2);
  });

  it("is the single source both ingest paths batch against", () => {
    // The bug was not the number. It was that the number, and the reasoning behind it, existed
    // in three hand-maintained copies which therefore drifted together and were wrong together.
    expect(PERSIST_BATCH_SIZE).toBe(INGEST_BATCH_SIZE);
    expect(KB_ADD_BATCH_SIZE).toBe(INGEST_BATCH_SIZE);
  });
});
