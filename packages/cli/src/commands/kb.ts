import { loadWorkspaceConfig } from "../lib/config";
import { intelGet, HttpError, DEFAULT_INTEL_URL } from "../lib/http";
import {
  isWorkspaceAccessDenied,
  workspaceAccessDeniedMessage,
} from "../lib/workspace-access";
import { runKbAdd } from "./kb_add";
import { runKbShow } from "./kb_show";
import { runKbReingest } from "./kb_reingest";
import { runKbForget } from "./kb_forget";
import { runKbPurge } from "./kb_purge";
import { runKbMove } from "./kb_move";
import { runKbReviewList } from "./kb_pending";
import { runKbReview } from "./kb_review";
import { runKbPersonal } from "./kb_personal";
import { runKbPromote } from "./kb_promote";
import { runKbDemote } from "./kb_demote";
import { runKbRetime } from "./kb_retime";
import { runKbClaims, runKbClaimVerdict, looksLikeDocumentRef } from "./kb_claims";

// `mla kb`: Knowledge Base subcommand router (T40, kb curation v2.3).
//
// Legacy read-only inspectors (T18, §5 PART C):
//   summary -> GET /v1/debug/substrate_counts  (counts per substrate)
//   dump    -> counts + GET /v1/debug/ingested_sources (one row per ingested
//              document: note path / diff|thread id, chunk count, last ingest)
//
// Curation subcommands (kb curation v2.3 §3):
//   add            -> ingest a file or directory as kb_document(s)
//   show           -> inspect a single kb_document (grounding, revisions, claims, audit)
//   reingest       -> create a new revision from current bytes
//   forget         -> tombstone a kb_document with reason
//   purge          -> redact every revision + tombstone the kb_document
//   move           -> relocate a kb_document under a new path
//   retime         -> correct a SOURCE ITEM's effective date and regenerate its
//                     derived relations (Phase 4 correction path); never edits an
//                     accepted relation's valid_at in place
//   promote        -> promote a doc from Personal to Team scope (PERSON ->
//                     WORKSPACE); --reject declines and preserves the personal doc
//   demote         -> demote a doc from Team back to Personal scope (WORKSPACE ->
//                     PERSON); the retained owner receives it back, nothing deleted
//
// Relationship review subcommands (B5, agent-proxy review queue):
//   review (list)  -> with NO candidate id: list PENDING_REVIEW candidates. Defaults
//                     to the CURRENT session ($CLAUDE_CODE_SESSION_ID) so parallel
//                     coding agents each resolve only their own session's edges;
//                     --all forces the full workspace queue; --session / --doc scope.
//   review <id>    -> record a verdict (--accept human-only | --reject [--agent])
//                     or propose a correction (--reclassify <TYPE> [--scope-section
//                     <text>] | --no-relation), which a human applies later
//   pending        -> deprecated alias for `review` (list mode); kept for back-compat,
//                     injects --all when no explicit scope so old behavior holds
//
// Personal-KB owner-scoped views (Phase 3, Task 3.3):
//   personal list  -> list THIS actor's own PERSON-scope (personal) KB docs via
//                     the owner-scoped GET /internal/v1/kb/documents
//   personal show  -> inspect one of them (reuses `mla kb show <id>`)
//
// summary is the quick glance; dump lists WHAT was ingested. The graph and
// control-projection layers expose counts only (per-item read endpoints
// remain deferred); dump labels that honestly.

interface SubstrateCounts {
  workspaceId: string;
  chunks: number;
  chunk_fts: number;
  graph_nodes: number;
  graph_edges: number;
  claims: number;
  ops_decision_diffs: number;
  ops_coordination_cases: number;
  ops_relationship_candidates: number;
  ops_workflow_audit: number;
  outbox_pending: number;
}

interface IngestedSource {
  documentId: string;
  parentKind: string;
  chunkCount: number;
  lastIngestedAt: string | null;
}

interface IngestedSources {
  workspaceId: string;
  total: number;
  sources: IngestedSource[];
}

