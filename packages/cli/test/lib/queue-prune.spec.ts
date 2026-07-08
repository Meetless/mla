import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { planQueuePrune, executeQueuePrune } from "../../src/lib/spool";

const NOW = 1_780_000_000_000;
const DAY = 86_400;

function write(dir: string, name: string, body: string, ageSecAgo: number): void {
  const full = path.join(dir, name);
  fs.writeFileSync(full, body);
  const t = (NOW - ageSecAgo * 1000) / 1000;
  fs.utimesSync(full, t, t);
}

describe("planQueuePrune", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mla-prune-plan-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("includes a dead session with a NON-empty stranded tail (which reapQueue would skip)", () => {
    const sid = "dead-tail";
    write(dir, `${sid}.jsonl`, '{"event":"finalize_requested"}\n{"event":"tool_used_bash"}\n', 3 * DAY);
    write(dir, `${sid}.lock`, "", 3 * DAY);
    write(dir, `${sid}.turn`, "9", 3 * DAY);

    const plan = planQueuePrune({ queueDir: dir, maxAgeSec: DAY, now: NOW });

    expect(plan.candidates).toHaveLength(1);
    const c = plan.candidates[0];
    expect(c.sessionId).toBe(sid);
    expect(c.files).toHaveLength(3);
    expect(c.unflushedEvents).toBe(2);
    expect(plan.totalUnflushedEvents).toBe(2);
    expect(plan.totalFiles).toBe(3);
  });

  it("skips a fresh session (newest file younger than maxAgeSec)", () => {
    const sid = "fresh";
    write(dir, `${sid}.jsonl`, '{"event":"x"}\n', 10 * DAY); // old spool...
    write(dir, `${sid}.turn`, "2", 30); // ...but bumped 30s ago

    const plan = planQueuePrune({ queueDir: dir, maxAgeSec: DAY, now: NOW });

    expect(plan.candidates).toEqual([]);
    expect(plan.skippedFresh).toBe(1);
  });

  it("restricts to one session id when sessionId is passed", () => {
    write(dir, "a.jsonl", '{"event":"x"}\n', 3 * DAY);
    write(dir, "b.jsonl", '{"event":"y"}\n', 3 * DAY);

    const plan = planQueuePrune({ queueDir: dir, maxAgeSec: DAY, now: NOW, sessionId: "a" });

    expect(plan.candidates.map((c) => c.sessionId)).toEqual(["a"]);
  });

  it("returns an empty plan when the queue dir is missing", () => {
    const plan = planQueuePrune({ queueDir: path.join(dir, "nope"), maxAgeSec: DAY, now: NOW });
    expect(plan.candidates).toEqual([]);
    expect(plan.totalFiles).toBe(0);
    expect(plan.oldestAgeSec).toBeNull();
  });
});

describe("executeQueuePrune", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mla-prune-exec-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("deletes every file of each candidate and counts discarded events (flush disabled)", () => {
    const sid = "dead-tail";
    write(dir, `${sid}.jsonl`, '{"event":"a"}\n{"event":"b"}\n', 3 * DAY);
    write(dir, `${sid}.lock`, "", 3 * DAY);
    write(dir, `${sid}.hb`, "1", 3 * DAY);

    const plan = planQueuePrune({ queueDir: dir, maxAgeSec: DAY, now: NOW });
    const res = executeQueuePrune(plan, { flush: false });

    expect(res.prunedSessions).toEqual([sid]);
    expect(res.removedFiles).toBe(3);
    expect(res.discardedEvents).toBe(2);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("is idempotent if a file vanished between plan and execute (counts it recovered)", () => {
    const sid = "racey";
    const jsonl = path.join(dir, `${sid}.jsonl`);
    write(dir, `${sid}.jsonl`, '{"event":"a"}\n', 3 * DAY);
    write(dir, `${sid}.lock`, "", 3 * DAY);

    const plan = planQueuePrune({ queueDir: dir, maxAgeSec: DAY, now: NOW });
    fs.rmSync(jsonl, { force: true }); // simulate a flush self-cleaning it first

    const res = executeQueuePrune(plan, { flush: false });
    expect(res.removedFiles).toBe(1); // only the .lock remained
    expect(res.recoveredFiles).toBe(1); // the .jsonl was already gone
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
