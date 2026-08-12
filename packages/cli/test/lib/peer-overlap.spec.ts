// F1: report concurrent sessions that touched the same paths.
//
// THE DEFECT (notes/20260809-mla-session-c7fa280f-the-collision-it-could-not-see.md D1).
// At 16:00:11 a peer session created `src/hook-entry.ts`. At 16:01:56 this session created
// `src/redact-entry.ts`. Same repository, same hook, same latency defect, same design, two
// minutes apart. The overlap was already on local disk -- every session appends what it
// touched to `~/.meetless/queue/<sid>.touched` -- and nothing read a sibling ledger, so
// roughly 40 minutes of duplicated implementation was discovered by running `git status`.
//
// WHAT THIS IS NOT, and every one of these is pinned below rather than left to a comment.
// It is not the 2026-07-27 working-tree delta coming back: that fix was right and stays.
// Peer paths are a SEPARATE block and never merge into `touched_files:` (which remains
// exact self-attribution). It is not a lock, a reservation, a severity or a gate. It does
// not claim another session is editing anything, is still running, or is duplicating this
// session's work; it reports a file WRITE that already happened.
//
// AND IT DOES NOT CLAIM THE PATH IS RECENT. Eligibility is one `find -mmin` over the ledger
// FILE, so the window bounds that session's most recent write of anything at all. The block
// says the LEDGER is recent and that the ledger "has also touched" the listed paths; a listed
// path may have been written much earlier in that session. Per-path timestamps would be a
// ledger schema change on a hot append-only path, so the sentence narrows instead.
//
// THE IDENTITY PREDICATE IS THE PHYSICAL PATH. `record_touched_file` resolves each path
// through `pwd -P` before appending, so an identical string means an identical file on
// this machine. The same relative path in another checkout, or in an independent git
// worktree of the SAME repository, is a different absolute path and therefore not a
// collision -- both are pinned, because a worktree is the case that looks like a collision
// and is not.

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { cleanupHookRuns, envelope, runEnrichHook } from "../helpers/enrich-hook-run";

const COMMON_SH = path.resolve(__dirname, "../../src/hooks-template/common.sh");

/** Source the real common.sh and run one function. Never a re-implementation. */
function bash(script: string, env: Record<string, string>, args: string[] = []): string {
  return execFileSync(
    "bash",
    ["-c", `source "$COMMON_SH" >/dev/null 2>&1; ${script}`, "mla-peer-overlap-test", ...args],
    { encoding: "utf8", env: { ...process.env, COMMON_SH, MEETLESS_DEBUG: "0", ...env } },
  );
}

function git(repo: string, args: string[]): void {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

function initRepo(prefix: string): string {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "t@t.t"]);
  git(repo, ["config", "user.name", "t"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "seed.ts"), "export const a = 1;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "seed"]);
  return repo;
}

const MINE = "11111111-1111-4111-8111-111111111111";
const PEER = "22222222-2222-4222-8222-222222222222";
const PEER2 = "33333333-3333-4333-8333-333333333333";

