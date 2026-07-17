// `mla kb claims [--pending | --outcome <O>] [--doc <id>] [--limit <n>] [--all] [--json]`
// `mla kb accept <claimId> [--expect <O>] [--json]`
// `mla kb reject <claimId> [--expect <O>] [--json]`
//
// CLAIM-GRAIN TRUST — the verb that had no CLI.
//
// Document-grain accept/reject was retired under Design A (the intel route answers
// 410 KB_DOCUMENT_REVIEW_RETIRED) and trust moved to the CLAIM: `kb add` is born
// PENDING, extraction normalizes it into claims, and a human rules on each one.
// But the replacement was only ever built for the Console: the /claims queue proxies
// intel through the Next.js BFF, which holds INTERNAL_API_KEY server-side. So the
// one operation that IS the product -- recording who trusted what, and when -- was
// reachable ONLY by clicking a web page.
//
// The consequences were not cosmetic:
//   * A headless / CI operator (`mla init --control-token`) could ingest a corpus and
//     then never govern a line of it. Their KB stays PENDING forever.
//   * `mla kb help` kept printing `ACCEPTED -> trusted + served (mla kb accept)` --
//     pointing at a command that exits 2 with a retirement notice. The CLI documented
//     a command it had removed and shipped no replacement.
//   * No outsider could reproduce a governed-memory benchmark: the fixture seeder had
//     to authenticate with the shared service key to reach the verdict route.
//
// The routes needed nothing. intel's `require_internal_auth` already admits an
// `mla login` user token, `effective_workspace_id` already fences the workspace to
// membership (non-member -> 403), and `effective_actor_user_id` already FORCES the
// actor to the authenticated human -- a crafted `actorUserId` in the body is ignored
// on the cli-session plane, so a user cannot attribute a verdict to someone else.
// These commands are thin wrappers over a contract that was already correct.
//
// AUTHORITY (inherited from `mla kb review`, deliberately): accepting is institutional
// memory. A wrong auto-accept manufactures false governance and poisons retrieval,
// which is strictly worse than leaving a claim unreviewed. So `--agent` may not accept.
// Unlike the relationship queue there is no mechanical-invalidity classifier at claim
// grain, so an agent has no principled auto-REJECT either -- `--agent` refuses both.

import { loadWorkspaceConfig, WorkspaceCliConfig } from "../lib/config";
import { intelGet, intelPost } from "../lib/http";
import {
  isWorkspaceAccessDenied,
  workspaceAccessDeniedMessage,
} from "../lib/workspace-access";
import { randomUUID } from "node:crypto";

// `HttpError` is a structural interface, not a class, and a fetch-level failure
// (ECONNREFUSED / AbortError) rejects with no `status` at all — so read it
// structurally and treat `undefined` as "never reached the server", exactly as
// `isWorkspaceAccessDenied` does.
function httpStatus(e: unknown): number | undefined {
  return (e as { status?: number } | null)?.status;
}

// The trust axis. A string union, not a comment-only one: the compiler is the only
// thing that catches drift when intel adds a fourth outcome.
export type ReviewOutcome = "PENDING" | "ACCEPTED" | "REJECTED";
const OUTCOMES: readonly ReviewOutcome[] = ["PENDING", "ACCEPTED", "REJECTED"];
// PENDING is a STATE, never a verdict you can rule TO (intel: CLAIM_VERDICT_BAD_OUTCOME).
const VERDICTS: readonly ReviewOutcome[] = ["ACCEPTED", "REJECTED"];

export interface KbClaim {
  claimId: string;
  claimFingerprint: string;
  sourceRevisionId: string;
  claimExtractionKind: string;
  verbatimText: string;
  normalizedText: string | null;
  groundingStatus: string;
  reviewOutcome: ReviewOutcome | null;
  lifecycleStatus: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string | null;
  sourceDocumentId: string | null;
  sourceSystem: string | null;
}

interface InventoryPage {
  items: KbClaim[];
  nextCursor: string | null;
}
interface PendingPage {
  items: KbClaim[];
  count: number;
}

export interface KbClaimVerdictReceipt {
  reviewEventId: string;
  claimId: string;
  eventSequence: number;
  priorOutcome: ReviewOutcome;
  newOutcome: ReviewOutcome;
  actorId: string;
  reviewMethod: string;
  reviewedAt: string;
  idempotentReplay: boolean;
}

