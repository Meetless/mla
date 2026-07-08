import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { queueDepth } from "../../src/lib/spool";

// Behavioral lock for `mla doctor` queue-depth visibility into orphan
// drains (Wedge v6 Epoch 23).
//
// queueDepth() reports oldestAgeSec as the stuck-queue tripwire. The
// previous implementation only updated oldestMs for live `.jsonl` files;
// `.jsonl.draining.*` mtimes never moved the dial. But the most common
// stuck condition is the opposite: a flush.sh that crashed mid-rename,
// leaving the live file gone and only a draining-suffixed remnant
// behind. Pre-fix, an operator with N orphan drains stranded for hours
// saw "queue depth: 0 active sessions, X events, N orphan snapshots,
// oldest age n/a s" and called doctor GREEN. This spec pins the
// orphan-age trip-wire so the regression cannot return.

function mkqueue(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mla-spool-"));
  return dir;
}

function writeWithMtime(p: string, contents: string, mtimeMs: number): void {
  fs.writeFileSync(p, contents);
  const sec = mtimeMs / 1000;
  fs.utimesSync(p, sec, sec);
}

describe("queueDepth", () => {
  it("returns the empty shape when the queue dir does not exist", () => {
    const missing = path.join(os.tmpdir(), `mla-spool-missing-${Date.now()}`);
    expect(queueDepth(missing)).toEqual({
      sessions: 0,
      events: 0,
      orphans: 0,
      oldestAgeSec: null,
    });
  });

  it("counts live .jsonl events and surfaces the oldest mtime", () => {
    const dir = mkqueue();
    const now = Date.now();
    writeWithMtime(path.join(dir, "sess_a.jsonl"), '{"a":1}\n{"a":2}\n', now - 10_000);
    writeWithMtime(path.join(dir, "sess_b.jsonl"), '{"b":1}\n', now - 1_000);
    const d = queueDepth(dir);
    expect(d.sessions).toBe(2);
    expect(d.events).toBe(3);
    expect(d.orphans).toBe(0);
    // 10s ago, allow +/- 1s slop for clock granularity.
    expect(d.oldestAgeSec).not.toBeNull();
    expect(d.oldestAgeSec!).toBeGreaterThanOrEqual(9);
    expect(d.oldestAgeSec!).toBeLessThanOrEqual(12);
  });

  it("counts events from orphan .jsonl.draining files toward total", () => {
    const dir = mkqueue();
    const now = Date.now();
    writeWithMtime(path.join(dir, "sess_a.jsonl"), '{"a":1}\n', now - 1_000);
    writeWithMtime(
      path.join(dir, "sess_a.jsonl.draining.1700000000"),
      '{"x":1}\n{"x":2}\n{"x":3}\n',
      now - 1_000,
    );
    const d = queueDepth(dir);
    expect(d.orphans).toBe(1);
    expect(d.events).toBe(4);
  });

  // The trap this epoch closed. A queue with NO live .jsonl but a
  // stranded `.jsonl.draining.*` from a crashed flush MUST report a
  // non-null oldest age so the doctor flags it. Pre-fix, oldestMs only
  // moved on .jsonl files, so this case returned `oldestAgeSec: null`
  // and the doctor card read "oldest age n/a s" -- visually identical
  // to an empty queue.
  it("surfaces the orphan-only drain age (regression: pre-fix returned null)", () => {
    const dir = mkqueue();
    const now = Date.now();
    writeWithMtime(
      path.join(dir, "sess_x.jsonl.draining.1700000000"),
      '{"y":1}\n',
      now - 7_200_000, // two hours ago
    );
    const d = queueDepth(dir);
    expect(d.sessions).toBe(1);
    expect(d.orphans).toBe(1);
    expect(d.oldestAgeSec).not.toBeNull();
    expect(d.oldestAgeSec!).toBeGreaterThanOrEqual(7_000);
  });

  it("uses the MIN of live + orphan mtimes (the older one wins)", () => {
    const dir = mkqueue();
    const now = Date.now();
    // live file young, orphan file ancient -- orphan must dominate
    writeWithMtime(path.join(dir, "sess_a.jsonl"), '{"a":1}\n', now - 1_000);
    writeWithMtime(
      path.join(dir, "sess_b.jsonl.draining.1700000000"),
      '{"b":1}\n',
      now - 60_000,
    );
    const d = queueDepth(dir);
    expect(d.oldestAgeSec!).toBeGreaterThanOrEqual(55);
    expect(d.oldestAgeSec!).toBeLessThanOrEqual(70);
  });

  it("ignores unrelated files in the queue dir", () => {
    const dir = mkqueue();
    fs.writeFileSync(path.join(dir, "README"), "not a session");
    fs.writeFileSync(path.join(dir, "scratch.txt"), "ignore me");
    const d = queueDepth(dir);
    expect(d.sessions).toBe(0);
    expect(d.events).toBe(0);
    expect(d.orphans).toBe(0);
    expect(d.oldestAgeSec).toBeNull();
  });
});
