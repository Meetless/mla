#!/usr/bin/env node
// bundle-esm.js: compile the workspace packages the CLI loads at runtime
// (@meetless/ask-core, @meetless/mcp, @meetless/trace-core) into self-contained
// CommonJS bundles under dist/bundles/.
//
// Why (ESM packages): the @yao-pkg/pkg standalone binary runs a V8 snapshot
// that has NO ESM dynamic-import callback registered, so a true runtime import()
// throws "A dynamic import callback was not specified" inside it. That is why
// `mla ask` and `mla mcp` could not run from the binary. Bundling these ESM deps
// down to CommonJS lets the CLI load them with a plain require(), which the
// snapshot fully supports.
//
// Why (trace-core, already CJS): it is bundled here so that the PUBLISHED
// @meetless/mla npm package and the pkg binary both carry it with ZERO
// `workspace:*` runtime dependencies. `@meetless/trace-core` is private and not
// on the registry, so a real runtime dep would make `npm i -g @meetless/mla`
// fail to resolve it. Bundling it (it pulls in only the `crypto` builtin, so the
// output is fully self-contained) lets observability.ts require() the bundle and
// drop trace-core to a build-only devDependency.
//
// The bundles are emitted as dist/bundles/*.js so the existing pkg config
// (scripts: ["dist/**/*.js"]) embeds them with no extra wiring.
//
// Runs after tsc in the package `build` script. Fails loudly if a bundle is
// missing its sentinel export, so a broken bundle never ships silently.
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const cliDir = path.resolve(__dirname, "..");
const outDir = path.join(cliDir, "dist", "bundles");
fs.mkdirSync(outDir, { recursive: true });

// Shared esbuild options. `packages` is intentionally omitted: with bundle:true
// esbuild inlines every third-party dependency (including
// @modelcontextprotocol/sdk for the MCP server) so the output has no leftover
// import()/require of an external ESM package. Node builtins stay external
// automatically under platform:node.
const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  logLevel: "warning",
};

async function bundleFromSpecifiers(label, contents, outfile, extra = {}) {
  await esbuild.build({
    ...common,
    ...extra,
    // A synthetic entry that re-exports the symbols the CLI consumes. resolveDir
    // is the CLI package dir so node resolution finds @meetless/* via the CLI's
    // own node_modules (pnpm workspace symlinks).
    stdin: { contents, resolveDir: cliDir, loader: "js" },
    outfile,
  });
}

// @meetless/mcp computes `__filename = fileURLToPath(import.meta.url)` (ESM has
// no __filename). `import.meta.url` is empty in a CJS bundle, so requiring the
// bundle would throw on fileURLToPath(undefined). Shim it to the bundle's own
// path: it is only used for a notesRoot fallback (the CLI passes notesRoot
// explicitly, so the fallback is dead) and a run-as-main check (which must stay
// false when require()'d, and a self-referential __filename != argv[1] keeps it
// false). define rewrites the token; the banner supplies a real file URL.
const IMPORT_META_SHIM = {
  define: { "import.meta.url": "__mla_import_meta_url" },
  banner: {
    js: "const __mla_import_meta_url = require('url').pathToFileURL(__filename).href;",
  },
};

async function main() {
  // ask-core ships three flat ESM modules; the CLI needs symbols from all three.
  await bundleFromSpecifiers(
    "ask-core",
    'export { makeIntelAsk, makeAskModes } from "@meetless/ask-core/ask_modes.js";\n' +
      'export { statusFallback } from "@meetless/ask-core/status_fallback.js";\n' +
      'export { makeMatchCanonical } from "@meetless/ask-core/match_canonical.js";\n',
    path.join(outDir, "ask-core.js"),
  );

  // mcp: only runStdioServer is the CLI's entry point into the server; esbuild
  // pulls in the rest of @meetless/mcp + the MCP SDK transitively.
  await bundleFromSpecifiers(
    "mcp",
    'export { runStdioServer } from "@meetless/mcp";\n',
    path.join(outDir, "mcp.js"),
    IMPORT_META_SHIM,
  );

  // trace-core: observability.ts consumes only these two factories at runtime
  // (everything else it imports from trace-core is a type, erased at compile).
  // Bundling them lets the published package carry trace-core with no runtime
  // workspace dep. Already CJS + crypto-only, so no import.meta shim needed.
  await bundleFromSpecifiers(
    "trace-core",
    'export { makeTracer, makeNoopTracer } from "@meetless/trace-core";\n',
    path.join(outDir, "trace-core.js"),
  );

  // Verify each bundle is a requirable CJS module exposing its sentinel symbol.
  const checks = [
    ["ask-core.js", ["makeIntelAsk", "makeAskModes", "statusFallback", "makeMatchCanonical"]],
    ["mcp.js", ["runStdioServer"]],
    ["trace-core.js", ["makeTracer", "makeNoopTracer"]],
  ];
  for (const [name, syms] of checks) {
    const p = path.join(outDir, name);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(p);
    for (const sym of syms) {
      if (typeof mod[sym] !== "function") {
        throw new Error(`${name} did not export ${sym}() (got ${typeof mod[sym]})`);
      }
    }
  }

  console.log(`bundle-esm: wrote ${path.relative(cliDir, outDir)}/{ask-core,mcp,trace-core}.js`);
}

main().catch((e) => {
  console.error(`bundle-esm: ${e && e.message ? e.message : e}`);
  process.exit(1);
});