const LIST_USAGE =
  "Usage: mla kb claims [--pending | --outcome <PENDING|ACCEPTED|REJECTED>] [--doc <id>] [--limit <n>] [--all] [--json] [--workspace <id>]";
const VERDICT_USAGE = (verb: string) =>
  `Usage: mla kb ${verb} <claimId> [--expect <PENDING|ACCEPTED|REJECTED>] [--json] [--workspace <id>]`;

// A DOCUMENT reference, not a claim id. `kbdoc:`/`note:` are explicit prefixes; a
// bare path is anything with a separator or a markdown suffix. Claim ids are opaque
// cuids and carry none of these, so the two are cleanly separable -- which lets the
// retired document-grain verbs keep their pointer while the claim verbs take over the
// same word. (We match on SHAPE, never on "does it look like a cuid": a sentinel that
// overlaps a valid claim id would silently misroute a real verdict.)
export function looksLikeDocumentRef(ref: string): boolean {
  const r = ref.trim();
  return (
    r.startsWith("kbdoc:") ||
    r.startsWith("note:") ||
    r.includes("/") ||
    r.toLowerCase().endsWith(".md")
  );
}

// ── list ─────────────────────────────────────────────────────────────────────

export interface KbClaimsArgs {
  pending: boolean;
  outcomes: ReviewOutcome[];
  doc: string | null;
  limit: number | null;
  all: boolean;
  json: boolean;
  workspace: string | null;
}

export function parseKbClaimsArgs(argv: string[]): KbClaimsArgs {
  const a: KbClaimsArgs = {
    pending: false,
    outcomes: [],
    doc: null,
    limit: null,
    all: false,
    json: false,
    workspace: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--json") a.json = true;
    else if (t === "--all") a.all = true;
    else if (t === "--pending") a.pending = true;
    else if (t === "--outcome") {
      const v = (argv[++i] || "").trim().toUpperCase();
      if (!OUTCOMES.includes(v as ReviewOutcome)) {
        throw new Error(`--outcome must be one of ${OUTCOMES.join(" / ")} (got "${v || "nothing"}")`);
      }
      a.outcomes.push(v as ReviewOutcome);
    } else if (t === "--doc") {
      a.doc = (argv[++i] || "").trim() || null;
      if (!a.doc) throw new Error("--doc requires a document id");
    } else if (t === "--limit") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) throw new Error("--limit requires a positive integer");
      a.limit = n;
    } else if (t === "--workspace") {
      a.workspace = (argv[++i] || "").trim() || null;
      if (!a.workspace) throw new Error("--workspace requires a workspace id");
    } else {
      throw new Error(`unknown flag "${t}"\n${LIST_USAGE}`);
    }
  }
  // --pending IS `--outcome PENDING` with a backlog badge; taking both is ambiguous
  // about which route serves it, so refuse rather than silently pick one.
  if (a.pending && a.outcomes.length) {
    throw new Error(`--pending and --outcome are mutually exclusive.\n${LIST_USAGE}`);
  }
  return a;
}

async function fetchInventory(
  cfg: WorkspaceCliConfig,
  args: KbClaimsArgs,
): Promise<KbClaim[]> {
  const out: KbClaim[] = [];
  let cursor: string | null = null;
  const pageSize = args.limit ?? 50;

  do {
    const q = new URLSearchParams({ workspaceId: cfg.workspaceId, limit: String(pageSize) });
    for (const o of args.outcomes) q.append("reviewOutcome", o);
    if (cursor) q.set("cursor", cursor);
    const page: InventoryPage = await intelGet(cfg, `/internal/v1/kb-claims?${q.toString()}`, 20000);
    out.push(...(page.items || []));
    cursor = page.nextCursor ?? null;
    // Without --all, one page is the answer. With it, walk the keyset to the end --
    // the seeder needs EVERY claim (a 200-rule corpus is many pages, and governing a
    // truncated set would hand the agent a corpus smaller than the one it is graded on).
    if (!args.all) break;
    if (args.limit && out.length >= args.limit) break;
  } while (cursor);

  return args.limit ? out.slice(0, args.limit) : out;
}

