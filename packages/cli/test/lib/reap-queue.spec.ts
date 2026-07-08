import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { reapQueue } from "../../src/lib/spool";

// RC2 (stale-session reaper): age-gated cleanup of dead-session litter.
//
// Why it exists: nothing in the hook pipeline ever removes the per-session
// sidecars (`.lock`, `.turn`, `.repoPath`, `.gitBaseline`). `.repoPath` /
// `.gitBaseline` are dropped only on a SUCCESSFUL finalize; `.lock` / `.turn`
// are never dropped at all. A session that drains its events but never cleanly
// finalizes (crash, laptop sleep, control down at the time) leaves them behind
// forever. On the dogfood box this was 99 `.lock` + 40 `.turn` + 23 `.repoPath`
// + 8 `.gitBaseline` against 12 live spools.
//
// The safety rule: pending work (a non-empty `.jsonl` = events that never reached
// control, or a `.jsonl.draining.*` = an interrupted flush's snapshot) is normally
// untouchable -- reaping it is silent data loss. So a session with pending work is
// refused (skippedPending) until it crosses the FAR longer stranded gate
// (strandedMaxAgeSec, 7d). Past that gate the session is certainly dead (an active
// session rewrites its `.turn`/`.hb` every turn, so a 7d-stale newest-mtime cannot
// be live) and its events are undeliverable, so it is reclaimed (strandedReaped)
// and its discarded event count reported. A no-pending session stays reapable once
// its NEWEST file is older than the ordinary maxAgeSec (24h) litter gate.

function touch(file: string, ageSecAgo: number, now: number): void {
  const t = (now - ageSecAgo * 1000) / 1000; // utimes wants seconds
  fs.utimesSync(file, t, t);
}

function write(queueDir: string, name: string, body: string, ageSecAgo: number, now: number): string {
  const full = path.join(queueDir, name);
  fs.writeFileSync(full, body);
  touch(full, ageSecAgo, now);
  return full;
}

const NOW = 1_780_000_000_000; // fixed wall clock for deterministic age math
const DAY = 86_400;

