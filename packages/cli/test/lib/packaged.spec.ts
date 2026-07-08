import { isPackagedBinary } from "../../src/lib/packaged";

// `mla` ships two ways: a pkg-compiled standalone binary and a source/npm
// install on a real Node. The standalone binary's V8 snapshot has no ESM
// dynamic-import callback, so the ESM-only @meetless/ask-core and @meetless/mcp
// ship as CJS bundles the binary loads via require(). isPackagedBinary() is the
// detector the loaders (commands/ask.ts, commands/mcp.ts) use to decide whether
// a require failure may fall back to the ESM source (dev only) or must surface
// (binary, where a true import() cannot run).
describe("isPackagedBinary", () => {
  const proc = process as unknown as { pkg?: unknown };
  const had = "pkg" in proc;
  const prev = proc.pkg;
  afterEach(() => {
    if (had) proc.pkg = prev;
    else delete proc.pkg;
  });

  it("is false in a normal Node process (source/npm install)", () => {
    delete proc.pkg;
    expect(isPackagedBinary()).toBe(false);
  });

  it("is true when process.pkg is present (pkg binary)", () => {
    proc.pkg = { entrypoint: "/snapshot/cli/dist/cli.js" };
    expect(isPackagedBinary()).toBe(true);
  });
});