async function fetchPending(cfg: WorkspaceCliConfig, args: KbClaimsArgs): Promise<PendingPage> {
  const q = new URLSearchParams({ workspaceId: cfg.workspaceId });
  if (args.limit) q.set("limit", String(args.limit));
  return intelGet<PendingPage>(cfg, `/internal/v1/kb-claims/pending?${q.toString()}`, 20000);
}

function claimText(c: KbClaim): string {
  // normalizedText is the decidable proposition; verbatimText is the source-span
  // fallback for a claim that was never normalized.
  return (c.normalizedText || c.verbatimText || "").replace(/\s+/g, " ").trim();
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

export async function runKbClaims(argv: string[]): Promise<number> {
  let args: KbClaimsArgs;
  try {
    args = parseKbClaimsArgs(argv);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }

  const cfg = loadWorkspaceConfig(args.workspace ?? undefined);

  let claims: KbClaim[];
  let backlog: number | null = null;
  try {
    if (args.pending) {
      const page = await fetchPending(cfg, args);
      claims = page.items || [];
      backlog = page.count ?? null;
    } else {
      claims = await fetchInventory(cfg, args);
    }
  } catch (e) {
    if (isWorkspaceAccessDenied(e)) {
      console.error(workspaceAccessDeniedMessage(e, cfg.workspaceId));
      return 1;
    }
    // The edge default-denies any path absent from INTEL_CLI_ALLOW, so a 404 here is
    // far more likely a stale proxy than a missing workspace. Say so, rather than
    // letting the operator hunt for a workspace that is fine.
    if (httpStatus(e) === 404) {
      console.error(
        "kb-claims is not reachable at this intel endpoint (404).\n" +
          "If you are pointed at a hosted backend, its edge allowlist may predate the\n" +
          "claim-review CLI. Upgrade the proxy or run `mla doctor`.",
      );
      return 1;
    }
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }

  if (args.doc) {
    claims = claims.filter((c) => c.sourceDocumentId === args.doc);
  }

  if (args.json) {
    console.log(JSON.stringify({ claims, backlog, workspaceId: cfg.workspaceId }, null, 2));
    return 0;
  }

  if (!claims.length) {
    console.log(
      args.pending
        ? "No claims awaiting review. (Ingest with `mla kb add`; extraction is async.)"
        : "No claims in this workspace's current inventory.",
    );
    return 0;
  }

  const label = args.pending
    ? `${claims.length} claim(s) awaiting your verdict${backlog !== null && backlog > claims.length ? ` (of ${backlog} total)` : ""}`
    : `${claims.length} claim(s)`;
  console.log(`${label} in ${cfg.workspaceId}:\n`);

  for (const c of claims) {
    const outcome = c.reviewOutcome || "PENDING";
    const mark = outcome === "ACCEPTED" ? "✓" : outcome === "REJECTED" ? "✗" : "·";
    console.log(`  ${mark} [${outcome.padEnd(8)}] ${c.claimId}`);
    console.log(`      ${truncate(claimText(c), 96)}`);
    if (c.reviewedBy) {
      console.log(`      reviewed by ${c.reviewedBy}${c.reviewedAt ? ` at ${c.reviewedAt}` : ""}`);
    }
    console.log("");
  }

  if (claims.some((c) => (c.reviewOutcome || "PENDING") === "PENDING")) {
    console.log("Rule on one:  mla kb accept <claimId>   |   mla kb reject <claimId>");
  }
  return 0;
}

// ── verdict ──────────────────────────────────────────────────────────────────

export interface KbClaimVerdictArgs {
  claimId: string;
  outcome: "ACCEPTED" | "REJECTED";
  expect: ReviewOutcome;
  json: boolean;
  agent: boolean;
  workspace: string | null;
}

export function parseKbClaimVerdictArgs(
  verb: "accept" | "reject",
  argv: string[],
): KbClaimVerdictArgs {
  const outcome = verb === "accept" ? "ACCEPTED" : "REJECTED";
  const claimId = (argv[0] || "").trim();
  if (!claimId || claimId.startsWith("--")) {
    throw new Error(`a claim id is required.\n${VERDICT_USAGE(verb)}`);
  }
  const a: KbClaimVerdictArgs = {
    claimId,
    outcome,
    expect: "PENDING",
    json: false,
    agent: false,
    workspace: null,
  };
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--json") a.json = true;
    else if (t === "--agent") a.agent = true;
    else if (t === "--expect") {
      const v = (argv[++i] || "").trim().toUpperCase();
      if (!OUTCOMES.includes(v as ReviewOutcome)) {
        throw new Error(`--expect must be one of ${OUTCOMES.join(" / ")} (got "${v || "nothing"}")`);
      }
      a.expect = v as ReviewOutcome;
    } else if (t === "--workspace") {
      a.workspace = (argv[++i] || "").trim() || null;
      if (!a.workspace) throw new Error("--workspace requires a workspace id");
    } else {
      throw new Error(`unknown flag "${t}"\n${VERDICT_USAGE(verb)}`);
    }
  }
  if (!VERDICTS.includes(a.outcome)) {
    throw new Error("outcome must be ACCEPTED or REJECTED");
  }
  return a;
}