interface KbInspectArgs {
  sub: "summary" | "dump";
  json: boolean;
  markdown: boolean;
  workspace: string | null;
}

// Legacy inspect parser. Only handles `mla kb summary` and `mla kb dump`; the
// six curation subcommands (add/show/reingest/forget/purge/move) are routed by
// `runKb` BEFORE this is called and each owns its own arg parser inside its own
// commands/kb_*.ts module.
export function parseArgs(argv: string[]): KbInspectArgs {
  const sub = argv[0];
  if (sub !== "summary" && sub !== "dump") {
    throw new Error(
      `Usage: mla kb summary [--json] [--workspace <id>] | mla kb dump [--markdown] [--json] [--workspace <id>]`,
    );
  }
  const out: KbInspectArgs = { sub, json: false, markdown: false, workspace: null };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--markdown") out.markdown = true;
    // Every sibling (kb claims / show / add / dump, and ask) accepts --workspace. summary silently
    // reporting the ACTIVATED workspace instead was actively misleading while debugging an ingest
    // into some OTHER workspace: it printed "0 chunks" for a corpus that had just landed elsewhere.
    else if (a === "--workspace") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Error("--workspace requires a workspace id");
      out.workspace = v;
    } else throw new Error(`Unknown flag for \`mla kb ${sub}\`: ${a}`);
  }
  return out;
}

function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// The three buckets of §5.1, plus the Control read-projection mirror. Labels are
// deliberately honest about provenance: the notes/LDM ingest writes ONLY the
// Sources layer (chunks + chunk_fts). The graph layer (entities /
// knowledge_relations / claim-kind entities) is written by the claims extractor
// (`--pipeline=claims`) and the relationship-promotion loop, NOT by notes
// ingest, so it reads 0 for a notes-only workspace by design. Conflating the two
// under an "accepted/live, promoted from sources" label is what made the old
// output look broken.
function bucketLines(c: SubstrateCounts): { sources: string[]; graph: string[]; ops: string[] } {
  return {
    sources: [
      `chunks (Weaviate):        ${n(c.chunks)}`,
      `chunk_fts (lexical):      ${n(c.chunk_fts)}`,
    ],
    graph: [
      `entities (nodes):         ${n(c.graph_nodes)}`,
      `knowledge_relations:      ${n(c.graph_edges)}`,
      `claim-kind entities:      ${n(c.claims)}`,
    ],
    ops: [
      `decision diffs:           ${n(c.ops_decision_diffs)}`,
      `coordination cases:       ${n(c.ops_coordination_cases)}`,
      `relationship candidates:  ${n(c.ops_relationship_candidates)}`,
      `workflow audit:           ${n(c.ops_workflow_audit)}`,
      `outbox pending:           ${n(c.outbox_pending)}`,
    ],
  };
}

const SOURCES_LABEL = "Sources (ingested via notes/LDM pipeline):";
const GRAPH_LABEL = "Internalized graph (claims + relationship pipeline; not written by notes ingest):";
const OPS_LABEL = "Control read projection:";

// withDumpPointer is true only for the standalone `summary` view, where the
// closing line nudges the reader toward `dump`. In `dump` the per-source
// listing follows immediately below, so repeating "run dump" there would tell
// the reader to run the command they are already looking at.
function renderSummary(c: SubstrateCounts, withDumpPointer = true): string {
  const b = bucketLines(c);
  const out: string[] = [];
  out.push(`Knowledge base summary (workspace: ${c.workspaceId})`);
  out.push("");
  out.push(SOURCES_LABEL);
  b.sources.forEach((l) => out.push(`  ${l}`));
  out.push(GRAPH_LABEL);
  b.graph.forEach((l) => out.push(`  ${l}`));
  out.push(OPS_LABEL);
  b.ops.forEach((l) => out.push(`  ${l}`));
  if (withDumpPointer) {
    out.push("");
    out.push("Counts only. Run `mla kb dump` to list the ingested sources (note paths + chunk counts).");
  }
  return out.join("\n");
}

