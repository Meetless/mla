// tools/meetless-agent/test/lib/active-memory.spec.ts
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { reduceActiveMemory, ActiveMemoryRecord } from "../../src/lib/active-memory";

function rec(p: Partial<ActiveMemoryRecord>): ActiveMemoryRecord {
  return {
    ts: "2026-06-04T00:00:00Z",
    event: "active_memory_record",
    workspaceId: "ws_1",
    ownerUserId: "user_a",
    repoRootHash: "repoA",
    canonicalPath: "notes/x.md",
    contentHash: "h1",
    sessionId: "sess_1",
    turnIndex: 1,
    sourceProduct: "claude_code",
    kind: "produced_doc",
    createdAt: "2026-06-04T00:00:00Z",
    ...p,
  };
}

function storeFrom(records: ActiveMemoryRecord[]): string {
  const dir = mkdtempSync(join(tmpdir(), "am-"));
  const file = join(dir, "kb-knowledge.jsonl");
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

const NOW = Date.parse("2026-06-04T00:00:10Z");

describe("active-memory reduce", () => {
  it("turn debounce (test 3): three edits to one path in one turn collapse to the final content", () => {
    const file = storeFrom([
      rec({ contentHash: "h1", turnIndex: 5 }),
      rec({ contentHash: "h2", turnIndex: 5 }),
      rec({ contentHash: "h3", turnIndex: 5 }),
    ]);
    const out = reduceActiveMemory(file, { nowMs: NOW, ttlHours: 48, maxRecords: 100 });
    expect(out).toHaveLength(1);
    expect(out[0].contentHash).toBe("h3");
  });

  it("content-hash dedup (test 4): identical content across turns does not produce two candidates", () => {
    const file = storeFrom([rec({ contentHash: "h1", turnIndex: 1 }), rec({ contentHash: "h1", turnIndex: 2 })]);
    expect(reduceActiveMemory(file, { nowMs: NOW, ttlHours: 48, maxRecords: 100 })).toHaveLength(1);
  });

  it("path-collision isolation (test 5): two repoRootHashes do not dedup together", () => {
    const file = storeFrom([rec({ repoRootHash: "repoA" }), rec({ repoRootHash: "repoB" })]);
    expect(reduceActiveMemory(file, { nowMs: NOW, ttlHours: 48, maxRecords: 100 })).toHaveLength(2);
  });

  it("TTL eviction (test 6): an expired entry is not returned", () => {
    const old = new Date(NOW - 72 * 3600 * 1000).toISOString();
    const file = storeFrom([rec({ createdAt: old, ts: old })]);
    expect(reduceActiveMemory(file, { nowMs: NOW, ttlHours: 48, maxRecords: 100 })).toHaveLength(0);
  });

  it("cross-owner dedup isolation (test 32): same path+content, two owners, two records", () => {
    const file = storeFrom([rec({ ownerUserId: "user_a" }), rec({ ownerUserId: "user_b" })]);
    expect(reduceActiveMemory(file, { nowMs: NOW, ttlHours: 48, maxRecords: 100 })).toHaveLength(2);
  });

  it("caps: keeps only the most recent maxRecords after dedup", () => {
    const recs = Array.from({ length: 5 }, (_, i) => rec({ canonicalPath: `notes/${i}.md`, turnIndex: i }));
    expect(reduceActiveMemory(storeFrom(recs), { nowMs: NOW, ttlHours: 48, maxRecords: 3 })).toHaveLength(3);
  });

  it("sessionId filter is applied BEFORE dedup, so a later other-session record cannot evict this session's", () => {
    // Same path+content under two sessions. Without pre-dedup scoping, the
    // content-hash dedup would collapse to the later (other-session) record and
    // session-scoped auto-index would see nothing. The filter keeps s1's record.
    const file = storeFrom([rec({ sessionId: "s1" }), rec({ sessionId: "other" })]);
    const out = reduceActiveMemory(file, { nowMs: NOW, ttlHours: 48, maxRecords: 100, sessionId: "s1" });
    expect(out).toHaveLength(1);
    expect(out[0].sessionId).toBe("s1");
  });

  it("no sessionId option preserves prior behavior (cross-session content dedup still collapses)", () => {
    const file = storeFrom([rec({ sessionId: "s1" }), rec({ sessionId: "other" })]);
    expect(reduceActiveMemory(file, { nowMs: NOW, ttlHours: 48, maxRecords: 100 })).toHaveLength(1);
  });
});
