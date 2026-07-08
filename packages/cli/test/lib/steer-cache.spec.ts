import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  steerCachePath,
  steerInjectStatePath,
  writeSteerCache,
  readInjectedIds,
} from "../../src/lib/steer-cache";

// Plan 1 (cross-session conflict-resolution loop), Task 1.5. The CLI side of the
// steer hand-off: `_internal steer-sync` writes steer-<sid>.json that the
// user-prompt-submit hook reads with NO network call, and reads inject-<sid>.json
// that the hook writes. The HARD invariant under test is path + shape agreement
// with the bash readers in common.sh (steer_cache_file / steer_inject_file): if
// the two sides disagree on the path or field names, a steer silently never
// injects, so this spec pins the contract on the TS side.

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "steer-home-"));
}

describe("steer-cache", () => {
  it("writes the cache to logs/steer/steer-<sid>.json under HOME", () => {
    const home = tmpHome();
    writeSteerCache(
      "sess-X",
      [{ id: "s1", directive: "do the thing", caseId: null, createdAt: "2026-06-08T00:00:00.000Z" }],
      home,
    );
    const file = steerCachePath("sess-X", home);
    expect(file).toBe(path.join(home, "logs", "steer", "steer-sess-X.json"));
    const body = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(body.steers).toHaveLength(1);
    expect(body.steers[0].directive).toBe("do the thing");
    expect(typeof body.ts).toBe("number");
  });

  it("reads injected ids the hook recorded", () => {
    const home = tmpHome();
    const file = steerInjectStatePath("sess-Y", home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ injected: ["a", "b"], ts: 1 }));
    expect(readInjectedIds("sess-Y", home)).toEqual(["a", "b"]);
  });

  it("returns [] when no inject-state exists", () => {
    const home = tmpHome();
    expect(readInjectedIds("sess-none", home)).toEqual([]);
  });
});
