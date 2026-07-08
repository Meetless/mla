import { readFileSync } from "fs";
import * as path from "path";

import { HOME, loadWorkspaceConfig, WorkspaceCliConfig } from "../lib/config";
import { reduceActiveMemory, ActiveMemoryRecord } from "../lib/active-memory";
import { intelPost, get } from "../lib/http";
import { runActiveReview, IntelDetectClient } from "../lib/active-review-runner";
import { Advisory, Detection } from "../lib/conflict-advisory";
import { supersessionAdvisory, KbRelationFact } from "../lib/tagged-reference";

// `mla _internal active-review --session <sid>` (Phase 1, Active Review).
//
// Fired by the UserPromptSubmit hook's Layer 3 AFTER the turn counter advances.
// It reviews the PRIOR turn's produced docs (the Active Memory store the
// PostToolUse hook appends to ~/.meetless/logs/kb-knowledge.jsonl) for conflict
// with the workspace's approved knowledge and prints an advisory the hook
// injects as additionalContext. Two contracts mirror the runner:
//   - dry-run only (no persistence; the detect call is always dryRun:true).
//   - advise-never-block (P6): this command NEVER throws past the dispatcher and
//     NEVER exits non-zero on a review miss; a failure prints an empty advisory
//     and exits 0 so the hook simply injects nothing.
//
// Hermetic test seam: when MEETLESS_ACTIVE_REVIEW_STUB_DETECT is set (non-empty)
// the intel client is a stub that returns that parsed JSON instead of making a
// real HTTP call, so the hook test stays offline. Otherwise the real client
// POSTs to intel /internal/v1/active-review/detect.
//
// A3 (Phase 2): on top of the Phase 1 conflict advisories, this command also
// renders supersession/contradiction advisories for the docs the user NAMED this
// session (the tagged_reference captures the UserPromptSubmit hook appends). The
// pure engine (tagged-reference.ts) joins those paths against APPROVED relation
// facts; the facts come from control's relationship-candidates list endpoint
// (statusId=ACCEPTED, posture=LIVE), the same read kb pending uses. Its hermetic
// seam is MEETLESS_TAGGED_FACTS_STUB (parsed as a KbRelationFact[] JSON). The
// supersession fetch is best-effort and advise-never-block (P6): any failure
// degrades to an empty fact list, so the supersession advisory simply does not
// render; the join engages the moment approved facts exist for a named doc.

// The store the PostToolUse hook appends to. Path + filename are byte-identical
// to common.sh LOG_DIR/kb-knowledge.jsonl so both sides resolve the same file
// under MEETLESS_HOME.
function activeMemoryStorePath(): string {
  return path.join(HOME, "logs", "kb-knowledge.jsonl");
}

// TTL + cap for the read-time reduction. 48h matches the Active Memory store's
// own dedup/TTL intent; 100 is a generous per-review cap (a single turn produces
// only a handful of docs).
const TTL_HOURS = 48;
const MAX_RECORDS = 100;
// V1 confidence floor for the conflict-advisory policy. A detection below this
// is a weak signal and produces no advisory (the policy logs but does not flag).
const MIN_CONFIDENCE = 0.6;

// Stub client: returns the operator-supplied detect response verbatim. Used by
// the hook test so it never touches the network. The stub JSON is the same shape
// the real endpoint returns ({ detections, persisted }).
function stubIntelClient(stubJson: string): IntelDetectClient {
  return {
    detect: async () => {
      const parsed = JSON.parse(stubJson) as { detections?: Detection[]; persisted?: boolean };
      return { detections: parsed.detections ?? [], persisted: parsed.persisted ?? false };
    },
  };
}

// Read the produced doc's CURRENT on-disk content so the in-process detector has
// real text to score against the owner's approved corpus. Mirrors the Zone 2
// auto-index eligibility (auto-index.ts selectIndexTargets): only a produced_doc
// that carries a repoRoot is resolvable. A tagged_reference is a doc the user
// NAMED (handled by the A3 supersession join, not detect), and a record without a
// repoRoot predates Phase A and cannot be located on disk. The absolute repoRoot
// is LOCAL-only and never leaves the machine: we join it with the RELATIVE
// canonicalPath, read the file, and put only the CONTENT on the wire. Best-effort
// (P6): an ineligible record or an unreadable file (moved/deleted since capture)
// yields an empty body, which the detect endpoint skips as a no-op, so a review
// can never throw on a vanished doc.
function readCandidateBody(rec: ActiveMemoryRecord): string {
  if (rec.kind !== "produced_doc") return "";
  const root = (rec.repoRoot || "").trim();
  if (!root) return "";
  try {
    return readFileSync(path.join(root, rec.canonicalPath), "utf8");
  } catch {
    return "";
  }
}

