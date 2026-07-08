// Resolve a session value into (a) the concrete sid to scope to and (b) the set of
// note keys that session produced IN A GIVEN WORKSPACE, read from the active-memory
// store the Zone-2 auto-index loop writes (see internal-auto-index.ts). Shared by
// the kb review listing (session default) and any other session-scoped surface.
//
// The join key is the note BASENAME. Verified live 2026-06-07 against control:
// candidate artifactIds are `note:<basename>` while the store records canonicalPath
// as `notes/<basename>`. The route DTO documents notePath as a bare basename. So
// the one normalization that makes the store join the candidate graph is
// basename(canonicalPath).

import * as fs from "fs";
import * as path from "path";
import { HOME } from "./config";
import { reduceActiveMemory } from "./active-memory";
import type { ActiveMemoryRecord } from "./active-memory";
import type { RelationshipCandidate } from "./kb-candidate";

export function noteKey(canonicalPath: string): string {
  // Normalize Windows separators defensively before taking the basename; the
  // store is written on macOS/Linux today, so this is free correctness, not a
  // supported-platform path.
  return path.posix.basename(canonicalPath.replace(/\\/g, "/"));
}

export function noteArtifactId(canonicalPath: string): string {
  return `note:${noteKey(canonicalPath)}`;
}

export class SessionScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionScopeError";
    // Restore the prototype chain so `instanceof` survives ts-jest's ES target.
    Object.setPrototypeOf(this, SessionScopeError.prototype);
  }
}

export function activeMemoryStorePath(): string {
  return path.join(HOME, "logs", "kb-knowledge.jsonl");
}

// Wider window than the auto-index loop (48h/100): a human reviewing "this
// session" may run the command well after the work landed, and the store is small.
export const SCOPE_TTL_HOURS = 168; // 7 days
export const SCOPE_MAX_RECORDS = 1000;

export interface ScopeSessionResolution {
  sessionId: string;
  source: "explicit" | "current-env" | "latest-store";
}

export function resolveScopeSession(
  value: string,
  deps: { env?: NodeJS.ProcessEnv; storePath?: string; workspaceId?: string } = {},
): ScopeSessionResolution {
  const v = value.trim();
  if (v === "") {
    throw new SessionScopeError("--session requires a value (a sid, or 'current' / 'latest')");
  }

  if (v !== "current" && v !== "latest") {
    return { sessionId: v, source: "explicit" };
  }

  if (v === "current") {
    const env = deps.env ?? process.env;
    const sid = (env.CLAUDE_CODE_SESSION_ID || "").trim();
    if (!sid) {
      // NEVER fall back to "latest" silently; that would bind to a different
      // session than the one the operator is in.
      throw new SessionScopeError(
        "--session current needs $CLAUDE_CODE_SESSION_ID, which is not set. " +
          "Run inside a Claude Code session, pass an explicit sid, or use --session latest.",
      );
    }
    return { sessionId: sid, source: "current-env" };
  }

  // v === "latest": explicit, loud opt-in to cross-session selection.
  const storePath = deps.storePath ?? activeMemoryStorePath();
  const sid = latestProducedDocSession(storePath, deps.workspaceId ?? null);
  if (!sid) {
    throw new SessionScopeError(
      `--session latest found no session that produced docs` +
        `${deps.workspaceId ? ` in workspace ${deps.workspaceId}` : ""}. Pass an explicit sid.`,
    );
  }
  return { sessionId: sid, source: "latest-store" };
}

// Latest session that PRODUCED a doc (the queue is scoped by produced docs, so a
// session whose newest event was a tagged_reference is not a useful "latest").
// Workspace-scoped so a foreign repo's session never wins.
function latestProducedDocSession(storePath: string, workspaceId: string | null): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(storePath, "utf8");
  } catch {
    return null;
  }
  let best: { sid: string; t: number } | null = null;
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let r: Partial<ActiveMemoryRecord> & { event?: string };
    try {
      r = JSON.parse(s);
    } catch {
      continue;
    }
    if (r.event !== "active_memory_record" || r.kind !== "produced_doc" || !r.sessionId) continue;
    if (workspaceId && r.workspaceId !== workspaceId) continue;
    const parsed = Date.parse(r.createdAt ?? r.ts ?? "");
    // A record with no usable date cannot meaningfully be "latest"; skip it rather
    // than letting a corrupt timestamp win by defaulting to epoch 0.
    if (!Number.isFinite(parsed)) continue;
    if (!best || parsed >= best.t) best = { sid: r.sessionId, t: parsed };
  }
  return best?.sid ?? null;
}

export interface SessionScope {
  sessionId: string;
  keys: Set<string>; // note basenames the session produced in the workspace
}

// Reduce the active-memory store to the produced-doc note keys for one session in
// one workspace. reduceActiveMemory returns [] on a missing file and filters to
// event === "active_memory_record" + sessionId, so we only add the workspace +
// kind filters here.
export function sessionNoteKeys(
  sessionId: string,
  deps: { workspaceId: string; storePath?: string; nowMs: number },
): SessionScope {
  const storePath = deps.storePath ?? activeMemoryStorePath();
  const records = reduceActiveMemory(storePath, {
    sessionId,
    ttlHours: SCOPE_TTL_HOURS,
    maxRecords: SCOPE_MAX_RECORDS,
    nowMs: deps.nowMs,
  });
  const keys = new Set<string>();
  for (const r of records) {
    if (r.kind !== "produced_doc") continue;
    if (r.workspaceId !== deps.workspaceId) continue;
    keys.add(noteKey(r.canonicalPath));
  }
  return { sessionId, keys };
}

function stripNotePrefix(artifactId: string | null): string | null {
  if (!artifactId) return null;
  return artifactId.startsWith("note:") ? artifactId.slice("note:".length) : null;
}

// A candidate belongs to the session if EITHER endpoint is a note the session
// produced (the detected edge can put the new doc on the source or target side).
export function candidateInSession(c: RelationshipCandidate, keys: Set<string>): boolean {
  const s = stripNotePrefix(c.sourceArtifactId);
  const t = stripNotePrefix(c.targetArtifactId);
  return (s !== null && keys.has(s)) || (t !== null && keys.has(t));
}

export interface SessionScopeResult {
  sessionId: string;
  source: ScopeSessionResolution["source"];
  keys: Set<string>;
}

// Convenience used by the command entrypoints: resolve the value, then load keys.
export function loadSessionScope(
  value: string,
  deps: { env?: NodeJS.ProcessEnv; storePath?: string; workspaceId: string; nowMs: number },
): SessionScopeResult {
  const resolved = resolveScopeSession(value, {
    env: deps.env,
    storePath: deps.storePath,
    workspaceId: deps.workspaceId,
  });
  const scope = sessionNoteKeys(resolved.sessionId, {
    workspaceId: deps.workspaceId,
    storePath: deps.storePath,
    nowMs: deps.nowMs,
  });
  return { sessionId: resolved.sessionId, source: resolved.source, keys: scope.keys };
}
