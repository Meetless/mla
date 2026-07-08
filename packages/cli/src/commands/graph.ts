import { isReviewListInvocation, pendingAliasArgs } from "./kb";
import { runKbReviewList } from "./kb_pending";
import { runKbReview } from "./kb_review";
import { runGraphConnections } from "./graph_connections";

// `mla graph`: the coordination-graph (relationship) surface.
//
// notes/20260608-mla-ml-generalization-review.md, Q1. `mla kb` had grown to span
// two orthogonal axes:
//   (a) document / posture: ingestion + grounding, LIVE vs SHADOW.
//   (b) relationship / graph: typed edges between docs, decided via verdicts.
// Calling axis (b) "kb" buries the coordination graph (the product's substrate)
// under a storage noun. `mla graph` gives axis (b) its own home WITHOUT moving
// axis (a): `review`/`pending` route to the EXACT same handlers as
// `mla kb review`/`mla kb pending` (one implementation, two entry points), and the
// overload boundary + pending-alias semantics are imported from `./kb` so the two
// surfaces can never drift. `kb review`/`kb pending` stay as working back-compat.
//
// Deliberately NOT here: any document ingestion verb. The review's explicit trap
// is `graph add <file>` reading as "ingest"; that would re-blur the two axes the
// codebase fought to separate. Document/posture verbs typed under `graph` are
// redirected to `mla kb`, not silently rejected.

// The document/posture verbs that live under `mla kb`. Typing one of these under
// `graph` is an axis mismatch, not a typo, so each gets a pointed redirect rather
// than the generic unknown-subcommand catalog. `share` is the deprecated alias for
// `promote`; include it so the redirect fires for muscle-memory too.
const KB_DOC_POSTURE_VERBS = new Set<string>([
  "add",
  "show",
  "reingest",
  "forget",
  "purge",
  "move",
  "retime",
  "promote",
  "share",
  "personal",
  "summary",
  "dump",
]);

// The user-facing `mla graph` catalog. It teaches the one fact that keeps the two
// axes apart: reviewing an edge records how docs RELATE; it never changes whether a
// doc is grounded (that is posture, under `mla kb`). The graph + control-projection
// layers expose per-item reads as counts only today (their per-item read endpoints
// remain deferred), so the catalog points at `mla kb summary` for graph counts
// rather than pretending a per-edge inspector exists. Keep "Usage" present: the
// unknown-subcommand path re-emits this block and a test locks that contract.
export const GRAPH_USAGE = `mla graph: the coordination graph — relationship review (typed edges between docs).

The graph axis decides how docs RELATE: SUPERSEDES / CONTRADICTS / REFINES /
REFERENCES. It is independent of the document/posture axis (ingestion + grounding,
LIVE vs SHADOW), which lives under \`mla kb\`. Reviewing an edge records how two docs
relate; it NEVER changes whether a doc is grounded.

Usage:
  mla graph review                              list the queue (defaults to your current session)
  mla graph review --all                        list the full workspace queue
  mla graph review --session <sid|current|latest>  list a specific session's candidates
  mla graph review [scope] --json               structured output (agent policy + scope)
  mla graph review <candidate-id> --accept | --reject [--note <text>] [--agent]
                                                record a verdict (--accept is human-only)
  mla graph pending [scope]                     deprecated alias for \`graph review\` (list mode)
  mla graph connections [--limit <n>] [--json]  list the claim-grain pending connections
                                                (the console /relationships queue)

Two pending-relationship surfaces, decided differently:
  \`graph review\`       artifact-grain edges between docs; verdict via \`mla graph review <id> --accept|--reject\`.
  \`graph connections\`  claim-grain relation assertions (the /relationships page); verdict via the MCP
                        \`relationship_verdict\` tool. \`graph review\` showing nothing does NOT mean this is empty.

Related (the OTHER axis — document/posture, not relationships):
  mla kb ...            ingest, ground (posture LIVE/SHADOW), and curate documents
  mla kb summary        substrate counts (includes graph entities + knowledge_relations)`;

// Router for the relationship/graph axis. Mirrors `runKb`'s help + dispatch
// shape; `review`/`pending` delegate to the shared handlers, document/posture
// verbs are redirected, everything else re-emits the catalog with exit 2.
export async function runGraph(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);

  // Help is workspace-free: full catalog to stdout, exit 0. Reached by
  // `mla graph`, `mla graph help`, and `mla graph --help/-h`.
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    console.log(GRAPH_USAGE);
    return 0;
  }

  switch (sub) {
    case "review":
      // Same overload boundary as `mla kb review`: a leading candidate id records
      // a verdict; anything else (no args / leading flag) lists the queue.
      return isReviewListInvocation(rest) ? runKbReviewList(rest) : runKbReview(rest);
    case "pending":
      // Deprecated alias for `review` (list mode); injects --all when no explicit
      // scope so the historical workspace-wide default holds.
      return runKbReviewList(pendingAliasArgs(rest));
    case "connections":
      // The OTHER pending-relationship surface: intel's claim-grain born-PENDING
      // relation assertions (the console /relationships queue), proxied through
      // control. `review`/`pending` above cover control's artifact-grain
      // relationship_candidates; this covers the claim-grain queue an operator
      // was otherwise blind to from the CLI. Verdicts go via the MCP
      // relationship_verdict tool, not an `mla` verb.
      return runGraphConnections(rest);
  }

  // Axis mismatch: a document/posture verb typed under `graph`. Redirect to the
  // surface that owns it instead of a generic "unknown subcommand" — this is the
  // anti-conflation guardrail made executable.
  if (KB_DOC_POSTURE_VERBS.has(sub)) {
    console.error(
      `\`${sub}\` is a document/posture command (ingestion + grounding), not a ` +
        `relationship (graph) command.\n` +
        `Documents are ingested and grounded under \`mla kb\`. Run: mla kb ${sub} ...\n\n` +
        `\`mla graph\` only reviews how docs RELATE. See \`mla graph help\`.`,
    );
    return 2;
  }

  console.error(`unknown \`mla graph\` subcommand: ${sub}\n`);
  console.error(GRAPH_USAGE);
  return 2;
}
