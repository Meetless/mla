import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { removeMeetlessMcp } from "../../src/lib/unwire";

function tmpClaude(obj: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mla-rmmcp-"));
  const p = path.join(dir, ".claude.json");
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
  return p;
}

describe("removeMeetlessMcp", () => {
  it("removes the meetless server at top level and under each project, keeping others", () => {
    const p = tmpClaude({
      mcpServers: { meetless: { command: "mla", args: ["mcp"] }, other: { command: "x" } },
      projects: {
        "/a": { mcpServers: { meetless: { command: "mla" } } },
        "/b": { mcpServers: { keepme: { command: "y" } } },
      },
    });
    const res = removeMeetlessMcp(p);
    expect(res.changed).toBe(true);
    expect(res.removedFrom).toContain("(top level)");
    expect(res.removedFrom).toContain("projects//a");
    expect(res.backupPath).not.toBeNull();
    const after = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(after.mcpServers.meetless).toBeUndefined();
    expect(after.mcpServers.other).toBeDefined();
    expect(after.projects["/a"].mcpServers).toBeUndefined(); // emptied -> dropped
    expect(after.projects["/b"].mcpServers.keepme).toBeDefined();
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  });

  it("is a no-op when there is no meetless server anywhere", () => {
    const p = tmpClaude({ mcpServers: { other: { command: "x" } }, projects: {} });
    const res = removeMeetlessMcp(p);
    expect(res.changed).toBe(false);
    expect(res.backupPath).toBeNull();
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  });

  it("is a safe no-op when the file is missing or unparseable", () => {
    expect(removeMeetlessMcp("/no/such/.claude.json").changed).toBe(false);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mla-rmmcp-bad-"));
    const p = path.join(dir, ".claude.json");
    fs.writeFileSync(p, "{nope", "utf8");
    expect(removeMeetlessMcp(p).changed).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