function renderSourcesPlain(s: IngestedSources): string {
  const out: string[] = [];
  out.push(`Ingested sources (${s.total}):`);
  if (s.total === 0) {
    out.push("  none yet (nothing ingested into chunk_fts for this workspace).");
    return out.join("\n");
  }
  for (const src of s.sources) {
    const when = src.lastIngestedAt ?? "unknown";
    out.push(`  ${src.documentId}`);
    out.push(`    ${src.parentKind}, ${n(src.chunkCount)} chunks, last ingested ${when}`);
  }
  return out.join("\n");
}

function renderDumpPlain(c: SubstrateCounts, s: IngestedSources): string {
  return [renderSummary(c, false), "", renderSourcesPlain(s)].join("\n");
}

function mdRow(l: string): string {
  const idx = l.lastIndexOf(":");
  const label = l.slice(0, idx).trim();
  const val = l.slice(idx + 1).trim();
  return `| ${label} | ${val} |`;
}

function mdSection(title: string, lines: string[]): string {
  return [`### ${title}`, "", "| substrate | count |", "| --- | --- |", ...lines.map(mdRow), ""].join("\n");
}

function mdSources(s: IngestedSources): string {
  const head = [`### Ingested sources (${s.total})`, ""];
  if (s.total === 0) {
    return [...head, "_none yet (nothing ingested into chunk_fts for this workspace)._", ""].join("\n");
  }
  const rows = s.sources.map(
    (src) =>
      `| ${src.documentId} | ${src.parentKind} | ${n(src.chunkCount)} | ${src.lastIngestedAt ?? "unknown"} |`,
  );
  return [
    ...head,
    "| source | kind | chunks | last ingested |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

function renderDumpMarkdown(c: SubstrateCounts, s: IngestedSources): string {
  const b = bucketLines(c);
  const ts = new Date().toISOString();
  return [
    `# Meetless knowledge base snapshot`,
    "",
    `- workspace: \`${c.workspaceId}\``,
    `- generated: ${ts}`,
    "",
    mdSection("Sources (ingested via notes/LDM pipeline)", b.sources),
    mdSection("Internalized graph (claims + relationship pipeline, not notes ingest)", b.graph),
    mdSection("Control read projection", b.ops),
    mdSources(s),
    `> Sources are listed per-document from chunk_fts. The graph + control`,
    `> projection layers expose counts only (their per-item read endpoints`,
    `> remain deferred). Counts wrap \`/v1/debug/substrate_counts\`; the source`,
    `> list wraps \`/v1/debug/ingested_sources\`.`,
    "",
  ].join("\n");
}

function explainIntelError(err: HttpError, intelUrl: string): string {
  if (err.status === 404) {
    return (
      `intel returned 404 for a /v1/debug route. Those routes are mounted ` +
      `only when intel runs with SERVER_ENV != production; the KB inspector ` +
      `needs a non-production intel.`
    );
  }
  // A membership 403 (folder marker / --workspace names a workspace you are not
  // in) is NOT a token problem: under user-token auth there is no controlToken
  // to "check", so the old advice sent operators chasing a nonexistent field
  // (BUG-5 #1). Route it to the one canonical line every read command shares.
  if (isWorkspaceAccessDenied(err)) {
    return workspaceAccessDeniedMessage(err);
  }
  if (err.status === 401 || err.status === 403) {
    return `intel rejected the token (HTTP ${err.status}). Run \`mla doctor\` to check your login and workspace access.`;
  }
  if (err.status === undefined) {
    return `intel not reachable at ${intelUrl}. Is it running? Try \`mla doctor\`.`;
  }
  return err.message;
}

// The user-facing `mla kb` catalog. This is the help surface an operator (or
// an agent) reads to decide WHICH kb subcommand to run, so it has to teach the
// one fact that gets the commands confused: grounding is decided by the TRUST
// axis (born PENDING; `--provenance` is advisory, NOT a grounding switch),
// relationships (coherence) are decided by `kb review`, and Personal-KB posture
// (SHADOW/LIVE) is a SEPARATE sharing control touched by `kb promote`. The old
// "posture defaults by provenance -> human_authored lands LIVE" model was
// retired by the two-axis governed cutover: the server derives trust from the
// capture path, never from the provenance label. The accurate model used to live ONLY in a code comment
// above; surfacing it here is the root-cause fix for "add/promote/review get
// mixed up". Keep the word "Usage" present: the bad-subcommand error path
// re-emits this block and a test locks that contract.
const KB_USAGE = `mla kb: Knowledge Base curation, grounding, and relationship review.

Independent axes govern every KB doc. Do not conflate them:

  grounding (trust): does the agent retrieve + cite this doc? Decided by the
      TRUST axis, never by provenance. Every \`kb add\` is born PENDING
      (reviewOutcome=PENDING) no matter what \`--provenance <kind>\` you pass;
      \`--provenance\` is an advisory lineage label (how the bytes arrived) that
      sets neither trust nor grounding.
          PENDING  -> served, flagged untrusted (grounds answers now, awaiting review)
          ACCEPTED -> trusted + served (\`mla kb accept <claimId>\`)
          REJECTED -> dropped from serving, stops grounding (\`mla kb reject <claimId>\`)
      The verdict is recorded on a CLAIM, not on the document: extraction normalizes
      each document into claims and a human rules on each one. List them with
      \`mla kb claims --pending\`. (Document-grain accept/reject is retired.)
      SCOPE (Personal vs Team) is a SEPARATE sharing control, not provenance-driven
      and not the trust axis: a doc is born Personal (only you see it); \`mla kb
      promote\` shares it to the Team (PERSON -> WORKSPACE) and \`mla kb demote\`
      pulls it back to Personal (WORKSPACE -> PERSON). \`mla kb personal\` lists your
      own Personal docs.

  relationships (coherence): how does this doc relate to existing docs?
      Edges (SUPERSEDES / CONTRADICTS / REFINES / REFERENCES) are proposed as
      candidates and decided via \`kb review\` (list, then verdict). Reviewing an
      edge records how docs relate; it does NOT change grounding or trust.

Relations also carry TIME. Two temporal axes, never conflated:

  valid-time: when a relation is TRUE in the world (its valid-from / valid-until
      window). \`mla ask --as-of <date>\` answers point-in-time: relations not yet
      valid at that instant, or carried on an untrusted clock, are excluded.
      Validity is SEPARATE from posture and from relationship review.

  observation-time: when Meetless recorded the relation. A trusted clock means
      valid-time came from an author stamp or document date; an approximate clock
      means we only know when we observed it, not when it became true. Each
      relation's window plus this trust lives in the Console relationships lane
      (edges left \`kb show\` in the detail-view reshape), so observation never
      reads as validity.

Usage:
  ingest + curation
    mla kb add <path> --mode file|corpus --provenance <kind>
                      [--workspace <id>] [--vault-root <dir>]
                      [--profile <p>] [--glob <g>] [--ingest-run-id <id>]
                      [--queue] [--open]
                      (born PENDING; --provenance is advisory, server derives trust)
    mla kb show <kbdoc:<id>|note:<path>|<path>>
                      [--all] [--audit-all] [--json] [--open]
    mla kb reingest <kbdoc:<id>|note:<path>|<path>> [--path <new-path>] [--reason <s>]
    mla kb forget <kbdoc:<id>|note:<path>|<path>> [--reason <s>]
    mla kb purge <kbdoc:<id>|note:<path>|<path>> --reason <s> [--force]
    mla kb move <kbdoc:<id>|note:<path>|<path>> <new-path> [--reason <s>]
    mla kb retime <source-item-id> --effective-date <date>
                      [--reason <s>] [--anchor-type <t>] [--json]
                      (correct the source item's effective date; regenerates its
                       derived relations through the correction path. Edits the
                       SOURCE ITEM, not a relation: an accepted relation is never
                       edited in place nor deleted.)

  scope (Personal vs Team: who can see the doc)
    mla kb promote <doc-id> [--reason <s>]   share a Personal doc to the Team (PERSON -> WORKSPACE)
    mla kb promote --reject <doc-id>         decline the share; leaves it Personal, untouched
    mla kb demote <doc-id> [--reason <s>]    pull a Team doc back to Personal (WORKSPACE -> PERSON)
    mla kb personal list                     this actor's own Personal docs
    mla kb personal show <id>                inspect one (reuses \`mla kb show\`)

  trust review (claim grain — the verdict that decides grounding)
    mla kb claims                          the current claim inventory (all outcomes)
    mla kb claims --pending                only those awaiting your verdict, + backlog count
    mla kb claims --outcome ACCEPTED       filter by trust outcome
    mla kb claims [--all] [--limit <n>] [--doc <id>] [--json]
                                           --all walks every page (the whole corpus)
    mla kb accept <claimId> [--expect <O>] [--json]   trust it: retrieved + cited
    mla kb reject <claimId> [--expect <O>] [--json]   drop it from serving
                                           Human-only (\`--agent\` is refused). --expect
                                           guards against a concurrent reviewer (409).

  relationship review
    mla kb review                              list the queue (defaults to your current session)
    mla kb review --all                        list the full workspace queue
    mla kb review --session <sid|current|latest>  list a specific session's candidates
    mla kb review [scope] --json               structured output (with agent policy + scope)
    mla kb review <candidate-id> --accept | --reject [--note <text>] [--agent]
                                               record a verdict (--accept is human-only)

  inspect
    mla kb summary [--json]                substrate counts for this workspace
    mla kb dump [--markdown] [--json]      counts + one row per ingested source`;

// Overload boundary for the `review` verb: a leading candidate id means "record a
// verdict on this one"; anything else (no args, or a leading flag) means "list the
// review queue". Candidate ids are CUIDs (no leading dash) and are passed first in
// every documented usage.
export function isReviewListInvocation(argv: string[]): boolean {
  return argv.length === 0 || argv[0].startsWith("-");
}

// `pending` is the deprecated alias for the listing. Historically it was
// workspace-wide, so inject --all to keep that default, but ONLY when the caller
// passed no explicit scope (so old `pending --doc x` / `pending --session y` keep
// working instead of tripping the mutual-exclusivity guard).
export function pendingAliasArgs(argv: string[]): string[] {
  const hasScope = argv.includes("--all") || argv.includes("--session") || argv.includes("--doc");
  return hasScope ? argv : ["--all", ...argv];
}

// The document-grain trust verdict (`mla kb accept` / `mla kb reject`) is retired
// under Design A (kb-document-review-grain proposal §13.3). Print a one-line
// pointer to the claim-grain replacement and exit non-zero so a script notices the
// change instead of silently succeeding. No workspace or network is touched.
export function runKbDocumentReviewRetired(sub: string): number {
  console.error(
    `\`mla kb ${sub} <document>\` is retired: a KB document revision is navigate + withdraw only ` +
      `(importing a source no longer implies trust, and there is no document accept / reject).\n` +
      `Trust lives at CLAIM grain. Rule on the extracted claims instead:\n` +
      `  mla kb claims --pending          list the claims awaiting your verdict\n` +
      `  mla kb ${sub} <claimId>${" ".repeat(Math.max(0, 8 - sub.length))}     record the verdict (or use the Console /claims queue)`,
  );
  return 2;
}

// Curation subcommand router (kb v2.3). Each subcommand owns its own arg
// parser + exit codes inside commands/kb_*.ts. summary/dump fall through to
// the legacy inspect handler below.
export async function runKb(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);

  // Help is workspace-free: print the full catalog to stdout, exit 0. This is
  // reached by `mla kb`, `mla kb help`, and `mla kb --help/-h`.
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    console.log(KB_USAGE);
    return 0;
  }

  switch (sub) {
    case "add":
      return runKbAdd(rest);
    case "show":
      return runKbShow(rest);
    case "reingest":
      return runKbReingest(rest);
    case "forget":
      return runKbForget(rest);
    case "purge":
      return runKbPurge(rest);
    case "move":
      return runKbMove(rest);
    case "review":
      return isReviewListInvocation(rest) ? runKbReviewList(rest) : runKbReview(rest);
    case "pending":
      return runKbReviewList(pendingAliasArgs(rest));
    case "personal":
      return runKbPersonal(rest);
    case "promote":
    // `share` is the deprecated alias for `promote` (renamed because "share"
    // read as "invite a teammate"; the verb flips Personal -> Team scope).
    // Kept routing so existing hooks/scripts/muscle-memory keep working; it is
    // intentionally NOT advertised in the catalog, exactly like `pending`.
    case "share":
      return (await runKbPromote(rest)).code;
    case "demote":
      return (await runKbDemote(rest)).code;
    case "retime":
      return runKbRetime(rest);
    case "claims":
      return runKbClaims(rest);
    // `accept` / `reject` are the CLAIM-grain trust verdict (PENDING -> ACCEPTED /
    // REJECTED on a normalized claim). They used to be the DOCUMENT-grain verdict,
    // which was retired under Design A (kb-document-review-grain proposal §13.3): a
    // KB document revision is navigate + withdraw only, and all human-promotable
    // trust moved to the claim.
    //
    // The retirement shipped without a replacement, so for a while these verbs did
    // nothing but print a pointer at the Console — claim-grain trust, the operation
    // that IS the product, had no CLI at all. It does now.
    //
    // Both grains answer to the same word, so route on the SHAPE of the argument: a
    // document reference (`kbdoc:` / `note:` / a path) still gets the retirement
    // notice — mirroring the intel route's 410 KB_DOCUMENT_REVIEW_RETIRED — while a
    // claim id records the verdict. Muscle memory keeps working AND lands somewhere
    // honest; nothing silently misroutes, because the two shapes cannot collide.
    case "accept":
    case "reject":
      if (rest[0] && looksLikeDocumentRef(rest[0])) return runKbDocumentReviewRetired(sub);
      return runKbClaimVerdict(sub, rest);
  }

  // Anything that is not a routed subcommand and not summary/dump is unknown.
  // Emit the full catalog (not the old summary|dump-only line, which hid every
  // curation command) on stderr, and do it WITHOUT requiring a workspace so the
  // error is the same whether or not the folder is activated.
  if (sub !== "summary" && sub !== "dump") {
    console.error(`unknown \`mla kb\` subcommand: ${sub}\n`);
    console.error(KB_USAGE);
    return 2;
  }

  const cfg = loadWorkspaceConfig();
  let args: KbInspectArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  const intelUrl = cfg.intelUrl || DEFAULT_INTEL_URL;
  const workspaceId = args.workspace || cfg.workspaceId;
  const qs = new URLSearchParams({ workspaceId }).toString();

  let counts: SubstrateCounts;
  try {
    counts = await intelGet<SubstrateCounts>(cfg, `/v1/debug/substrate_counts?${qs}`, 10000);
  } catch (e) {
    console.error(explainIntelError(e as HttpError, intelUrl));
    return 1;
  }

  if (args.sub === "summary") {
    if (args.json) {
      console.log(JSON.stringify(counts, null, 2));
      return 0;
    }
    console.log(renderSummary(counts));
    return 0;
  }

  // dump: fetch the per-source listing too.
  let sources: IngestedSources;
  try {
    sources = await intelGet<IngestedSources>(cfg, `/v1/debug/ingested_sources?${qs}`, 10000);
  } catch (e) {
    console.error(explainIntelError(e as HttpError, intelUrl));
    return 1;
  }

  if (args.json) {
    console.log(JSON.stringify({ counts, sources }, null, 2));
    return 0;
  }
  if (args.markdown) {
    console.log(renderDumpMarkdown(counts, sources));
    return 0;
  }
  console.log(renderDumpPlain(counts, sources));
  return 0;
}
