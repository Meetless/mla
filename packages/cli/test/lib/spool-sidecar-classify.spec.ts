import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { reapQueue } from "../../src/lib/spool";

const NOW = 1_780_000_000_000;
const DAY = 86_400;

function write(dir: string, name: string, body: string, ageSecAgo: number): void {
  const full = path.join(dir, name);
  fs.writeFileSync(full, body);
  const t = (NOW - ageSecAgo * 1000) / 1000;
  fs.utimesSync(full, t, t);
}

describe("queue sidecar classification", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mla-classify-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));

  it("reaps lifecycle sidecars under the SAME session as .lock", () => {
    const sid = "sess-cuid-xyz";
    write(dir, `${sid}.jsonl`, "", 2 * DAY); // 0-byte drained spool
    write(dir, `${sid}.lock`, "", 2 * DAY);
    write(dir, `${sid}.turn`, "5", 2 * DAY);
    write(dir, `${sid}.hb`, "1718", 2 * DAY);
    write(dir, `${sid}.hb.lock`, "", 2 * DAY);
    write(dir, `${sid}.narration-cursor`, "42", 2 * DAY);
    write(dir, `${sid}.narration-cursor.lock`, "", 2 * DAY);
    write(dir, `${sid}.codexStarted`, "", 2 * DAY);

    const r = reapQueue({ queueDir: dir, maxAgeSec: DAY, now: NOW });

    // One session reaped (not three phantom ".hb" / ".narration-cursor" sessions),
    // all eight files gone.
    expect(r.reaped).toEqual([sid]);
    // `.turn` is deliberately NOT removed: it is the cross-hook join key and a resumed
    // session must not restart its numbering. See the skip in reapQueue.
    expect(r.removedFiles).toBe(7);
    expect(fs.readdirSync(dir)).toEqual([`${sid}.turn`]);
  });

  it("leaves .workspaceId.bak.* backups untouched (unrecognized)", () => {
    write(dir, "sess-a.workspaceId.bak.wsmismatch", "ws_old", 5 * DAY);
    const r = reapQueue({ queueDir: dir, maxAgeSec: DAY, now: NOW });
    expect(r.removedFiles).toBe(0);
    expect(fs.existsSync(path.join(dir, "sess-a.workspaceId.bak.wsmismatch"))).toBe(true);
  });
});
