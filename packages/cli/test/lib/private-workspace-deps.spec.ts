import * as fs from "fs";
import * as path from "path";

/**
 * A PRIVATE workspace package must never be a RUNTIME dependency of `@meetless/mla`.
 *
 * `@meetless/ask-core`, `@meetless/mcp`, `@meetless/trace-core` and
 * `@meetless/native-auth` are all `private: true` and none is on the npm registry.
 * A `workspace:*` entry under `dependencies` publishes fine and then fails at
 * INSTALL time for every user: `npm i -g @meetless/mla` cannot resolve a package
 * that does not exist publicly. The pkg binary has the same problem for a
 * different reason (its V8 snapshot has no ESM dynamic-import callback).
 *
 * The fix in both cases is the same and already exists: scripts/bundle-esm.js
 * compiles each one into a self-contained CJS bundle under dist/bundles/, the
 * consumer require()s the bundle, and the package stays a build-only
 * devDependency.
 *
 * THIS TEST EXISTS BECAUSE THE BREAK HAPPENED. Extracting the login flow into
 * `@meetless/native-auth` (B4, 2026-08-20) added it to `dependencies`, and every
 * one of the 8,037 tests still passed: nothing in the suite could see a packaging
 * fault, because a pnpm workspace resolves the symlink locally and the build
 * succeeds. It would have shipped and broken the next `npm i -g`. The bundler's
 * own header warns about exactly this in exactly these words, which is what makes
 * it worth a gate rather than a comment.
 */
describe("no private workspace package is a runtime dependency", () => {
  const cliDir = path.resolve(__dirname, "..", "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(cliDir, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  const workspaceDeps = Object.entries(pkg.dependencies ?? {}).filter(([, v]) =>
    v.startsWith("workspace:"),
  );

  it("declares NO workspace:* entry under dependencies", () => {
    expect(workspaceDeps.map(([name]) => name)).toEqual([]);
  });

  it("keeps every @meetless/* workspace package as a build-only devDependency", () => {
    const dev = Object.entries(pkg.devDependencies ?? {}).filter(
      ([name, v]) => name.startsWith("@meetless/") && v.startsWith("workspace:"),
    );
    // If this list shrinks, either a package was dropped or one moved into
    // `dependencies`; both are worth a look.
    expect(dev.map(([name]) => name).sort()).toEqual([
      "@meetless/ask-core",
      "@meetless/mcp",
      "@meetless/native-auth",
      "@meetless/trace-core",
    ]);
  });

  it("bundles every one of them, so the require() at runtime has something to find", () => {
    const bundler = fs.readFileSync(path.join(cliDir, "scripts", "bundle-esm.js"), "utf8");
    for (const name of ["ask-core", "mcp", "trace-core", "native-auth"]) {
      // The bundle name AND the sentinel check, so a package added to the bundler
      // without a verification entry (which would let a broken bundle ship
      // silently) still fails here.
      expect(bundler).toContain(`"${name}",`);
      expect(bundler).toContain(`${name}.js`);
    }
  });
});