describe("F1: cross-session touched-file overlap", () => {
  let home: string;
  let repo: string;
  let queue: string;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mla-overlap-home-")));
    repo = initRepo("mla-overlap-repo-");
    queue = path.join(home, "queue");
    fs.mkdirSync(queue, { recursive: true });
  });

  afterEach(() => {
    for (const d of [home, repo]) {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  /** Write a `.touched` ledger of absolute paths, with an explicit age in minutes. */
  function ledger(sid: string, absPaths: string[], ageMinutes = 0): string {
    const f = path.join(queue, `${sid}.touched`);
    fs.writeFileSync(f, absPaths.map((p) => `${p}\n`).join(""));
    if (ageMinutes > 0) {
      const t = new Date(Date.now() - ageMinutes * 60_000);
      fs.utimesSync(f, t, t);
    }
    return f;
  }

  const env = () => ({ MEETLESS_HOME: home });

  /** The raw pair list: `<peer_sid>\t<root-relative path>` per line. */
  function overlap(): string[] {
    return bash('collect_peer_overlap "$1" "$2"', env(), [MINE, repo])
      .split("\n")
      .filter((l) => l.length > 0);
  }

  /** The rendered block (empty string when there is nothing to say). */
  function block(): string {
    return bash('build_peer_overlap_block "$1" "$2"', env(), [MINE, repo]);
  }

  // ---- the core case: same physical checkout ------------------------------

  it("reports a peer that touched the same physical file", () => {
    const shared = path.join(repo, "src", "common.sh");
    ledger(MINE, [shared, path.join(repo, "src", "mine-only.ts")]);
    ledger(PEER, [shared, path.join(repo, "src", "peer-only.ts")]);

    expect(overlap()).toEqual([`${PEER}\tsrc/common.sh`]);

    const b = block();
    expect(b).toContain('kind="concurrent-sessions"');
    expect(b).toContain("src/common.sh");
    // The evidence, stated exactly: a touch that happened, not an activity in progress.
    // Asserted on the BULLETS, because the preamble names those readings in order to
    // disclaim them and a whole-block regex cannot tell a claim from its denial.
    const bullets = b.split("\n").filter((l) => l.startsWith("- "));
    expect(bullets).toHaveLength(1);
    expect(bullets[0]).toMatch(/touched|other session/);
    expect(bullets[0]).not.toMatch(/editing|duplicat|conflict|blocked/i);
    // ...and the preamble refuses all three readings out loud.
    expect(b).toContain("does NOT mean those sessions are still running");
    expect(b).toContain("nor that the work is duplicated");
    // Paths that are NOT in the intersection never appear: this is a report about the
    // overlap, not a dump of what everyone on the box is doing.
    expect(b).not.toContain("peer-only.ts");
    expect(b).not.toContain("mine-only.ts");
  });

  // ---- the recency claim must match the signal that produced it ------------

  it("attaches the window to the LEDGER, never to an individual path", () => {
    // THE OVER-CLAIM THIS PINS. Eligibility is one `find -mmin` over the ledger FILE,
    // so the 90 minutes bounds that ledger's most recent write of ANY path. It says
    // nothing about when the listed path was written: a session that touched
    // `old.ts` four hours ago and `fresh.ts` two minutes ago has a ledger inside the
    // window, and `old.ts` is reported. Wording that reads "touched <path> within the
    // last 90 minutes" would be false on exactly that shape, which is the common one.
    //
    // Fixing this by timestamping each line would be a ledger schema change, and the
    // ledger is append-only bytes written by post-tool-use on the hot path. The signal
    // stays as it is; the sentence stops out-running it.
    const stale = path.join(repo, "src", "first-touch.ts");
    const fresh = path.join(repo, "src", "last-touch.ts");
    ledger(MINE, [stale, fresh]);
    // One ledger, both paths, and its mtime is recent. The FIRST line is the older
    // touch; the ledger cannot say how much older.
    ledger(PEER, [stale, fresh]);

    const b = block();
    expect(b).toContain("first-touch.ts");

    // The window is predicated on the ledger...
    expect(b).toMatch(/ledger[^.]*written within the last 90 minutes/);
    // ...and the paths hang off "also touched", with no time attached to them.
    expect(b).toContain("that ledger has also touched");
    // The distinction is stated, not left to be inferred from sentence structure.
    expect(b).toContain("THE WINDOW BOUNDS THE LEDGER, NOT THE PATH");
    // No sentence may put a path and the window in the same claim.
    expect(b).not.toMatch(/touched files this session also touched, within the last/);
    for (const line of b.split("\n").filter((l) => l.startsWith("- "))) {
      expect(line).not.toMatch(/minute|hour|recent|ago/i);
    }
  });

  it("agrees in number on both branches of the ledger sentence", () => {
    // The singular branch is exercised by every other case here; the plural one is
    // reachable only with two peers, and an ungrammatical "those ledgers has also
    // touched" is the kind of thing that ships because nobody read the other arm.
    const shared = path.join(repo, "src", "a.ts");
    const second = path.join(repo, "src", "b.ts");
    ledger(MINE, [shared, second]);
    ledger(PEER, [shared, second]);
    const one = block();
    expect(one).toContain("1 other agent session on this machine has a file-activity ledger");
    expect(one).toContain("that ledger has also touched the paths below");

    // Fresh session id, so suppression does not swallow the second render. From its
    // view MINE and PEER are both peers, so this is the >1 branch.
    const other = "55555555-5555-4555-8555-555555555555";
    ledger(other, [shared, second]);
    const many = bash('build_peer_overlap_block "$1" "$2"', env(), [other, repo]);
    expect(many).toMatch(/^2 other agent sessions on this machine have file-activity ledgers/m);
    expect(many).toContain("those ledgers have also touched the paths below");
    expect(many).not.toContain("ledgers has ");

    // ...and the single-path spelling is not stuck plural either.
    const solo = "66666666-6666-4666-8666-666666666666";
    fs.writeFileSync(path.join(queue, `${solo}.touched`), `${shared}\n`);
    expect(bash('build_peer_overlap_block "$1" "$2"', env(), [solo, repo])).toMatch(
      /also touched the path below/,
    );
  });

  // ---- exclusions: what merely LOOKS like a collision ----------------------

  it("excludes the same relative path in an unrelated checkout", () => {
    const other = initRepo("mla-overlap-other-");
    try {
      ledger(MINE, [path.join(repo, "src", "seed.ts")]);
      ledger(PEER, [path.join(other, "src", "seed.ts")]);
      expect(overlap()).toEqual([]);
      expect(block()).toBe("");
    } finally {
      fs.rmSync(other, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it("excludes an independent git worktree of the SAME repository", () => {
    // The case that looks most like a collision and is not: one repo, one relative
    // path, two checkouts. Two agents editing `src/seed.ts` in two worktrees are
    // editing two different files.
    const wt = path.join(os.tmpdir(), `mla-overlap-wt-${process.pid}-${Date.now()}`);
    git(repo, ["worktree", "add", "-q", "--detach", wt]);
    try {
      const wtReal = fs.realpathSync(wt);
      ledger(MINE, [path.join(repo, "src", "seed.ts")]);
      ledger(PEER, [path.join(wtReal, "src", "seed.ts")]);
      expect(overlap()).toEqual([]);
      expect(block()).toBe("");
    } finally {
      git(repo, ["worktree", "remove", "--force", wt]);
      fs.rmSync(wt, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it("excludes a peer whose ledger has not moved inside the recency window", () => {
    const shared = path.join(repo, "src", "common.sh");
    ledger(MINE, [shared]);
    ledger(PEER, [shared], 91); // one minute past the 90-minute window
    expect(overlap()).toEqual([]);
    expect(block()).toBe("");
  });

  it("keeps a peer just inside the recency window", () => {
    const shared = path.join(repo, "src", "common.sh");
    ledger(MINE, [shared]);
    ledger(PEER, [shared], 5);
    expect(overlap()).toEqual([`${PEER}\tsrc/common.sh`]);
  });

  it("never treats this session's own ledger as a peer", () => {
    ledger(MINE, [path.join(repo, "src", "seed.ts"), path.join(repo, "src", "seed.ts")]);
    expect(overlap()).toEqual([]);
    expect(block()).toBe("");
  });

  it("excludes a path a peer touched that this session never touched", () => {
    ledger(MINE, [path.join(repo, "src", "mine.ts")]);
    ledger(PEER, [path.join(repo, "src", "theirs.ts")]);
    expect(overlap()).toEqual([]);
  });

  it("excludes an overlap outside the activation root", () => {
    // Both sessions touched it, but it is not a surface of this workspace, so it does
    // not belong in this workspace's context (the session-local scope contract).
    const outside = path.join(home, "scratch.ts");
    fs.writeFileSync(outside, "x");
    ledger(MINE, [outside]);
    ledger(PEER, [outside]);
    expect(overlap()).toEqual([]);
  });

  // ---- aggregation ---------------------------------------------------------

  it("aggregates one path touched by several peers into one line with a count", () => {
    const shared = path.join(repo, "src", "common.sh");
    ledger(MINE, [shared]);
    ledger(PEER, [shared]);
    ledger(PEER2, [shared]);

    // One pair per (peer, path): the raw list stays exact so suppression can key on it.
    expect(overlap().sort()).toEqual([`${PEER}\tsrc/common.sh`, `${PEER2}\tsrc/common.sh`].sort());

    const b = block();
    // ...and the RENDER aggregates: one line for the path, naming how many sessions.
    expect((b.match(/src\/common\.sh/g) ?? []).length).toBe(1);
    expect(b).toContain("2 other sessions");
  });

  it("caps the rendered path list and says how many it left out", () => {
    const paths = Array.from({ length: 9 }, (_, i) => path.join(repo, "src", `f${i}.ts`));
    ledger(MINE, paths);
    ledger(PEER, paths);
    expect(overlap()).toHaveLength(9);

    const b = block();
    expect((b.match(/^- /gm) ?? []).length).toBe(6);
    expect(b).toContain("+3 more paths");
    // The three it held back are NOT recorded as said, so they drain onto the next
    // turn instead of vanishing behind a "+N more" that named nobody.
    expect(overlap()).toHaveLength(3);
    const b2 = block();
    expect((b2.match(/^- /gm) ?? []).length).toBe(3);
    expect(b2).not.toContain("more paths");
    expect(block()).toBe("");
  });

  // ---- suppression ---------------------------------------------------------

  it("reports a (peer, path) pair once and stays silent afterwards", () => {
    const shared = path.join(repo, "src", "common.sh");
    ledger(MINE, [shared]);
    ledger(PEER, [shared]);

    expect(block()).toContain("src/common.sh");
    // Same peer, same path, next turn: already said.
    expect(block()).toBe("");
  });

  it("surfaces a NEW peer on a path already reported for another peer", () => {
    const shared = path.join(repo, "src", "common.sh");
    ledger(MINE, [shared]);
    ledger(PEER, [shared]);
    expect(block()).toContain("src/common.sh");

    ledger(PEER2, [shared]);
    const b = block();
    expect(b).toContain("src/common.sh");
    expect(b).toContain("1 other session");
  });

  it("suppression is per session, so a fresh session sees the same overlap", () => {
    const shared = path.join(repo, "src", "common.sh");
    ledger(MINE, [shared]);
    ledger(PEER, [shared]);
    expect(block()).toContain("src/common.sh");

    const other = "44444444-4444-4444-8444-444444444444";
    ledger(other, [shared]);
    expect(bash('build_peer_overlap_block "$1" "$2"', env(), [other, repo])).toContain("src/common.sh");
  });

  // ---- fail open -----------------------------------------------------------

  it("returns nothing, and does not fail, when this session has no ledger", () => {
    ledger(PEER, [path.join(repo, "src", "seed.ts")]);
    expect(overlap()).toEqual([]);
    expect(block()).toBe("");
  });

  it("returns nothing, and does not fail, when the queue directory is absent", () => {
    fs.rmSync(queue, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    expect(overlap()).toEqual([]);
    expect(block()).toBe("");
  });

  it("survives a malformed peer ledger and still reports the valid overlap", () => {
    const shared = path.join(repo, "src", "common.sh");
    ledger(MINE, [shared]);
    ledger(PEER, [shared]);
    // Binary noise, no trailing newline, embedded NULs.
    fs.writeFileSync(path.join(queue, "55555555-5555-4555-8555-555555555555.touched"), Buffer.from([0, 1, 2, 255, 65, 0, 10, 66]));
    // An empty ledger.
    fs.writeFileSync(path.join(queue, "66666666-6666-4666-8666-666666666666.touched"), "");
    expect(overlap()).toEqual([`${PEER}\tsrc/common.sh`]);
    expect(block()).toContain("src/common.sh");
  });

  it("survives a ledger that vanishes between listing and read", () => {
    const shared = path.join(repo, "src", "common.sh");
    ledger(MINE, [shared]);
    ledger(PEER, [shared]);
    // A dangling symlink is listed by the directory scan and unreadable by the parser:
    // the same observable state as a peer's ledger being reaped mid-scan.
    fs.symlinkSync(path.join(queue, "gone-forever"), path.join(queue, "77777777-7777-4777-8777-777777777777.touched"));
    expect(overlap()).toEqual([`${PEER}\tsrc/common.sh`]);
  });

  it("survives a concurrent append to a peer ledger mid-scan", () => {
    const shared = path.join(repo, "src", "common.sh");
    ledger(MINE, [shared]);
    const f = ledger(PEER, [shared]);
    // A line with no trailing newline is exactly what a torn append looks like.
    fs.appendFileSync(f, path.join(repo, "src", "half-written"));
    expect(overlap()).toEqual([`${PEER}\tsrc/common.sh`]);
  });

  // ---- the boundary the 2026-07-27 fix drew --------------------------------

  it("leaves this session's own touched set exact, with no peer path in it", () => {
    const shared = path.join(repo, "src", "common.sh");
    ledger(MINE, [path.join(repo, "src", "mine.ts"), shared]);
    ledger(PEER, [shared, path.join(repo, "src", "peer-only.ts")]);

    const mine = bash('collect_touched_files "$1" "$2"', env(), [MINE, repo]);
    expect(JSON.parse(mine).sort()).toEqual(["src/common.sh", "src/mine.ts"]);
    expect(mine).not.toContain("peer-only.ts");
  });
});

// REACHABILITY. Everything above drives the functions directly, which proves they are
// correct and proves nothing about whether the hook calls them. This drives the REAL
// UserPromptSubmit hook end to end and reads the payload the model would have received.
describe("F1 wiring: the overlap block reaches the prompt", () => {
  jest.setTimeout(60000);
  afterAll(cleanupHookRuns);

  const SESSION = "88888888-8888-4888-8888-888888888888";
  const PEER_LIVE = "99999999-9999-4999-8999-999999999999";

  function seedLedgers(dirs: { home: string; repo: string }, shared: string): void {
    const q = path.join(dirs.home, "queue");
    fs.mkdirSync(q, { recursive: true });
    const abs = path.join(fs.realpathSync(dirs.repo), shared);
    fs.writeFileSync(path.join(q, `${SESSION}.touched`), `${abs}\n`);
    fs.writeFileSync(path.join(q, `${PEER_LIVE}.touched`), `${abs}\n`);
  }

  it("emits a distinct block naming the shared path, and leaves touched_files exact", async () => {
    const { additionalContext } = await runEnrichHook(envelope([]), {
      sessionId: SESSION,
      setup: (dirs) => seedLedgers(dirs, "src/shared.ts"),
    });

    expect(additionalContext).toContain('kind="concurrent-sessions"');
    expect(additionalContext).toContain("- src/shared.ts (1 other session)");
    // The self-attribution line is SEPARATE and still names the path as this session's
    // own, because this session did touch it. What must never happen is a path only the
    // PEER touched appearing there; that is the 2026-07-27 regression.
    expect(additionalContext).toMatch(/touched_files: src\/shared\.ts/);
    // Two different blocks, not one merged claim.
    expect(additionalContext.indexOf('kind="static"')).toBeLessThan(
      additionalContext.indexOf('kind="concurrent-sessions"'),
    );
  });

  it("says nothing when no peer ledger overlaps", async () => {
    const { additionalContext } = await runEnrichHook(envelope([]), {
      sessionId: SESSION,
      setup: (dirs) => {
        const q = path.join(dirs.home, "queue");
        fs.mkdirSync(q, { recursive: true });
        const repo = fs.realpathSync(dirs.repo);
        fs.writeFileSync(path.join(q, `${SESSION}.touched`), `${path.join(repo, "src/mine.ts")}\n`);
        fs.writeFileSync(path.join(q, `${PEER_LIVE}.touched`), `${path.join(repo, "src/theirs.ts")}\n`);
      },
    });
    expect(additionalContext).not.toContain("concurrent-sessions");
  });

  it("does not run at all, and does not fail the turn, with no ledgers on disk", async () => {
    const { additionalContext, trace } = await runEnrichHook(envelope([]), { sessionId: SESSION });
    expect(additionalContext).not.toContain("concurrent-sessions");
    // The turn still delivered its floor: the scan is fail-open by construction.
    expect(trace.hook.injected).toBe(true);
  });
});
