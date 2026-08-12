import { mkdtempSync, mkdirSync, writeFileSync, existsSync, lstatSync, symlinkSync, utimesSync, lutimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";

// The orphan sweep added to session-start.sh, tested as the exact `find` invocation the
// hook runs rather than a re-implementation of it.
//
// WHY A TTL IS SAFE HERE, which is the question these pin. `inject-<session>.json` is
// per-session throttle state and its ONLY reader is user-prompt-submit.sh for its own
// $SESSION_ID. session-start.sh already deletes it, but only for the session it is
// starting, and session ids never recur, so every finished session leaves one behind:
// 87 of them had accumulated on the dogfood machine, spanning 2026-06-06 to 2026-07-05.
//
// Crucially the file IS reopened and REWRITTEN after creation: the hook rewrites it on
// every injection. So `-mtime` measures time since the last INJECTION, not since session
// start, and "older than 7 days" means "this session has not injected in a week", which
// no live session does. An active session cannot lose state to this sweep. The residual
// is a session that stays open but throttled for seven days: it loses its throttle state
// and shows one extra prose nudge. That is the whole downside.
//
// unavail-<session>.json is written ONCE per session by the P13 throttle and never
// rewritten, so a session open longer than 7 days could re-show the unavailability
// notice once. Also harmless, and recorded here rather than discovered later.

const SWEEP = (dir: string) =>
  [
    dir,
    "-maxdepth",
    "1",
    "-type",
    "f",
    "(",
    "-name",
    "inject-*.json",
    "-o",
    "-name",
    "unavail-*.json",
    "-o",
    "-name",
    "route-*.json",
    ")",
    "-mtime",
    "+7",
    "-delete",
  ];

const TTL_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;

function sweep(dir: string): void {
  // Never fails the hook: the real call is `|| true`.
  try {
    execFileSync("find", SWEEP(dir), { stdio: "ignore" });
  } catch {
    /* matches the hook's best-effort contract */
  }
}

function ageFile(path: string, daysOld: number): void {
  const when = new Date(Date.now() - daysOld * DAY);
  utimesSync(path, when, when);
}

describe("governance orphan sweep", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mlsweep-"));
    mkdirSync(join(dir, "governance"), { recursive: true });
    dir = join(dir, "governance");
  });

  it("KEEPS a recently written file", () => {
    // The live case: an active session rewrites this on every injection, so its mtime is
    // always recent no matter how long the session has been open.
    const f = join(dir, "inject-active-session.json");
    writeFileSync(f, JSON.stringify({ last_count: 3 }));
    ageFile(f, 1);

    sweep(dir);
    expect(existsSync(f)).toBe(true);
  });

  it("DELETES a file past the TTL", () => {
    const f = join(dir, "inject-dead-session.json");
    writeFileSync(f, JSON.stringify({ last_count: 3 }));
    ageFile(f, TTL_DAYS + 3);

    sweep(dir);
    expect(existsSync(f)).toBe(false);
  });

  it("brackets the REAL deletion boundary, which is 8 days and not 7", () => {
    // `-mtime +7` does NOT mean "older than 7 days". Both BSD and GNU find divide the
    // age into WHOLE 24-hour periods, truncating, and `+7` matches strictly more than 7
    // of them. So the effective cut is 8 DAYS: 7.9d survives, 8.0d is deleted.
    //
    // Measured on Darwin before this was written, because describing the constant as
    // "7 days" is the kind of plausible-and-wrong number this whole round is about. The
    // truncation is identical on GNU find, so CI and macOS agree.
    //
    // The direction is the safe one either way: an orphan lives up to a day longer than
    // the nominal TTL, and live state is never reaped early.
    const cases: Array<[number, boolean]> = [
      [TTL_DAYS - 0.1, true], // 6.9d kept
      [TTL_DAYS, true], // 7.0d kept
      [TTL_DAYS + 0.5, true], // 7.5d kept, the surprising one
      [TTL_DAYS + 0.9, true], // 7.9d kept
      [TTL_DAYS + 1, false], // 8.0d DELETED
      [TTL_DAYS + 2, false], // 9.0d deleted
    ];

    const made = cases.map(([age], i) => {
      const f = join(dir, `inject-age-${i}.json`);
      writeFileSync(f, "{}");
      ageFile(f, age);
      return f;
    });

    sweep(dir);

    cases.forEach(([age, shouldSurvive], i) => {
      expect({ age, survived: existsSync(made[i]) }).toEqual({
        age,
        survived: shouldSurvive,
      });
    });
  });

  it("KEEPS the P13 unavailability marker while it is fresh, reaps it when stale", () => {
    const fresh = join(dir, "unavail-live.json");
    const stale = join(dir, "unavail-dead.json");
    writeFileSync(fresh, "{}");
    writeFileSync(stale, "{}");
    ageFile(fresh, 1);
    ageFile(stale, TTL_DAYS + 3);

    sweep(dir);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });

  it("reaps a stale continuation route-family file, keeps a fresh one", () => {
    // route-<session>.json is per-session continuation state with the same one-session
    // lifetime as its neighbours, so it rides the same sweep rather than growing a
    // second cleanup path.
    const fresh = join(dir, "route-live.json");
    const stale = join(dir, "route-dead.json");
    writeFileSync(fresh, JSON.stringify({ family: "governed_kb" }));
    writeFileSync(stale, JSON.stringify({ family: "governed_kb" }));
    ageFile(fresh, 1);
    ageFile(stale, TTL_DAYS + 3);

    sweep(dir);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });

  it("NEVER touches an unrelated file, however old", () => {
    // The pending-count cache lives in this same directory and has NO session lifetime:
    // it is the workspace's review-queue hand-off and is legitimately old (171h on the
    // dogfood machine). Reaping it would take out the P13 nudge's only input.
    const cache = join(dir, "pending-count-ws_1.json");
    const other = join(dir, "steer-inject-abc.json");
    writeFileSync(cache, JSON.stringify({ count: 0, ts: 1 }));
    writeFileSync(other, "{}");
    ageFile(cache, 400);
    ageFile(other, 400);

    sweep(dir);
    expect(existsSync(cache)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });

  it("NEVER follows a directory or a symlink matching the pattern", () => {
    // `-type f` is the protection. A directory named inject-*.json would otherwise be a
    // recursive delete target, and a symlink would let the sweep reach outside its own
    // directory entirely. Both are pinned because both are silent if they regress.
    const outsider = join(dir, "..", "precious.json");
    writeFileSync(outsider, "do not delete me");
    ageFile(outsider, 400);

    const asDir = join(dir, "inject-a-directory.json");
    mkdirSync(asDir);

    const asLink = join(dir, "inject-a-symlink.json");
    symlinkSync(outsider, asLink);
    // Age the LINK, not its target. find does not follow symlinks by default, so it
    // matches on the link's own mtime; ageing the target instead leaves the link fresh
    // and the case tests nothing. That is what the first version of this did, and
    // dropping `-type f` left it green.
    const old = new Date(Date.now() - 400 * DAY);
    lutimesSync(asLink, old, old);

    sweep(dir);

    expect(existsSync(asDir)).toBe(true);
    expect(existsSync(outsider)).toBe(true);
    // lstat, not existsSync: existsSync FOLLOWS the link, so it would report true from
    // the surviving target even if the link itself had been reaped.
    expect(() => lstatSync(asLink)).not.toThrow();
  });
});
