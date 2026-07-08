import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ensureClaudeMcpServer, MCP_SERVER_KEY } from "../../src/lib/wire";

// Deterministic mla path so the test never depends on the machine's real
// resolveMlaPath() (which is environment-sensitive).
const MLA = "/fake/bin/mla";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mla-wmcp-"));
}

function readJson(p: string): any {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

describe("ensureClaudeMcpServer", () => {
  it("creates ~/.claude.json with a canonical user-scope server when the file is missing", () => {
    const dir = tmpDir();
    const p = path.join(dir, ".claude.json");
    const res = ensureClaudeMcpServer(p, MLA);
    expect(res.action).toBe("added");
    expect(res.path).toBe(p);
    const after = readJson(p);
    expect(after.mcpServers[MCP_SERVER_KEY]).toEqual({ command: MLA, args: ["mcp"] });
    // user-scope: no env block, no nesting under projects
    expect(after.mcpServers[MCP_SERVER_KEY].env).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("adds the server while preserving other servers and unrelated keys", () => {
    const dir = tmpDir();
    const p = path.join(dir, ".claude.json");
    fs.writeFileSync(
      p,
      JSON.stringify({ mcpServers: { other: { command: "x" } }, projects: { "/a": {} } }, null, 2) + "\n",
      "utf8",
    );
    const res = ensureClaudeMcpServer(p, MLA);
    expect(res.action).toBe("added");
    const after = readJson(p);
    expect(after.mcpServers[MCP_SERVER_KEY]).toEqual({ command: MLA, args: ["mcp"] });
    expect(after.mcpServers.other).toEqual({ command: "x" });
    expect(after.projects["/a"]).toEqual({});
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is a no-op (no write, no backup) when the canonical entry already exists", () => {
    const dir = tmpDir();
    const p = path.join(dir, ".claude.json");
    fs.writeFileSync(
      p,
      JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: { command: MLA, args: ["mcp"] } } }, null, 2) + "\n",
      "utf8",
    );
    const before = fs.readFileSync(p, "utf8");
    const res = ensureClaudeMcpServer(p, MLA);
    expect(res.action).toBe("unchanged");
    expect(fs.readFileSync(p, "utf8")).toBe(before); // byte-identical: untouched
    // no backup created
    expect(fs.readdirSync(dir).filter((f) => f.includes(".bak."))).toHaveLength(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("updates a stale entry (wrong command or args) and backs up the original", () => {
    const dir = tmpDir();
    const p = path.join(dir, ".claude.json");
    fs.writeFileSync(
      p,
      JSON.stringify(
        { mcpServers: { [MCP_SERVER_KEY]: { command: "/old/mla", args: ["mcp", "--legacy"] } } },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    const res = ensureClaudeMcpServer(p, MLA);
    expect(res.action).toBe("updated");
    const after = readJson(p);
    expect(after.mcpServers[MCP_SERVER_KEY]).toEqual({ command: MLA, args: ["mcp"] });
    // a timestamped backup of the original was written
    expect(fs.readdirSync(dir).filter((f) => f.includes(".claude.json.bak."))).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("skips (and leaves untouched) an unparseable ~/.claude.json", () => {
    const dir = tmpDir();
    const p = path.join(dir, ".claude.json");
    fs.writeFileSync(p, "{nope", "utf8");
    const res = ensureClaudeMcpServer(p, MLA);
    expect(res.action).toBe("skipped");
    expect(res.detail).toMatch(/not valid JSON/i);
    expect(fs.readFileSync(p, "utf8")).toBe("{nope"); // untouched
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
