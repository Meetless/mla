import * as path from "path";
import { pathToFileURL } from "url";
import { renderPlain } from "../lib/ask-render";
import { documentationImpact } from "../lib/ask-documentation-impact";
import { loadWorkspaceConfig } from "../lib/config";
import { DEFAULT_INTEL_URL } from "../lib/http";
import { bestEffortNotesRoot } from "../lib/notes-root";
import {
  liveReconciliationFindings,
  makeArtifactByteReader,
} from "../lib/scanner/reconciliation-live";
import { parseAsOf } from "../lib/temporal";
import { isPackagedBinary } from "../lib/packaged";
import { findWorkspaceContext } from "../lib/workspace";
import { readScanCacheForRoot } from "./scan-context";

// `mla ask`: the CLI front-end over the shared @meetless/ask-core ask
// implementation (proposal 20260529 T5 / D-D). It reuses the SAME mode routing
// the MCP uses (answer / search / canonical / compare) and points at the
// workspace `mla` already ingests into (cfg.workspaceId, ws_an_local for the
// dogfood config). That makes ingest and answer coherent by construction: there
// is no second tool resolving a different env workspace, so the "silent
// workspace drift" the MCP warns about cannot happen for the dogfood loop. A
// fresh process per invocation also sidesteps the stale-MCP-daemon footgun
// (memory intel_stale_mcp_server_workspace_ignored.md).
//
// Hard invariant (An): `mla` must NOT depend on `meetless-mcp`. ask-core is the
// shared package; MCP and mla are two front-ends; intel is the execution
// backend. We import ask-core directly, never through the MCP.

type Mode = "answer" | "search" | "canonical" | "compare";
const MODES: Mode[] = ["answer", "search", "canonical", "compare"];

interface AskArgs {
  query: string;
  mode: Mode;
  workspaceId?: string;
  maxResults?: number;
  minResults?: number;
  json: boolean;
  // B9: a VALID-time point-in-time cutoff (UTC ISO-8601 instant), set by
  // `--as-of <date>`. When present, runAsk forwards it as the intel ask body's
  // `as_of` so the answer is pinned to what was true at that instant.
  asOf?: string;
}

// Minimal local type surface for the dynamically-imported ESM package. Kept
// local (not imported from ask-core's index.d.ts) so `mla`'s build stays
// self-contained and never has to resolve a cross-package declaration that
// lives outside its rootDir. ask-core still ships its own index.d.ts for other
// consumers.
type AskModeHandler = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
interface AskCore {
  makeIntelAsk: (deps: { intelBaseUrl: string; apiKey: string; fetchImpl?: typeof fetch }) => unknown;
  makeAskModes: (deps: {
    intelAsk: unknown;
    defaultWorkspaceId: string;
    matchCanonical: (query: string) => { matches: unknown[]; reason: string };
    statusFallback: unknown;
  }) => {
    runAnswer: AskModeHandler;
    runSearch: AskModeHandler;
    runCanonical: AskModeHandler;
    runCompare: AskModeHandler;
  };
  statusFallback: unknown;
  makeMatchCanonical: (deps: { notesRoot: string }) => (query: string) => { matches: unknown[]; reason: string };
}

export function parseArgs(argv: string[]): AskArgs {
  const out: AskArgs = { query: "", mode: "answer", json: true };
  let sawQuery = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mode") {
      const v = argv[++i] as Mode;
      if (!MODES.includes(v)) {
        throw new Error(`Unknown mode '${v ?? ""}'. Valid: ${MODES.join(", ")}.`);
      }
      out.mode = v;
    } else if (a === "--workspace" || a === "--workspace-id") {
      out.workspaceId = argv[++i];
    } else if (a === "--max") {
      out.maxResults = Number(argv[++i]);
    } else if (a === "--min") {
      out.minResults = Number(argv[++i]);
    } else if (a === "--as-of") {
      // parseAsOf throws on a malformed date; the throw propagates out of
      // parseArgs and runAsk maps it to exit 2, so a typo never silently
      // answers as-of "now".
      out.asOf = parseAsOf(argv[++i] ?? "");
    } else if (a === "--plain") {
      out.json = false;
    } else if (a === "--json") {
      out.json = true;
    } else if (a.startsWith("--")) {
      throw new Error(`Unknown flag for \`mla ask\`: ${a}`);
    } else if (!sawQuery) {
      out.query = a;
      sawQuery = true;
    } else {
      throw new Error(`Unexpected positional argument: ${a} (quote the query as a single argument).`);
    }
  }
  if (!out.query.trim()) {
    throw new Error(`Usage: mla ask "<query>" [--mode answer|search|canonical|compare] [--workspace <id>] [--as-of <date>] [--max <n>] [--min <n>] [--plain]`);
  }
  return out;
}