// Real client: POST the dry-run review request to intel. Carries the env-pinned
// workspace AND the owner so the detection scope is built server-side, never a
// parameter the caller widens.
function realIntelClient(cfg: WorkspaceCliConfig): IntelDetectClient {
  return {
    detect: async (req) => {
      // INV-DETECTION-OWNER-SCOPED: the endpoint builds an owner-scoped corpus,
      // so ownerUserId is required. Without a configured actor we cannot name an
      // owner; throw so the runner's P6 catch degrades to an empty advisory
      // rather than POSTing a request the endpoint validates away as a 422
      // (which would degrade silently and look like "no conflicts").
      const ownerUserId = (cfg.actorUserId || "").trim();
      if (!ownerUserId) {
        throw new Error("active-review detect requires actorUserId (owner scope)");
      }
      // Map each metadata-only Active Memory record to the endpoint's candidate
      // wire shape (ActiveReviewCandidate {canonicalPath, body, kind}). The Zone 1
      // spool captures metadata only (contentHash, no doc body, by privacy
      // design), so at review time we read the produced doc's CURRENT content from
      // disk (readCandidateBody: repoRoot-resolved, LOCAL-only, best-effort) and
      // send THAT as body, which the in-process detector embeds and scores against
      // the owner-scoped corpus. Sending the raw record would 422 (no `body`) and
      // leak internal field names onto the wire.
      const candidates = req.candidates.map((c) => ({
        canonicalPath: c.canonicalPath,
        body: readCandidateBody(c),
        kind: c.kind,
      }));
      return intelPost<{ detections: Detection[]; persisted: boolean }>(
        cfg,
        "/internal/v1/active-review/detect",
        { workspaceId: cfg.workspaceId, ownerUserId, dryRun: req.dryRun, candidates },
        8000,
      );
    },
  };
}

// ---- A3 tagged_reference -> supersession advisory ------------------------
// The supersession join (pure engine in tagged-reference.ts) needs the set of
// LIVE/ACCEPTED relation FACTS for the docs the user named this session. A
// TaggedFactsClient supplies them; like IntelDetectClient it has a hermetic stub
// and a best-effort real implementation, and like Active Review it advises and
// never blocks (P6): a fetch failure degrades to an empty fact list, never a throw.
export interface TaggedFactsClient {
  fetch: (referencedPaths: string[]) => Promise<KbRelationFact[]>;
}

// Stub client: returns the operator-supplied facts verbatim (MEETLESS_TAGGED_FACTS_STUB,
// parsed as a KbRelationFact[] JSON). Used by tests so the merge runs offline.
function stubTaggedFactsClient(stubJson: string): TaggedFactsClient {
  return {
    fetch: async () => {
      const parsed = JSON.parse(stubJson) as KbRelationFact[];
      return Array.isArray(parsed) ? parsed : [];
    },
  };
}

// Real client: read APPROVED relation facts (statusId=ACCEPTED, posture=LIVE) for
// each referenced doc from control's relationship-candidates list endpoint, the
// same read kb pending uses (GET /internal/v1/relationship-candidates). We query
// per path by notePath, keep only conflict relations (SUPERSEDED_BY / CONTRADICTS),
// and map each row into a KbRelationFact whose fromPath is the doc the user named
// and whose toKbId/toPath is the row's target artifact. Best-effort: any error on
// any path is swallowed and yields no facts for it, so the supersession advisory
// degrades to empty rather than throwing (P6). Only the ACCEPTED/LIVE filter is
// trusted; the pure engine re-checks posture/status so an unapproved row can never
// leak even if the server filter were ever loosened.
//
// Config is loaded LAZILY, inside fetch and only if there is at least one path to
// resolve, via the supplied getter. The Phase 1 path must never pay a config load
// (or its possible throw) when the A3 path has nothing to do; loading eagerly here
// would couple a config failure to the unrelated conflict advisory.
function realTaggedFactsClient(getCfg: () => WorkspaceCliConfig): TaggedFactsClient {
  return {
    fetch: async (referencedPaths) => {
      if (referencedPaths.length === 0) return [];
      const cfg = getCfg();
      const facts: KbRelationFact[] = [];
      for (const p of referencedPaths) {
        try {
          const qs = new URLSearchParams();
          qs.set("workspaceId", cfg.workspaceId);
          qs.set("statusId", "ACCEPTED");
          qs.set("posture", "LIVE");
          qs.set("limit", "20");
          if (p.includes(":")) qs.set("artifactId", p);
          else qs.set("notePath", p);
          const res = await get<{ items?: RelationRow[] }>(
            cfg,
            `/internal/v1/relationship-candidates?${qs.toString()}`,
            8000,
          );
          for (const row of res.items ?? []) {
            const relationType = row.relationTypeId ?? "";
            if (relationType !== "SUPERSEDED_BY" && relationType !== "CONTRADICTS") continue;
            const toId = row.targetArtifactId ?? "";
            if (!toId) continue;
            facts.push({
              fromPath: p,
              relationType,
              toPath: toId,
              toKbId: toId,
              posture: (row.postureId as KbRelationFact["posture"]) ?? "LIVE",
              status: (row.statusId as KbRelationFact["status"]) ?? "ACCEPTED",
            });
          }
        } catch {
          // best-effort: this path contributes no facts; never a throw (P6).
        }
      }
      return facts;
    },
  };
}

