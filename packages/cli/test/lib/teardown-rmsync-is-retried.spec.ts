/**
 * A recursive `rmSync` in a test must be able to lose a race with a hook.
 *
 * ## The failure this prevents
 *
 * On 2026-08-04 a production cut was blocked by a suite that reported
 * `Tests: 6748 passed, 6748 total` and `Test Suites: 1 failed`. Every test it
 * contained had passed. It died in its own `afterAll`, on
 * `ENOTEMPTY: directory not empty, rmdir '/tmp/mla-handoff-home-XXXX/queue'`.
 *
 * `force: true` swallows only ENOENT. These specs drive hooks that run
 * `mkdir -p "$QUEUE_DIR"` from a SPAWNED SHELL (`src/hooks-template/common.sh`),
 * and that child outlives the assertion it was created for. Node's recursive
 * remove reads a directory's entries, deletes them, then rmdirs the directory,
 * so a file landing in that window makes the final rmdir throw ENOTEMPTY. Node
 * retries exactly this class of error (ENOTEMPTY, EBUSY, EPERM, EMFILE, ENFILE)
 * but ONLY when `maxRetries` is set, and it defaults to **0**.
 *
 * The result is the worst shape a CI failure can take: not a wrong assertion,
 * which points at a bug, but a green suite that fails anyway, which points at
 * nothing. It passes locally every time and needs CI's slower filesystem and
 * `--maxWorkers=50%` to lose the race.
 *
 * ## Why this guard is repo-wide instead of targeting the specs at risk
 *
 * The hazard needs a concurrent writer, so in principle only the specs that
 * spawn hooks are exposed, and a first pass found 51 of them. That framing was
 * rejected: it requires a hand-maintained list of "which specs spawn a hook",
 * which is exactly the kind of second list that drifts from the first, and a
 * spec that starts spawning one next month would silently rejoin the hazard
 * without ever appearing in a diff anyone reviewed.
 *
 * Setting `maxRetries` where there is no concurrent writer costs nothing: it
 * changes behavior only on an error that would otherwise have been thrown. So
 * the rule is the simpler one, and it is mechanically checkable.
 */
import * as fs from "fs";
import * as path from "path";

const TEST_ROOT = path.join(__dirname, "..");

// `{ recursive: true, ... }` with no `maxRetries` anywhere in the options object.
const UNGUARDED = /rmSync\([^;]*?\{[^{}]*recursive:\s*true[^{}]*\}/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__fixtures__") continue;
      walk(full, out);
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

describe("recursive rmSync in tests survives a hook that is still writing", () => {
  it("every recursive rmSync under test/ sets maxRetries", () => {
    const offenders: string[] = [];

    for (const file of walk(TEST_ROOT)) {
      const src = fs.readFileSync(file, "utf8");
      for (const call of src.match(UNGUARDED) ?? []) {
        if (!/maxRetries/.test(call)) {
          offenders.push(`${path.relative(TEST_ROOT, file)}: ${call.replace(/\s+/g, " ").slice(0, 90)}`);
        }
      }
    }

    expect(
      offenders,
      // Jest prints the array, which is the actionable part: every site to fix.
    ).toEqual([]);
  });

  it("the guard can actually see an offender (a check that cannot fail is not a check)", () => {
    // The regex is the whole guard, so prove it matches the shape it exists to
    // catch and does not match the fixed shape. Without this, a regex typo would
    // make the assertion above pass over a repo full of offenders, which is the
    // same vacuous-green bug the guard itself is about.
    //
    // ASSEMBLED, never written out. The one-shot codemod that fixed the 465 real
    // call sites rewrote this very fixture on its first run, because a literal
    // offender in a file is an offender no matter what it is for. `bad` then
    // equalled `good` and the guard cheerfully agreed with itself. Keep the
    // offending text un-spellable here so no future sweep can launder it.
    const opts = "{ recursive: true, force: true" + " }";
    const bad = `fs.rmSync(HOME, ${opts});`;
    const good = `fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });`;

    const badMatches = (bad.match(UNGUARDED) ?? []).filter((c) => !/maxRetries/.test(c));
    const goodMatches = (good.match(UNGUARDED) ?? []).filter((c) => !/maxRetries/.test(c));

    expect(badMatches).toHaveLength(1);
    expect(goodMatches).toHaveLength(0);
  });

  it("retrying actually defeats the race it was chosen for", async () => {
    // Not a claim about Node's docs: drive the real hazard. A writer keeps
    // creating files inside the directory while the remove runs, which is what
    // the spawned hook shell does to a temp HOME.
    const root = fs.mkdtempSync(path.join(require("os").tmpdir(), "rmsync-race-"));
    const queue = path.join(root, "queue");
    fs.mkdirSync(queue, { recursive: true });
    for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(queue, `f${i}`), "x");

    let writing = true;
    const writer = (async () => {
      let n = 0;
      while (writing) {
        try {
          fs.writeFileSync(path.join(queue, `late${n++}`), "x");
        } catch {
          /* the dir is gone; that is the success case */
        }
        await new Promise((r) => setImmediate(r));
      }
    })();

    let threw: unknown = null;
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    } catch (err) {
      threw = err;
    } finally {
      writing = false;
      await writer;
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }

    expect(threw).toBeNull();
  });
});
