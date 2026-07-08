import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { backupFile, removeDir, countQueuedSessions, countQueuedEvents } from "../../src/lib/unwire";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mla-unwire-"));
}

describe("unwire helpers", () => {
  it("backupFile copies to a timestamped sibling and returns its path", () => {
    const dir = tmp();
    const f = path.join(dir, "settings.json");
    fs.writeFileSync(f, '{"a":1}', "utf8");
    const bak = backupFile(f);
    expect(bak.startsWith(f + ".bak.")).toBe(true);
    expect(fs.readFileSync(bak, "utf8")).toBe('{"a":1}');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("removeDir reports removed=true for an existing dir, false when absent", () => {
    const dir = tmp();
    const sub = path.join(dir, "meetless");
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, "x"), "x", "utf8");
    expect(removeDir(sub)).toEqual({ removed: true });
    expect(fs.existsSync(sub)).toBe(false);
    expect(removeDir(sub)).toEqual({ removed: false });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("countQueuedSessions counts .jsonl files only, ignores sidecars and missing dir", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "a.jsonl"), "", "utf8");
    fs.writeFileSync(path.join(dir, "b.jsonl"), "", "utf8");
    fs.writeFileSync(path.join(dir, "a.lock"), "", "utf8");
    fs.writeFileSync(path.join(dir, "a.turn"), "", "utf8");
    expect(countQueuedSessions(dir)).toBe(2);
    expect(countQueuedSessions(path.join(dir, "nope"))).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("countQueuedEvents sums event lines across .jsonl, ignores sidecars and empties, missing dir is 0", () => {
    // The honest measure of what an uninstall would discard is the count of
    // un-flushed events, not the number of session files. Most session files
    // hold only a small tail of events, so the file count overstates magnitude.
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "a.jsonl"), '{"e":1}\n{"e":2}\n{"e":3}\n', "utf8");
    fs.writeFileSync(path.join(dir, "b.jsonl"), '{"e":4}\n{"e":5}\n', "utf8");
    fs.writeFileSync(path.join(dir, "c.jsonl"), "", "utf8"); // fully drained: contributes 0
    fs.writeFileSync(path.join(dir, "a.lock"), "noise\nnoise\n", "utf8"); // sidecar: ignored
    fs.writeFileSync(path.join(dir, "a.turn"), "noise\n", "utf8"); // sidecar: ignored
    expect(countQueuedEvents(dir)).toBe(5);
    expect(countQueuedEvents(path.join(dir, "nope"))).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