// The subset of the relationship-candidates row this read needs. The endpoint
// returns the full candidate; we only join on these fields.
interface RelationRow {
  relationTypeId?: string;
  targetArtifactId?: string | null;
  postureId?: string;
  statusId?: string;
}

// Strict argv parsing: `mla _internal active-review --session <sid>`. The
// --session flag is optional (absent reviews every record in the store); any
// other flag is rejected so a hook template typo surfaces loudly rather than
// silently binding the wrong value.
export function parseArgs(argv: string[]): { sessionId: string | null } {
  let sessionId: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--session") {
      sessionId = argv[i + 1] ?? null;
      i++;
      continue;
    }
    if (a.startsWith("-")) {
      throw new Error(
        `Unknown flag: ${a}. \`mla _internal active-review\` takes only [--session <sid>].`,
      );
    }
    throw new Error(
      `Unexpected positional argument: ${a}. \`mla _internal active-review\` takes only [--session <sid>].`,
    );
  }
  return { sessionId };
}

// Render the advisory text the hook injects: one terse line per cited doc naming
// the candidate path, the conflict relation, the cited id, and the cited quote.
// Plain text (no markdown headers); multiple advisories are newline-joined.
export function renderAdvisoryText(advisories: Advisory[]): string {
  if (advisories.length === 0) return "";
  return advisories
    .map(
      (a) =>
        `Active Review: ${a.candidatePath} may ${a.relationType} approved ${a.citedKbId} ("${a.citedQuote}").`,
    )
    .join("\n");
}

export async function runInternalActiveReview(argv: string[]): Promise<number> {
  let sessionId: string | null;
  try {
    ({ sessionId } = parseArgs(argv));
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  // advise-never-block (P6): from here on, every failure path prints an empty
  // advisory and exits 0 so the hook injects nothing rather than the turn seeing
  // a non-zero review.
  try {
    const records = reduceActiveMemory(activeMemoryStorePath(), {
      nowMs: Date.now(),
      ttlHours: TTL_HOURS,
      maxRecords: MAX_RECORDS,
    });
    const scoped = sessionId ? records.filter((r: ActiveMemoryRecord) => r.sessionId === sessionId) : records;

    // Build the clients. The stub paths are hermetic and need NO config (the hook
    // test has only intelUrl, no control credentials), so read the stub env BEFORE
    // any loadWorkspaceConfig(): only the real HTTP clients require a valid config.
    // Config is loaded at most once and shared by both real clients.
    const detectStub = process.env.MEETLESS_ACTIVE_REVIEW_STUB_DETECT;
    const factsStub = process.env.MEETLESS_TAGGED_FACTS_STUB;
    let cfg: WorkspaceCliConfig | null = null;
    const ensureCfg = (): WorkspaceCliConfig => {
      if (cfg === null) cfg = loadWorkspaceConfig();
      return cfg;
    };

    const intel: IntelDetectClient =
      detectStub && detectStub.length > 0 ? stubIntelClient(detectStub) : realIntelClient(ensureCfg());
    // The real facts client takes the lazy getter, not a resolved config, so config
    // loads only inside its fetch (and only when there are referenced paths). This
    // keeps the Phase 1 path (detect stub set, no facts stub) from ever paying a
    // config load: a config failure must not couple into the conflict advisory.
    const facts: TaggedFactsClient =
      factsStub && factsStub.length > 0 ? stubTaggedFactsClient(factsStub) : realTaggedFactsClient(ensureCfg);

    // Phase 1: conflict advisories over the prior turn's produced docs.
    const result = await runActiveReview({ records: scoped, intel, minConfidence: MIN_CONFIDENCE });

    // A3 (Phase 2): supersession/contradiction advisories over the docs the user
    // NAMED this session (the tagged_reference captures). The pure engine joins
    // those paths against approved (LIVE/ACCEPTED) relation facts; the fetch is
    // best-effort (P6: a fetch failure swallows to no supersession advisory, never
    // a throw). The supersession lines ride AFTER the Phase 1 conflict lines.
    const referencedPaths = Array.from(
      new Set(scoped.filter((r) => r.kind === "tagged_reference").map((r) => r.canonicalPath)),
    );
    let supersessionLines: string[] = [];
    if (referencedPaths.length > 0) {
      try {
        const relationFacts = await facts.fetch(referencedPaths);
        supersessionLines = supersessionAdvisory(referencedPaths, relationFacts).map((a) => a.message);
      } catch {
        // best-effort: no supersession advisory on any fetch/join failure (P6).
        supersessionLines = [];
      }
    }

    const advisoryText = [renderAdvisoryText(result.advisories), ...supersessionLines]
      .filter((s) => s.length > 0)
      .join("\n");
    console.log(JSON.stringify({ advisoryText, advisories: result.advisories }));
    return 0;
  } catch {
    // Any unexpected error (missing config, etc.) is silent: print an empty
    // advisory and exit 0. Active Review is best-effort; it must never break the
    // turn it rides on.
    console.log(JSON.stringify({ advisoryText: "", advisories: [] }));
    return 0;
  }
}