// ask-core is plain ESM; `mla` compiles to CommonJS. A literal dynamic import()
// would be downleveled by tsc to require(), which cannot load an ESM-only
// package on Node < 22. The Function constructor preserves a TRUE runtime
// import() so it works on every supported Node (>=18.18). Used only by the dev
// fallback below (ts-node, no built dist). Resolve ask-core as a sibling package
// directory (packages/ask-core), three levels up from the compiled commands dir
// (dist/commands -> dist -> cli -> packages).
const trueDynamicImport = new Function("u", "return import(u)") as (u: string) => Promise<unknown>;

function askCoreDir(): string {
  return path.resolve(__dirname, "..", "..", "..", "ask-core");
}

// The CJS bundle the build emits (scripts/bundle-esm.js -> dist/bundles/). It
// sits a sibling level up from the compiled commands dir: dist/commands -> dist
// -> dist/bundles.
function bundlePath(name: string): string {
  return path.resolve(__dirname, "..", "bundles", name);
}

// Best-effort: the standalone notes repo is a sibling of the CODE repo. This
// used to be a `__dirname`-relative walk-up, which only ever resolved from a
// source checkout: once the CLI is installed (npm global, brew, the curl
// bundle), `__dirname` sits under node_modules / the Cellar and the five `..`
// hops land somewhere meaningless, so the INDEX.md canonical matcher was dead
// for every real install and silently degraded to plain retrieval. Anchor on the
// operator's marker repo instead, the same ladder `mla mcp` and `mla kb *` walk.
// A missing INDEX.md still degrades to retrieval, so an imperfect guess is
// non-fatal.
function notesRoot(): string {
  const ctx = findWorkspaceContext();
  return bestEffortNotesRoot(ctx?.markerDir ?? process.cwd());
}

// Load ask-core from its ESM source files (the original path). Kept as the dev
// fallback for `pnpm dev` (ts-node), where no dist/bundles exists. Never reached
// inside the pkg binary: a true import() throws there (no ESM dynamic-import
// callback in the V8 snapshot), which is exactly why the bundle exists.
async function loadAskCoreFromSource(): Promise<AskCore> {
  const dir = askCoreDir();
  const askModes = (await trueDynamicImport(pathToFileURL(path.join(dir, "ask_modes.js")).href)) as Pick<
    AskCore,
    "makeIntelAsk" | "makeAskModes"
  >;
  const sf = (await trueDynamicImport(pathToFileURL(path.join(dir, "status_fallback.js")).href)) as Pick<AskCore, "statusFallback">;
  const mc = (await trueDynamicImport(pathToFileURL(path.join(dir, "match_canonical.js")).href)) as Pick<AskCore, "makeMatchCanonical">;
  return { ...askModes, ...sf, ...mc };
}

// Prefer the bundled CJS: require() works inside the pkg snapshot, unlike a true
// import(). On a source/npm install the bundle is present after `pnpm build`.
// The dev fallback covers ts-node (`pnpm dev`), where no dist exists yet.
async function loadAskCore(): Promise<AskCore> {
  try {
    return require(bundlePath("ask-core.js")) as AskCore;
  } catch (e) {
    // Inside the binary there is no source tree to fall back to, and require of
    // an embedded bundle should never fail; surface the real error rather than
    // attempting a true import() that the snapshot cannot host.
    if (isPackagedBinary()) throw e;
    // Dev/source without a built dist (ts-node): only fall through on a genuine
    // "module not found"; a real load error inside the bundle must surface.
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code !== "MODULE_NOT_FOUND" && code !== "ERR_MODULE_NOT_FOUND") throw e;
    return loadAskCoreFromSource();
  }
}

// An answer with nothing under it. `mla ask` is grounded-or-silent: intel returns
// prose ONLY when it found something in the workspace's governed memory to stand
// on, so zero citations means the corpus had nothing to say. That is the exact
// shape of the miss we can help with (§7.5): the most common reason the user's
// governed memory cannot answer a question is that the question was never about
// their memory; it was about mla itself, and mla's manual is a DIFFERENT corpus
// behind a DIFFERENT command. A fixed hint on a fixed condition; deliberately not
// a classifier, which would have to guess at the user's intent and would be wrong
// in a way that costs trust.
function isUngroundedAnswer(result: Record<string, unknown>): boolean {
  const results = Array.isArray(result.results) ? result.results : [];
  return results.length === 0;
}

