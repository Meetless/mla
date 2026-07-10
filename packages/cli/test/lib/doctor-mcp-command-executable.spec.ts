import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { mcpCommandExecutable, isPkgSnapshotPath } from "../../src/commands/doctor";

// `mla doctor`'s user-scope MCP check must go RED when ~/.claude.json's
// mcpServers.meetless.command points at a path Claude Code cannot spawn. The prod
// failure this guards: an older @yao-pkg/pkg (Homebrew) binary baked the command
// from process.argv[1] = `/snapshot/.../cli.js`, a snapshot-VFS path with no
// on-disk counterpart, so the meetless__* tools silently never load while a
// presence-only check stayed green. Doctor must catch that and point at `mla rewire`.
describe("mcpCommandExecutable (doctor MCP command health)", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-mcp-cmd-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("is FALSE for the stale /snapshot pkg-VFS path (the ENOENT prod bug)", () => {
    expect(
      mcpCommandExecutable("/snapshot/meetless-cli/packages/cli/dist/cli.js"),
    ).toBe(false);
  });

  it("is FALSE for any absolute path that is missing or non-executable", () => {
    const missing = path.join(root, "nope", "mla");
    expect(mcpCommandExecutable(missing)).toBe(false);

    const notExec = path.join(root, "cli.js");
    fs.writeFileSync(notExec, "console.log('hi')\n");
    fs.chmodSync(notExec, 0o644); // present but not +x
    expect(mcpCommandExecutable(notExec)).toBe(false);
  });

  it("is TRUE for an absolute path that exists and is executable", () => {
    const good = path.join(root, "bin", "mla");
    fs.mkdirSync(path.dirname(good), { recursive: true });
    fs.writeFileSync(good, "#!/bin/sh\n:\n");
    fs.chmodSync(good, 0o755);
    expect(mcpCommandExecutable(good)).toBe(true);
  });

  it("is TRUE for a bare command name (PATH-resolved at spawn, not our call to prove)", () => {
    expect(mcpCommandExecutable("mla")).toBe(true);
  });

  // Regression: under jest (plain Node) the /snapshot path fails accessSync and the
  // guard already returned false, so the case above never proved the ROOT-CAUSE fix.
  // Inside a real pkg binary, @yao-pkg/pkg patches fs so accessSync("/snapshot/...")
  // SUCCEEDS and doctor stayed falsely green (verified live on the 0.2.8 binary). The
  // fix rejects the snapshot mount by prefix, before any fs call. These assertions
  // lock the prefix logic so it can never again depend on what the local fs reports.
  describe("isPkgSnapshotPath (pkg VFS mount, fs-independent)", () => {
    it("is TRUE for the /snapshot POSIX mount", () => {
      expect(isPkgSnapshotPath("/snapshot/meetless-cli/packages/cli/dist/cli.js")).toBe(true);
      expect(isPkgSnapshotPath("/snapshot/x")).toBe(true);
    });

    it("is TRUE for the Windows <drive>:\\snapshot mount", () => {
      expect(isPkgSnapshotPath("C:\\snapshot\\meetless-cli\\dist\\cli.js")).toBe(true);
      expect(isPkgSnapshotPath("D:/snapshot/x")).toBe(true);
    });

    it("is FALSE for a real path that merely contains 'snapshot' (not the mount)", () => {
      expect(isPkgSnapshotPath("/Users/an/snapshots/bin/mla")).toBe(false);
      expect(isPkgSnapshotPath("/opt/snapshot-tool/mla")).toBe(false);
      expect(isPkgSnapshotPath("/opt/homebrew/bin/mla")).toBe(false);
      expect(isPkgSnapshotPath("mla")).toBe(false);
    });
  });
});
