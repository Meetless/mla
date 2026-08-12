import { mkdtempSync, writeFileSync, existsSync, utimesSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { reapQueue } from "../../src/lib/spool";

// `turn_index` collides within a session, and this reaper is why.
//
// THE MEASUREMENT. Over the live trace corpus on 2026-08-06: 394 colliding
// (session_id, turn_index) pairs, 1,132 of 4,304 traced turns sharing a key with another
// turn, and 160 of 646 sessions affected. That is 24.8% of sessions and 26.3% of turns,
// against a value the codebase treats as a cross-hook JOIN KEY:
//
//   TURN_ID="${SESSION_ID}:${TURN_INDEX}"          user-prompt-submit.sh
//   MCP_TURN_ID="${SESSION_ID}:${MCP_TURN_N}"      post-tool-use.sh
//   key = `${session_id} ${turn_index}`            analytics/followthrough.ts
//   byTurn.get(rec.turn_index)                     analytics/work-product-capture.ts
//
// THE MECHANISM. `next_turn_index` persists the counter in `<session>.turn` and reads a
// missing file as 0, so the next turn is 1. This reaper deletes that file once a session's
// newest file is older than 24h. Its own comment states the assumption:
//
//   "an active session's .jsonl/.turn is rewritten every turn, so the age gate cannot
//    reap a session that is merely between turns"
//
// True only if turns are close together. A Claude Code session is a UUID that a human
// resumes across days: session d629ac1c ran 2026-07-31 to 08-06 with a 43-hour gap, was
// correctly judged dead, was reaped, and then resumed under the SAME id. Its ledger reads
// 1,2,3 then 1,2,3 then 1,2. The reaper is not wrong about liveness; the counter is simply
// not durable across a resume, so every join on (session_id, turn_index) is wrong by
// construction for a resumed session.
//
// THE FIX, chosen over rewriting the joins. `.turn` is the only reaped sidecar whose VALUE
// is an identity other systems join on; every other one (`.lock`, `.touched`, `.repoPath`,
// `.gitBaseline`, `.hb`, spools) is reclaimable state that a resumed session rebuilds. It
// holds a handful of bytes, session ids are UUIDs and never recur, so preserving it costs
// roughly 2 bytes per session forever and keeps the counter monotonic for the whole life
// of that id. Rewriting ~296 call sites and the persisted `<sessionId>:<turnIndex>` wire
// key would be a schema and migration change to fix what one exclusion fixes at the source.
//
// This does NOT repair history. Rows already written with a collided index stay collided,
// which is why analyze.py keys its pull attribution on `trace_id`.

const HOUR = 3600_000;

function seedDeadSession(): { dir: string; sid: string; now: number } {
  const dir = mkdtempSync(join(tmpdir(), "mla-reap-turn-"));
  const sid = "d629ac1c-913c-46ed-a66c-edab1f616071";
  const now = Date.now();
  // 48h idle: unambiguously past the 24h litter gate.
  const old = (now - 48 * HOUR) / 1000;

  for (const [suffix, body] of [
    [".turn", "3"],
    [".lock", ""],
    [".touched", "/repo/a.ts\n"],
    [".repoPath", "/repo\n"],
    [".workspaceId", "ws_1\n"],
  ] as const) {
    const p = join(dir, `${sid}${suffix}`);
    writeFileSync(p, body);
    utimesSync(p, old, old);
  }
  return { dir, sid, now };
}

describe("the reaper preserves the turn counter", () => {
  it("still reaps the rest of a dead session's litter, so this is not a blanket exemption", () => {
    const { dir, sid, now } = seedDeadSession();

    reapQueue({ queueDir: dir, now });

    for (const suffix of [".lock", ".touched", ".repoPath", ".workspaceId"]) {
      expect(existsSync(join(dir, `${sid}${suffix}`))).toBe(false);
    }
  });

  it("keeps <session>.turn, because a resumed session must not restart at 1", () => {
    const { dir, sid, now } = seedDeadSession();

    reapQueue({ queueDir: dir, now });

    expect(existsSync(join(dir, `${sid}.turn`))).toBe(true);
  });

  it("keeps the counter's VALUE, not just the file", () => {
    // An emptied file reads as 0 and hands the next turn index 1, which is the exact
    // collision this exists to prevent. Preserving the path without the value would pass a
    // naive existence check and fix nothing.
    const { dir, sid, now } = seedDeadSession();

    reapQueue({ queueDir: dir, now });

    expect(readFileSync(join(dir, `${sid}.turn`), "utf8").trim()).toBe("3");
  });

  it("does not report the preserved counter as a removed file", () => {
    const { dir, now } = seedDeadSession();

    const result = reapQueue({ queueDir: dir, now });

    expect(result.removedFiles).toBe(4);
  });

  it("leaves a FRESH session completely untouched, counter included", () => {
    const dir = mkdtempSync(join(tmpdir(), "mla-reap-fresh-"));
    const sid = "fresh-session";
    writeFileSync(join(dir, `${sid}.turn`), "7");
    writeFileSync(join(dir, `${sid}.lock`), "");

    const result = reapQueue({ queueDir: dir, now: Date.now() });

    expect(result.skippedFresh).toBe(1);
    expect(existsSync(join(dir, `${sid}.lock`))).toBe(true);
    expect(readFileSync(join(dir, `${sid}.turn`), "utf8")).toBe("7");
  });
});
