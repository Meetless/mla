import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { pendingCountCachePath, writePendingCountCache } from "../../src/lib/governance-cache";

// A-0c (A4 surface 2). The CLI side of the pending-count hand-off: `mla kb pending`
// writes a tiny local cache that the user-prompt-submit hook reads with NO network
// call (Patch 8). The HARD invariant under test is path + shape agreement with the
// bash reader (common.sh governance_count_file): the hook builds
//   $MEETLESS_HOME/logs/governance/pending-count-<ws_safe>.json
// with ws_safe = tr -c 'A-Za-z0-9_.-' '_', and reads `.count` + `.ts`. If these two
// sides ever disagree on the path or the field names, the nudge silently never
// fires, so this spec pins the contract on the writer side.
describe("governance-cache (A-0c pending-count hand-off)", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "mla-govcache-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("lands the cache under logs/governance with the bash-compatible filename", () => {
    const p = pendingCountCachePath("ws_test", home);
    expect(p).toBe(path.join(home, "logs", "governance", "pending-count-ws_test.json"));
  });

  it("sanitizes the workspace id exactly like the bash reader (tr -c 'A-Za-z0-9_.-' '_')", () => {
    // every char outside [A-Za-z0-9_.-] becomes '_', one-for-one (no collapsing).
    const p = pendingCountCachePath("ws/weird:id 7", home);
    expect(path.basename(p)).toBe("pending-count-ws_weird_id_7.json");
  });

  it("writes a bash-readable {count, ts} object with ts as integer epoch seconds", () => {
    writePendingCountCache("ws_test", 3, home);
    const raw = fs.readFileSync(pendingCountCachePath("ws_test", home), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.count).toBe(3);
    expect(Number.isInteger(parsed.ts)).toBe(true);
    // epoch SECONDS, not millis (bash compares against `date +%s`).
    expect(parsed.ts).toBeLessThan(1e11);
    expect(parsed.ts).toBeGreaterThan(1e9);
  });

  it("creates the governance dir on first write (no pre-existing tree)", () => {
    expect(fs.existsSync(path.join(home, "logs", "governance"))).toBe(false);
    writePendingCountCache("ws_test", 0, home);
    expect(fs.existsSync(pendingCountCachePath("ws_test", home))).toBe(true);
  });

  it("records a zero count so the hook can clear a stale nudge", () => {
    writePendingCountCache("ws_test", 0, home);
    const parsed = JSON.parse(fs.readFileSync(pendingCountCachePath("ws_test", home), "utf8"));
    expect(parsed.count).toBe(0);
  });
});
