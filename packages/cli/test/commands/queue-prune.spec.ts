import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runQueuePrune } from "../../src/commands/queue-prune";

const NOW = 1_780_000_000_000;
const DAY = 86_400;

function write(dir: string, name: string, body: string, ageSecAgo: number): void {
  const full = path.join(dir, name);
  fs.writeFileSync(full, body);
  const t = (NOW - ageSecAgo * 1000) / 1000;
  fs.utimesSync(full, t, t);
}

describe("runQueuePrune", () => {
  let dir: string;
  let logs: string[];
  let logSpy: jest.SpyInstance;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mla-prune-cmd-"));
    logs = [];
    logSpy = jest.spyOn(console, "log").mockImplementation((m?: unknown) => {
      logs.push(String(m));
    });
  });
  afterEach(() => {
    logSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("previews without --yes and removes nothing", async () => {
    write(dir, "dead.jsonl", '{"event":"a"}\n', 3 * DAY);
    write(dir, "dead.lock", "", 3 * DAY);

    const code = await runQueuePrune([], { queueDir: dir, now: NOW });

    expect(code).toBe(0);
    expect(logs.join("\n")).toMatch(/Dry run/);
    expect(fs.existsSync(path.join(dir, "dead.jsonl"))).toBe(true);
  });

  it("with --yes --no-flush deletes the dead session's files", async () => {
    write(dir, "dead.jsonl", '{"event":"a"}\n', 3 * DAY);
    write(dir, "dead.lock", "", 3 * DAY);

    const code = await runQueuePrune(["--yes", "--no-flush"], { queueDir: dir, now: NOW });

    expect(code).toBe(0);
    expect(logs.join("\n")).toMatch(/Pruned 1 session/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("reports nothing to prune when all sessions are fresh", async () => {
    write(dir, "fresh.jsonl", '{"event":"a"}\n', 30);

    const code = await runQueuePrune(["--yes"], { queueDir: dir, now: NOW });

    expect(code).toBe(0);
    expect(logs.join("\n")).toMatch(/Nothing to prune/);
  });

  it("rejects a non-numeric --max-age-hours", async () => {
    const errs: string[] = [];
    const errSpy = jest.spyOn(console, "error").mockImplementation((m?: unknown) => {
      errs.push(String(m));
    });
    const code = await runQueuePrune(["--max-age-hours", "abc"], { queueDir: dir, now: NOW });
    errSpy.mockRestore();
    expect(code).toBe(2);
    expect(errs.join("\n")).toMatch(/max-age-hours/);
  });
});