export async function runKbClaimVerdict(
  verb: "accept" | "reject",
  argv: string[],
): Promise<number> {
  let args: KbClaimVerdictArgs;
  try {
    args = parseKbClaimVerdictArgs(verb, argv);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }

  // Human-only authority (see the header). An automated proxy declaring itself with
  // --agent is refused BOTH verbs: accept manufactures institutional memory, and at
  // claim grain there is no mechanical-invalidity test that would license an
  // auto-reject the way it does on the relationship queue.
  if (args.agent) {
    console.error(
      `\`mla kb ${verb} --agent\` is refused. A claim verdict is institutional memory and only a\n` +
        `human may record one: a wrong auto-verdict manufactures false governance and poisons\n` +
        `retrieval, which is worse than leaving the claim PENDING. Surface it for review with\n` +
        `\`mla kb claims --pending\` instead.`,
    );
    return 2;
  }

  const cfg = loadWorkspaceConfig(args.workspace ?? undefined);

  let receipt: KbClaimVerdictReceipt;
  try {
    receipt = await intelPost<KbClaimVerdictReceipt>(
      cfg,
      `/internal/v1/kb-claims/${encodeURIComponent(args.claimId)}/verdict?workspaceId=${encodeURIComponent(cfg.workspaceId)}`,
      {
        outcome: args.outcome,
        expectedPriorOutcome: args.expect,
        // A FRESH key per invocation, deliberately. A key derived from
        // (claimId, outcome) would look tidier and be WRONG: accept -> reject ->
        // accept would replay the first event, write nothing, and report ACCEPTED
        // on a claim that is still REJECTED. Optimistic concurrency
        // (expectedPriorOutcome -> 409) is what makes a retry safe, not the key.
        idempotencyKey: `mla-cli::${randomUUID()}`,
      },
      20000,
    );
  } catch (e) {
    if (isWorkspaceAccessDenied(e)) {
      console.error(workspaceAccessDeniedMessage(e, cfg.workspaceId));
      return 1;
    }
    if (httpStatus(e) === 409) {
      console.error(
        `That claim moved since you read it (expected it to be ${args.expect}).\n` +
          `Someone else ruled on it first. Re-read with \`mla kb claims\` and decide again;\n` +
          `pass \`--expect <outcome>\` to rule from the value you actually saw.`,
      );
      return 1;
    }
    if (httpStatus(e) === 404) {
      console.error(
        `No such claim in ${cfg.workspaceId}: ${args.claimId}\n` +
          `(If this is a document, document-grain review is retired — see \`mla kb help\`.)`,
      );
      return 1;
    }
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }

  if (args.json) {
    console.log(JSON.stringify(receipt, null, 2));
    return 0;
  }

  if (receipt.idempotentReplay) {
    console.log(`Already ${receipt.newOutcome.toLowerCase()} (no change written).`);
  } else {
    console.log(`${receipt.priorOutcome} -> ${receipt.newOutcome}`);
  }
  // Print the audit stamp the product just recorded. This is the whole point of
  // claim-grain trust: "who approved this, and when" is now answerable, and it came
  // from the ReviewEvent log -- not from anything the CLI made up.
  console.log(`  claim:    ${receipt.claimId}`);
  console.log(`  actor:    ${receipt.actorId}`);
  console.log(`  at:       ${receipt.reviewedAt}`);
  console.log(`  event:    ${receipt.reviewEventId} (seq ${receipt.eventSequence})`);
  return 0;
}
