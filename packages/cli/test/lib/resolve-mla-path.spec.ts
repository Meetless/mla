import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveMlaPath } from "../../src/lib/wire";

// resolveMlaPath() is what bakes the absolute mla path into ~/.claude.json's MCP
// `command`, into cli-config.mlaPath, and into what the capture hooks invoke. In a
// @yao-pkg/pkg binary (Homebrew + curl|sh installs) process.argv[1] is the
// snapshot-internal entry `/snapshot/.../cli.js` -- a V8-VFS path with no on-disk
// counterpart. Baking it makes Claude Code spawn a nonexistent file (ENOENT) and the
// Meetless MCP silently never loads. In a pkg binary the REAL executable is
// process.execPath, so resolveMlaPath must canonicalize that, never the snapshot entry.
describe("resolveMlaPath (packaged binary)", () => {
  const proc = process as unknown as { pkg?: unknown };
  const hadPkg = "pkg" in proc;
  const prevPkg = proc.pkg;
  const prevArgv1 = process.argv[1];
  const prevExecPath = process.execPath;

  // A real file on disk to stand in for the installed binary, so realpathSync resolves.
  let root: string;
  let fakeBinary: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-mla-path-"));
    fakeBinary = path.join(root, "bin", "mla");
    fs.mkdirSync(path.dirname(fakeBinary), { recursive: true });
    fs.writeFileSync(fakeBinary, "#!/bin/sh\n:\n");
    fs.chmodSync(fakeBinary, 0o755);
  });

  afterEach(() => {
    if (hadPkg) proc.pkg = prevPkg;
    else delete proc.pkg;
    process.argv[1] = prevArgv1;
    process.execPath = prevExecPath;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("resolves process.execPath, not the /snapshot argv entry, in a pkg binary", () => {
    proc.pkg = { entrypoint: "/snapshot/meetless-cli/packages/cli/dist/cli.js" };
    process.argv[1] = "/snapshot/meetless-cli/packages/cli/dist/cli.js";
    process.execPath = fakeBinary;

    const resolved = resolveMlaPath();

    expect(resolved).not.toContain("/snapshot");
    expect(resolved).toBe(fs.realpathSync(fakeBinary));
  });

  it("still uses process.argv[1] on a source/npm install (no process.pkg)", () => {
    delete proc.pkg;
    process.argv[1] = fakeBinary; // dispatcher script on a real Node
    process.execPath = prevExecPath; // the node binary -- must NOT be chosen here

    const resolved = resolveMlaPath();

    expect(resolved).toBe(fs.realpathSync(fakeBinary));
    expect(resolved).not.toBe(fs.realpathSync(prevExecPath));
  });
});
