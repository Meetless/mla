import * as fs from "fs";
import * as path from "path";

// Durable antidote to the stale-dist footgun. `mla mcp` is a long-lived stdio
// daemon: an editor spawns it once and Node NEVER hot-reloads the dist it loaded
// into memory. So when we `npm run build` a fix (e.g. the /v1/ask 60s timeout)
// the running server keeps serving the OLD code until the editor restarts it.
// That is exactly what produced the recurring "This operation was aborted"
// reports: servers spawned before the timeout fix kept aborting at the old 15s
// deadline, indistinguishable from a genuinely slow synthesis.
//
// scripts/gen-build-info.js stamps dist/build-info.json on EVERY build with a
// fresh `builtAt` (and the git `sha`). makeMcpStaleCheck snapshots that identity
// at spawn and, on each tool call, re-reads the file: if a newer build is on
// disk, THIS process is stale, and the probe returns a one-line operator warning
// to prepend to the tool response. It is forward-looking by construction: it can
// only flag servers that rebuild-without-restart AFTER this code ships (an
// already-stale server runs old code that lacks the probe). It fails OPEN
// everywhere so a dev build (no build-info.json) never nags and a transient read
// error never breaks a tool call.

/** The minimal slice of dist/build-info.json the staleness probe compares on. */
export interface StaleBuildIdentity {
  sha: string;
  builtAt: string;
}

export interface McpStaleCheckDeps {
  // Reads the CURRENT on-disk build identity, or null when none is present
  // (dev build, missing file, or parse error). Injected for tests; the default
  // reads dist/build-info.json fresh on every call.
  readBuildIdentity?: () => StaleBuildIdentity | null;
}

// build-info.json lives at the dist ROOT; this module compiles to dist/lib/, so
// its sibling is one level up. Mirrors observability.ts's path convention, but
// deliberately does NOT reuse loadBuildInfo(): that one caches process-lifetime
// and synthesizes a fresh builtAt when the file is missing, both of which would
// defeat a LIVE staleness probe (a cached spawn value can never differ; a
// synthetic builtAt would false-positive on a real dev build).
const DEFAULT_BUILD_INFO_PATH = path.join(__dirname, "..", "build-info.json");

function defaultReadBuildIdentity(): StaleBuildIdentity | null {
  try {
    const raw = fs.readFileSync(DEFAULT_BUILD_INFO_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<StaleBuildIdentity>;
    if (typeof parsed.builtAt !== "string" || typeof parsed.sha !== "string") {
      return null;
    }
    return { sha: parsed.sha, builtAt: parsed.builtAt };
  } catch {
    return null;
  }
}

/**
 * Build the per-call staleness probe for a long-lived `mla mcp` server. Snapshots
 * the build identity at spawn, then on each call re-reads it and returns a one-
 * line warning when a newer build has landed on disk, else null. Never throws,
 * always fails open: if there was no identity at spawn (dev build), or either
 * read is unavailable, it stays silent.
 */
export function makeMcpStaleCheck(
  deps: McpStaleCheckDeps = {},
): () => string | null {
  const read = deps.readBuildIdentity ?? defaultReadBuildIdentity;
  let spawn: StaleBuildIdentity | null;
  try {
    spawn = read();
  } catch {
    spawn = null;
  }
  return () => {
    // No spawn baseline (dev build) means we cannot tell "rebuilt" from "first
    // ever stamp", so we never nag.
    if (!spawn) return null;
    let current: StaleBuildIdentity | null;
    try {
      current = read();
    } catch {
      return null;
    }
    if (!current) return null;
    if (current.builtAt === spawn.builtAt && current.sha === spawn.sha) {
      return null;
    }
    return staleWarning(spawn, current);
  };
}

// A REBUILD OF THE SAME COMMIT IS STILL A STALE SERVER, and it is the common case on a
// shared tree: a peer runs `npm run build` and a dev build bakes in whatever uncommitted
// working-tree edits were present, so identical shas can produce genuinely different dist
// bytes. The probe is right to fire and the remedy is unchanged.
//
// What it must NOT do is render that as `an OLDER build (55fc10b9d @ ...23.270Z); a newer
// mla build (55fc10b9d @ ...32.031Z)`, which is the literal string a live
// `retrieve_knowledge` call produced on 2026-08-09, nine seconds apart. An operator who
// reads one sha printed twice under "OLDER" and "newer" concludes the CHECK is broken and
// starts discounting it, which costs exactly the credibility this warning exists to spend
// on the day the code really did change. So the same-commit case names itself.
function staleWarning(
  spawn: StaleBuildIdentity,
  current: StaleBuildIdentity,
): string {
  const what =
    spawn.sha === current.sha
      ? `Meetless MCP is serving an OLDER build of the SAME COMMIT ${spawn.sha}, rebuilt since this server started (${spawn.builtAt} -> ${current.builtAt}); a dev build includes uncommitted changes, so the code on disk can differ.`
      : `Meetless MCP is serving an OLDER build (${spawn.sha} @ ${spawn.builtAt}); a newer mla build (${current.sha} @ ${current.builtAt}) is now on disk.`;
  return (
    `${what} Restart your editor so the MCP server reloads; until then every result, ` +
    `including this one, comes from the older code.`
  );
}
