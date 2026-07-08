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

describe("queue sidecar classification (hb + narration-cursor)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mla-classify-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("reaps .hb/.hb.lock/.narration-cursor/.narration-cursor.lock under the SAME session as .lock", () => {
    const sid = "sess-cuid-xyz";
    write(dir, `${sid}.jsonl`, "", 2 * DAY); // 0-byte drained spool
    write(dir, `${sid}.lock`, "", 2 * DAY);
    write(dir, `${sid}.turn`, "5", 2 * DAY);
    write(dir, `${sid}.hb`, "1718", 2 * DAY);
    write(dir, `${sid}.hb.lock`, "", 2 * DAY);
    write(dir, `${sid}.narration-cursor`, "42", 2 * DAY);
    write(dir, `${sid}.narration-cursor.lock`, "", 2 * DAY);

    const r = reapQueue({ queueDir: dir, maxAgeSec: DAY, now: NOW });

    // One session reaped (not three phantom ".hb" / ".narration-cursor" sessions),
    // all seven files gone.
    expect(r.reaped).toEqual([sid]);
    expect(r.removedFiles).toBe(7);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("leaves .workspaceId.bak.* backups untouched (unrecognized)", () => {
    write(dir, "sess-a.workspaceId.bak.wsmismatch", "ws_old", 5 * DAY);
    const r = reapQueue({ queueDir: dir, maxAgeSec: DAY, now: NOW });
    expect(r.removedFiles).toBe(0);
    expect(fs.existsSync(path.join(dir, "sess-a.workspaceId.bak.wsmismatch"))).toBe(true);
  });
});