describe("reapQueue (RC2 stale-session reaper)", () => {
  let queueDir: string;

  beforeEach(() => {
    queueDir = fs.mkdtempSync(path.join(os.tmpdir(), "mla-reap-"));
  });
  afterEach(() => {
    fs.rmSync(queueDir, { recursive: true, force: true });
  });

  it("reaps a fully-idle session: empty spool + all sidecars older than maxAgeSec", () => {
    const sid = "dead-1";
    write(queueDir, `${sid}.jsonl`, "", 2 * DAY, NOW); // 0-byte spool
    write(queueDir, `${sid}.lock`, "", 2 * DAY, NOW);
    write(queueDir, `${sid}.turn`, "7", 2 * DAY, NOW);
    write(queueDir, `${sid}.repoPath`, "/tmp/x", 2 * DAY, NOW);
    write(queueDir, `${sid}.gitBaseline`, "abc", 2 * DAY, NOW);
    write(queueDir, `${sid}.workspaceId`, "ws_x", 2 * DAY, NOW); // T1.2 marker-id sidecar

    const r = reapQueue({ queueDir, maxAgeSec: DAY, now: NOW });

    expect(r.reaped).toEqual([sid]);
    expect(r.removedFiles).toBe(6);
    expect(fs.readdirSync(queueDir)).toEqual([]);
  });

  it("refuses a session with a non-empty spool while within the stranded gate (no data loss)", () => {
    const sid = "pending-1";
    // 3d idle: past the 24h litter gate but far short of the 7d stranded gate, so
    // its undelivered events are still protected.
    write(queueDir, `${sid}.jsonl`, '{"event":"session_started"}\n', 3 * DAY, NOW);
    write(queueDir, `${sid}.lock`, "", 3 * DAY, NOW);
    write(queueDir, `${sid}.turn`, "3", 3 * DAY, NOW);

    const r = reapQueue({ queueDir, maxAgeSec: DAY, now: NOW });

    expect(r.reaped).toEqual([]);
    expect(r.strandedReaped).toEqual([]);
    expect(r.skippedPending).toBe(1);
    expect(fs.existsSync(path.join(queueDir, `${sid}.jsonl`))).toBe(true);
    expect(fs.existsSync(path.join(queueDir, `${sid}.lock`))).toBe(true);
    expect(fs.existsSync(path.join(queueDir, `${sid}.turn`))).toBe(true);
  });

  it("refuses a session with a draining snapshot while within the stranded gate", () => {
    const sid = "draining-1";
    write(queueDir, `${sid}.jsonl`, "", 3 * DAY, NOW); // empty live file
    write(queueDir, `${sid}.jsonl.draining.4242`, '{"event":"tool_used_bash"}\n', 3 * DAY, NOW);
    write(queueDir, `${sid}.lock`, "", 3 * DAY, NOW);

    const r = reapQueue({ queueDir, maxAgeSec: DAY, now: NOW });

    expect(r.reaped).toEqual([]);
    expect(r.strandedReaped).toEqual([]);
    expect(r.skippedPending).toBe(1);
    expect(fs.existsSync(path.join(queueDir, `${sid}.jsonl.draining.4242`))).toBe(true);
  });

  it("reclaims a non-empty spool once past the 7d stranded gate, counting discarded events", () => {
    const sid = "stranded-1";
    // 8d idle: no live session could have a newest-mtime this stale. The two
    // undelivered events can never drain (no workspace target), so they are
    // discarded and counted.
    write(queueDir, `${sid}.jsonl`, '{"event":"a"}\n{"event":"b"}\n', 8 * DAY, NOW);
    write(queueDir, `${sid}.lock`, "", 8 * DAY, NOW);
    write(queueDir, `${sid}.turn`, "9", 8 * DAY, NOW);

    const r = reapQueue({ queueDir, maxAgeSec: DAY, now: NOW });

    expect(r.reaped).toEqual([sid]);
    expect(r.strandedReaped).toEqual([sid]);
    expect(r.discardedEvents).toBe(2);
    expect(r.skippedPending).toBe(0);
    expect(fs.readdirSync(queueDir)).toEqual([]);
  });

  it("reclaims a stranded draining snapshot past the 7d gate and counts only its events", () => {
    const sid = "stranded-drain-1";
    write(queueDir, `${sid}.jsonl`, "", 8 * DAY, NOW); // empty live file (0 events)
    write(
      queueDir,
      `${sid}.jsonl.draining.4242`,
      '{"event":"x"}\n{"event":"y"}\n{"event":"z"}\n',
      8 * DAY,
      NOW,
    );
    write(queueDir, `${sid}.lock`, "", 8 * DAY, NOW);

    const r = reapQueue({ queueDir, maxAgeSec: DAY, now: NOW });

    expect(r.strandedReaped).toEqual([sid]);
    expect(r.discardedEvents).toBe(3); // only the draining snapshot carried events
    expect(fs.existsSync(path.join(queueDir, `${sid}.jsonl.draining.4242`))).toBe(false);
  });

  it("honors an explicit strandedMaxAgeSec override for the reclaim boundary", () => {
    const sid = "stranded-cfg-1";
    write(queueDir, `${sid}.jsonl`, '{"event":"a"}\n', 3 * DAY, NOW); // 3d old

    // Default 7d gate would refuse this 3d spool...
    expect(reapQueue({ queueDir, maxAgeSec: DAY, now: NOW }).skippedPending).toBe(1);
    // ...but a 2d override reclaims it.
    const r = reapQueue({ queueDir, maxAgeSec: DAY, strandedMaxAgeSec: 2 * DAY, now: NOW });
    expect(r.strandedReaped).toEqual([sid]);
    expect(r.discardedEvents).toBe(1);
  });

  it("does NOT reap a content-reapable session that is still fresh (newest file < maxAgeSec)", () => {
    const sid = "fresh-1";
    write(queueDir, `${sid}.jsonl`, "", 10 * DAY, NOW); // old empty spool...
    write(queueDir, `${sid}.turn`, "12", 30, NOW); // ...but turn counter bumped 30s ago
    write(queueDir, `${sid}.lock`, "", 30, NOW);

    const r = reapQueue({ queueDir, maxAgeSec: DAY, now: NOW });

    expect(r.reaped).toEqual([]);
    expect(r.skippedFresh).toBe(1);
    expect(fs.existsSync(path.join(queueDir, `${sid}.turn`))).toBe(true);
  });

  it("honors MEETLESS_QUEUE_GC_MAX_AGE_SEC when maxAgeSec is not passed explicitly", () => {
    const sid = "envgated-1";
    write(queueDir, `${sid}.lock`, "", 2 * 3600, NOW); // 2h old
    write(queueDir, `${sid}.turn`, "1", 2 * 3600, NOW);

    const prev = process.env.MEETLESS_QUEUE_GC_MAX_AGE_SEC;
    try {
      process.env.MEETLESS_QUEUE_GC_MAX_AGE_SEC = String(3600); // 1h gate
      const r = reapQueue({ queueDir, now: NOW });
      expect(r.reaped).toEqual([sid]);
    } finally {
      if (prev === undefined) delete process.env.MEETLESS_QUEUE_GC_MAX_AGE_SEC;
      else process.env.MEETLESS_QUEUE_GC_MAX_AGE_SEC = prev;
    }
  });

  it("leaves unrecognized files untouched (only ever removes known queue artifacts)", () => {
    write(queueDir, "README.txt", "not ours", 10 * DAY, NOW);
    write(queueDir, "stray.json", "{}", 10 * DAY, NOW);

    const r = reapQueue({ queueDir, maxAgeSec: DAY, now: NOW });

    expect(r.reaped).toEqual([]);
    expect(r.removedFiles).toBe(0);
    expect(fs.existsSync(path.join(queueDir, "README.txt"))).toBe(true);
    expect(fs.existsSync(path.join(queueDir, "stray.json"))).toBe(true);
  });

  it("reaps only the eligible sessions in a mixed dir and reports accurate counts", () => {
    // dead: reapable
    write(queueDir, "dead.lock", "", 5 * DAY, NOW);
    write(queueDir, "dead.turn", "2", 5 * DAY, NOW);
    write(queueDir, "dead.repoPath", "/tmp/d", 5 * DAY, NOW);
    // live: non-empty spool -> pending
    write(queueDir, "live.jsonl", '{"event":"prompt_submitted"}\n', 5 * DAY, NOW);
    write(queueDir, "live.lock", "", 5 * DAY, NOW);
    // recent: fresh
    write(queueDir, "recent.lock", "", 10, NOW);

    const r = reapQueue({ queueDir, maxAgeSec: DAY, now: NOW });

    expect(r.reaped).toEqual(["dead"]);
    expect(r.removedFiles).toBe(3);
    expect(r.skippedPending).toBe(1);
    expect(r.skippedFresh).toBe(1);
    expect(fs.existsSync(path.join(queueDir, "live.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(queueDir, "recent.lock"))).toBe(true);
    expect(fs.existsSync(path.join(queueDir, "dead.lock"))).toBe(false);
  });

  it("returns an empty result when the queue dir does not exist", () => {
    const missing = path.join(queueDir, "nope");
    const r = reapQueue({ queueDir: missing, maxAgeSec: DAY, now: NOW });
    expect(r.reaped).toEqual([]);
    expect(r.removedFiles).toBe(0);
  });

  // dryRun: count reapable debt without unlinking anything. The doctor uses
  // this for a read-only "you have N reapable stale sessions" line; doctor must
  // never mutate the queue, so the counts must be identical to a real reap but
  // every file must survive on disk.
  it("dryRun reports the same counts as a real reap but removes nothing", () => {
    const sid = "dead-dry";
    write(queueDir, `${sid}.jsonl`, "", 2 * DAY, NOW);
    write(queueDir, `${sid}.lock`, "", 2 * DAY, NOW);
    write(queueDir, `${sid}.turn`, "7", 2 * DAY, NOW);
    // a pending + a fresh session to exercise the skip counters too
    write(queueDir, "pending.jsonl", '{"event":"x"}\n', 5 * DAY, NOW);
    write(queueDir, "fresh.lock", "", 10, NOW);

    const dry = reapQueue({ queueDir, maxAgeSec: DAY, now: NOW, dryRun: true });
    expect(dry.reaped).toEqual([sid]);
    expect(dry.removedFiles).toBe(3);
    expect(dry.skippedPending).toBe(1);
    expect(dry.skippedFresh).toBe(1);
    // nothing actually removed
    expect(fs.existsSync(path.join(queueDir, `${sid}.lock`))).toBe(true);
    expect(fs.existsSync(path.join(queueDir, `${sid}.turn`))).toBe(true);
    expect(fs.existsSync(path.join(queueDir, `${sid}.jsonl`))).toBe(true);

    // a real reap right after should match the dryRun counts and actually remove
    const real = reapQueue({ queueDir, maxAgeSec: DAY, now: NOW });
    expect(real.reaped).toEqual(dry.reaped);
    expect(real.removedFiles).toBe(dry.removedFiles);
    expect(fs.existsSync(path.join(queueDir, `${sid}.lock`))).toBe(false);
  });

  // The doctor surfaces stranded-reclaim debt from a dryRun reap, so dryRun must
  // report strandedReaped + discardedEvents accurately WITHOUT deleting anything.
  it("dryRun reports stranded reclaim counts without deleting (doctor debt probe)", () => {
    const sid = "stranded-dry";
    write(queueDir, `${sid}.jsonl`, '{"event":"a"}\n{"event":"b"}\n', 8 * DAY, NOW);
    write(queueDir, `${sid}.lock`, "", 8 * DAY, NOW);

    const dry = reapQueue({ queueDir, maxAgeSec: DAY, now: NOW, dryRun: true });
    expect(dry.strandedReaped).toEqual([sid]);
    expect(dry.discardedEvents).toBe(2);
    // nothing actually removed
    expect(fs.existsSync(path.join(queueDir, `${sid}.jsonl`))).toBe(true);
    expect(fs.existsSync(path.join(queueDir, `${sid}.lock`))).toBe(true);
  });
});