// ADR §3.5 T11d. Attach the documentation-impact list when the answer cited a decision that an
// instruction file in THIS checkout still contradicts.
//
// The gate is the SHARED one (lib/scanner/reconciliation-live.ts), so a finding the hook has gone
// quiet about (stale pull, drifted file) cannot still be asserted here. The cache read is the
// checkout-guarded one, so a sibling checkout's findings never surface as this repo's.
//
// STRICTLY best-effort and never load-bearing: the ask already succeeded and its answer is already
// computed by the time we get here. A missing cache, an unscanned workspace, an unreadable file, or
// a throw anywhere in the chain costs one optional line, never the answer.
function attachDocumentationImpact(result: Record<string, unknown>, workspaceId: string): void {
  try {
    const repoRoot = findWorkspaceContext()?.markerDir;
    const cache = readScanCacheForRoot(undefined, workspaceId);
    if (!cache) return;
    const live = liveReconciliationFindings(
      cache,
      makeArtifactByteReader(repoRoot),
      new Date().toISOString(),
    );
    const impact = documentationImpact(result.answer, live.kept.map((o) => o.finding));
    if (impact.length > 0) result.documentationImpact = impact;
  } catch {
    /* an advisory cross-check is never worth failing an answer over */
  }
}

// The ask-core loader is injectable so the glue (workspace resolution, mode
// routing, render, error->exit-code mapping) can be unit-tested without the
// true runtime import(): jest's VM sandbox rejects native dynamic import
// unless run with --experimental-vm-modules, and ask-core is ESM-only. The
// REAL dynamic import is proven by a runtime smoke against the built binary,
// not by jest. cli.ts always calls the single-arg form, so the seam never
// reaches the shipped path.
export async function runAsk(
  argv: string[],
  deps: { loadCore?: () => Promise<AskCore> } = {},
): Promise<number> {
  let args: AskArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  // Folder = workspace (T1.1): resolve the workspace from the nearest marker,
  // honoring `--workspace <id>` as an explicit override so an operator can ask
  // against another workspace from an unbound directory without tripping the
  // "not activated" guard. Loading after parseArgs is what lets the override
  // short-circuit marker resolution.
  const cfg = loadWorkspaceConfig(args.workspaceId);

  const intelUrl = cfg.intelUrl || DEFAULT_INTEL_URL;
  // cfg.controlToken IS intel's INTERNAL_API_KEY in the dogfood config (same
  // bearer the hook uses for /v1/ask; see lib/http.ts).
  const apiKey = cfg.controlToken;
  const effectiveWorkspace = cfg.workspaceId;

  let core: AskCore;
  try {
    core = await (deps.loadCore ?? loadAskCore)();
  } catch (e) {
    console.error(`failed to load @meetless/ask-core: ${(e as Error).message}`);
    return 1;
  }

  const intelAsk = core.makeIntelAsk({ intelBaseUrl: intelUrl, apiKey });
  const matchCanonical = core.makeMatchCanonical({ notesRoot: notesRoot() });
  const modes = core.makeAskModes({
    intelAsk,
    defaultWorkspaceId: effectiveWorkspace,
    matchCanonical,
    statusFallback: core.statusFallback,
  });

  const callArgs: Record<string, unknown> = {
    query: args.query,
    workspace_id: effectiveWorkspace,
  };
  if (args.maxResults !== undefined) callArgs.maxResults = args.maxResults;
  if (args.minResults !== undefined) callArgs.minResults = args.minResults;
  // B9: forward the valid-time cutoff ONLY when the operator set it, so the live
  // (no --as-of) path stays byte-identical to today. The one-line banner goes to
  // stderr so `mla ask` stdout stays pure JSON for piping.
  if (args.asOf) {
    callArgs.as_of = args.asOf;
    console.error(
      `Point-in-time answer as of ${args.asOf} (relations not yet valid at that instant are excluded).`,
    );
  }

  const handler: AskModeHandler =
    args.mode === "search"
      ? modes.runSearch
      : args.mode === "canonical"
        ? modes.runCanonical
        : args.mode === "compare"
          ? modes.runCompare
          : modes.runAnswer;

  let result: Record<string, unknown>;
  try {
    result = await handler(callArgs);
  } catch (e) {
    const msg = (e as Error).message || String(e);
    if (/ECONNREFUSED|fetch failed|ENOTFOUND/i.test(msg)) {
      console.error(`intel not reachable at ${intelUrl}. Is it running? Try \`mla doctor\`.`);
    } else {
      console.error(`mla ask failed: ${msg}`);
    }
    return 1;
  }

  // Echo the effective workspace so the caller always sees which corpus
  // answered (mirrors the MCP's server.js behavior; makes ingest/answer drift
  // impossible to miss).
  if (result && typeof result === "object") {
    result.workspace = effectiveWorkspace;
    // Before the render, so BOTH the --json and the plain path carry it (§3.5 T11d).
    attachDocumentationImpact(result, effectiveWorkspace);
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(renderPlain(result));
  }

  // §7.5. On stderr, so it never contaminates the JSON on stdout that scripts and
  // the hook parse. Not an error and not an exit-code change: the ask succeeded,
  // the memory simply had nothing, and this is the one thing we know that the user
  // might not.
  if (isUngroundedAnswer(result)) {
    console.error('Asking about mla itself? Try: mla docs ask "..."');
  }
  return 0;
}
