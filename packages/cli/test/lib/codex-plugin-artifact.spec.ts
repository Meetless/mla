import * as fs from "fs";
import * as path from "path";

describe("Codex plugin MCP artifact", () => {
  it("runs MLA and permits annotated reads while approval-gating writes", () => {
    const pluginRoot = path.resolve(__dirname, "../../../../codex/mla");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(pluginRoot, ".codex-plugin/plugin.json"), "utf8"),
    );
    const mcp = JSON.parse(
      fs.readFileSync(path.join(pluginRoot, manifest.mcpServers), "utf8"),
    );

    expect(mcp.mcpServers.meetless).toEqual({
      command: "mla",
      args: ["mcp"],
      default_tools_approval_mode: "writes",
    });
  });
});
