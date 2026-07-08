// `mla kb review <candidate-id> (--accept | --reject | --reclassify <TYPE>
//   [--scope-section <text>] | --no-relation) [--note <text>] [--agent]`
//
// B5 core (notes/20260603-mla-kb-agent-proxy-and-evidence-adoption.md §3, §7.4).
// Routes a verdict through the EXISTING control finalize primitive
// (POST /internal/v1/relationship-candidates/<id>/{accept,reject}) -- the same
// primitive the Console and the meetless__relationship_verdict MCP tool already
// use. The CLI never writes the knowledge graph and never bypasses the promotion
// gate (status==ACCEPTED && posture==LIVE is the control service's job; the CLI
// only records the verdict, which control then transitions + propagates via outbox).
//
// A-2 write-side: --reclassify / --scope-section / --no-relation map to the
// propose-correction verb (POST .../propose-correction). A correction is a
// PROPOSED training label, not a live-graph edit: it captures "the right answer is
// X" so a human can apply it later ("agent proposes; user applies"). Because it
// never mutates the graph, propose-correction is ALWAYS allowed -- for a human and
// for an automated proxy alike -- unlike accept (human-only) and reject (an agent
// may only auto-reject mechanically-invalid candidates).
//
// Auto-resolution policy (P2, MVP): REJECT-ONLY. The `--agent` flag declares that an
// automated proxy (Claude Code acting on An's behalf) is the caller:
//   * `--accept --agent` is ALWAYS refused. Accepting a relationship is institutional
//     memory; a wrong auto-accept manufactures false governance and poisons
//     retrieval, which is strictly worse than leaving the edge unreviewed. Only a
//     human may accept.
//   * `--reject --agent` is allowed ONLY when the candidate is mechanically invalid
//     (classifyMechanicalInvalidity); otherwise it is refused and surfaced for human
//     review. The auto-reject reason is stamped into the verdict note for audit.
// A human (no `--agent`) is the authority: both verbs proceed unconditionally.

import { readKbConfig, KbCliConfig, getConsoleUrl } from "../lib/config";
import { get, post, HttpError } from "../lib/http";
import {
  RelationshipCandidate,
  classifyMechanicalInvalidity,
  candidateConsoleUrl,
} from "../lib/kb-candidate";

// A-2 write-side: the structured correction payload the propose-correction verb
// carries. correctionKind + the corrected relation type (when the kind needs one)
// map 1:1 to the control RelationshipCorrectionPayloadDto; the CLI surfaces only
// the three kinds an operator reaches from a review queue (re-type, no-relation,
// section-scope). Per-kind relation-type rules and the authoritative relation-type
// set are owned by control (see kb-candidate.ts: the CLI deliberately does not
// depend on @meetless/utils / RELATION_TYPE_REGISTRY).
export type CorrectionKind =
  | "RELATION_TYPE_CORRECTION"
  | "NO_RELATION"
  | "SCOPE_CORRECTION";

export interface CorrectionSpec {
  correctionKind: CorrectionKind;
  correctedRelationType?: string;
  scopeKind?: "SECTION";
  sourceSectionPath?: string;
}

export interface KbReviewArgs {
  candidateId: string;
  verdict: "accept" | "reject" | "propose-correction";
  note: string | null;
  agent: boolean;
  // Present only when verdict === "propose-correction".
  correction?: CorrectionSpec;
}

const USAGE =
  "Usage: mla kb review <candidate-id> (--accept | --reject | --reclassify <TYPE> [--scope-section <text>] | --no-relation) [--note <text>] [--agent]";

// Validate the SHAPE of a --reclassify value and normalize it to the canonical
// SCREAMING_SNAKE the relation-type registry uses. We deliberately do NOT check it
// against the registry here (control is the authority; coupling the CLI to the
// enum would risk false rejects on registry drift). A typo surfaces as a clean
// control error after one round-trip.
function normalizeCorrectedRelationType(raw: string): string {
  const t = raw.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*$/.test(t)) {
    throw new Error(
      `--reclassify expects a relation type like REFINES or SUPERSEDES (got "${raw}"). ` +
        `The authoritative set is validated by control.`,
    );
  }
  return t;
}

export function parseKbReviewArgs(argv: string[]): KbReviewArgs {
  let candidateId: string | undefined;
  let accept = false;
  let reject = false;
  let agent = false;
  let note: string | null = null;
  let reclassify: string | undefined;
  let noRelation = false;
  let scopeSection: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--accept") {
      accept = true;
    } else if (a === "--reject") {
      reject = true;
    } else if (a === "--agent") {
      agent = true;
    } else if (a === "--no-relation") {
      noRelation = true;
    } else if (a === "--note") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--note requires a value");
      note = v;
    } else if (a === "--reclassify") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("-")) {
        throw new Error("--reclassify requires a relation type (e.g. REFINES)");
      }
      reclassify = v;
    } else if (a === "--scope-section") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--scope-section requires a value");
      scopeSection = v;
    } else if (a.startsWith("-")) {
      throw new Error(`Unknown flag: ${a}. ${USAGE}`);
    } else {
      if (candidateId !== undefined) throw new Error(`Unexpected extra argument: ${a}. ${USAGE}`);
      candidateId = a;
    }
  }

  if (candidateId === undefined) throw new Error(USAGE);

  const primaries =
    (accept ? 1 : 0) + (reject ? 1 : 0) + (reclassify !== undefined ? 1 : 0) + (noRelation ? 1 : 0);
  if (primaries === 0) {
    // Keep the legacy "--accept or --reject" phrasing (callers/tests key on it)
    // while pointing at the new correction verbs.
    throw new Error(
      `Pass one of --accept or --reject (or --reclassify <TYPE> / --no-relation to propose a correction). ${USAGE}`,
    );
  }
  if (primaries > 1) {
    throw new Error(
      "Pass exactly one of --accept, --reject, --reclassify, or --no-relation, not several",
    );
  }

  if (scopeSection !== undefined && reclassify === undefined) {
    throw new Error(
      "--scope-section requires --reclassify <TYPE> (a section-scoped correction still needs the corrected relation type)",
    );
  }

  if (reclassify !== undefined) {
    const correctedRelationType = normalizeCorrectedRelationType(reclassify);
    const correction: CorrectionSpec =
      scopeSection !== undefined
        ? {
            correctionKind: "SCOPE_CORRECTION",
            correctedRelationType,
            scopeKind: "SECTION",
            sourceSectionPath: scopeSection,
          }
        : { correctionKind: "RELATION_TYPE_CORRECTION", correctedRelationType };
    return { candidateId, verdict: "propose-correction", note, agent, correction };
  }

  if (noRelation) {
    return {
      candidateId,
      verdict: "propose-correction",
      note,
      agent,
      correction: { correctionKind: "NO_RELATION" },
    };
  }

  return { candidateId, verdict: accept ? "accept" : "reject", note, agent };
}

export type ReviewDecision =
  | { action: "proceed"; note?: string }
  | { action: "refuse"; exitCode: number; message: string };

// The P2 policy gate. Pure; the candidate is consulted only for the agent-reject
// path (to classify mechanical invalidity). Returns the verdict note to persist on
// proceed, or a refusal with an exit code and an operator-facing message.
export function evaluateReviewPolicy(opts: {
  candidateId: string;
  verdict: "accept" | "reject" | "propose-correction";
  agent: boolean;
  note: string | null;
  candidate?: RelationshipCandidate | null;
}): ReviewDecision {
  const { candidateId, verdict, agent, note } = opts;

  // A-2: a correction is propose-only (no live-graph edit; a human applies it
  // later), so it is always allowed regardless of caller. This is checked BEFORE
  // the agent gates below precisely so an automated proxy is NOT blocked from
  // proposing a correction the way it is blocked from accept/reject.
  if (verdict === "propose-correction") {
    return { action: "proceed", note: note ?? undefined };
  }

  // Human caller: full authority over both verbs.
  if (!agent) {
    return { action: "proceed", note: note ?? undefined };
  }

  // Automated proxy: reject-only, mechanically gated.
  if (verdict === "accept") {
    return {
      action: "refuse",
      exitCode: 2,
      message:
        `Auto-accept is disallowed for an automated proxy (P2). Accepting a relationship ` +
        `is institutional memory; a wrong auto-accept creates false governance and ` +
        `poisons retrieval. A human must accept ${candidateId}. Surface it with ` +
        `\`mla kb pending\` and ask the operator to run \`mla kb review ${candidateId} --accept\`.`,
    };
  }

  // verdict === "reject" && agent
  const cand = opts.candidate;
  if (!cand) {
    return {
      action: "refuse",
      exitCode: 1,
      message: `Candidate ${candidateId} not found; cannot evaluate auto-reject eligibility.`,
    };
  }

  const mech = classifyMechanicalInvalidity(cand);
  if (!mech.autoRejectable) {
    return {
      action: "refuse",
      exitCode: 2,
      message:
        `Candidate ${candidateId} is not mechanically invalid, so an automated proxy may ` +
        `not reject it (P2: agent auto-resolution is reject-only AND limited to ` +
        `mechanically-invalid candidates: self-edge or unsupported low-confidence). ` +
        `Surface it for a human decision with \`mla kb pending\`.`,
    };
  }

  const auto = `[auto-reject:${mech.reasonCode}] ${mech.reason}`;
  const combined = note ? `${auto}; ${note}` : auto;
  return { action: "proceed", note: combined };
}

// Injected network boundary (control is a separate process). fetchCandidate returns
// null on a 404 (candidate gone / wrong workspace); submitVerdict POSTs the verdict.
export interface CorrectionResult {
  id: string;
  candidateId: string;
  correctionKindId: string;
  correctedRelationTypeKey: string;
  curationStatusId: string;
  graphApplicationStatusId: string;
  deduped: boolean;
  [k: string]: unknown;
}

export interface KbReviewDeps {
  fetchCandidate: (id: string) => Promise<RelationshipCandidate | null>;
  submitVerdict: (
    id: string,
    verdict: "accept" | "reject",
    body: { workspaceId: string; userId: string; note?: string },
  ) => Promise<{ statusId: string; [k: string]: unknown }>;
  // A-2: the propose-correction boundary. Separate from submitVerdict because it
  // hits a different control route and returns a correction record (not a verdict
  // status). Propose-only: control records a PROPOSED training label; nothing in
  // the live graph changes until a human applies it (A-2b).
  submitCorrection: (
    id: string,
    body: {
      workspaceId: string;
      userId: string;
      note?: string;
      correction: CorrectionSpec;
    },
  ) => Promise<CorrectionResult>;
}

export async function runKbReviewWith(
  argv: string[],
  ctx: { workspaceId: string; actorUserId: string; consoleBase: string },
  deps: KbReviewDeps,
): Promise<number> {
  let parsed: KbReviewArgs;
  try {
    parsed = parseKbReviewArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  // Only the agent-reject path needs the candidate row (to classify). Human verdicts
  // and the agent-accept refusal short-circuit without a fetch.
  let candidate: RelationshipCandidate | null | undefined;
  if (parsed.agent && parsed.verdict === "reject") {
    try {
      candidate = await deps.fetchCandidate(parsed.candidateId);
    } catch (e) {
      console.error(`Failed to load candidate ${parsed.candidateId}: ${(e as Error).message}`);
      return 1;
    }
  }

  const decision = evaluateReviewPolicy({
    candidateId: parsed.candidateId,
    verdict: parsed.verdict,
    agent: parsed.agent,
    note: parsed.note,
    candidate,
  });

  if (decision.action === "refuse") {
    console.error(decision.message);
    return decision.exitCode;
  }

  // A-2: a correction takes the propose-correction boundary, not the verdict one.
  if (parsed.verdict === "propose-correction" && parsed.correction) {
    const cbody: {
      workspaceId: string;
      userId: string;
      note?: string;
      correction: CorrectionSpec;
    } = {
      workspaceId: ctx.workspaceId,
      userId: ctx.actorUserId,
      correction: parsed.correction,
    };
    if (decision.note !== undefined) cbody.note = decision.note;

    let cresult: CorrectionResult;
    try {
      cresult = await deps.submitCorrection(parsed.candidateId, cbody);
    } catch (e) {
      const err = e as HttpError;
      if (err.status === 404) {
        console.error(`Candidate ${parsed.candidateId} not found.`);
        return 1;
      }
      console.error(`Failed to propose a correction for ${parsed.candidateId}: ${err.message}`);
      return 1;
    }

    const footer = renderCorrectionFooter(
      parsed.candidateId,
      cresult,
      candidateConsoleUrl(ctx.consoleBase, parsed.candidateId),
    );
    for (const line of footer) console.log(line);
    return 0;
  }

  // The propose-correction case returned above, so the only verdicts left are the
  // two finalize verbs.
  const verdict = parsed.verdict as "accept" | "reject";

  const body: { workspaceId: string; userId: string; note?: string } = {
    workspaceId: ctx.workspaceId,
    userId: ctx.actorUserId,
  };
  if (decision.note !== undefined) body.note = decision.note;

  let result: { statusId: string; [k: string]: unknown };
  try {
    result = await deps.submitVerdict(parsed.candidateId, verdict, body);
  } catch (e) {
    const err = e as HttpError;
    if (err.status === 404) {
      console.error(`Candidate ${parsed.candidateId} not found.`);
      return 1;
    }
    console.error(`Failed to record verdict for ${parsed.candidateId}: ${err.message}`);
    return 1;
  }

  const verb = verdict === "accept" ? "accepted" : parsed.agent ? "auto-rejected" : "rejected";
  const footer = renderReviewFooter(
    verb,
    parsed.candidateId,
    result.statusId,
    candidateConsoleUrl(ctx.consoleBase, parsed.candidateId),
  );
  for (const line of footer) console.log(line);
  return 0;
}

// A-0 (A4 surface 1): the success footer. The CLI caller is UNKNOWN (a human and a
// coding agent run the identical command), so an ACCEPT -- the one governed verb --
// gets a dual-audience note: it states the accept carried the user's authority and
// reminds an agent that the UX default is propose-first (it should not have run
// --accept directly). A reject/auto-reject is freely allowed and gets no such note.
export function renderReviewFooter(
  verb: "accepted" | "auto-rejected" | "rejected",
  candidateId: string,
  statusId: string,
  consoleUrl: string,
): string[] {
  const lines = [`${verb} relationship candidate ${candidateId} (now ${statusId}).`, `  ${consoleUrl}`];
  if (verb === "accepted") {
    lines.push(
      "Recorded under the user's authority (a governed change). If you are an agent, the default is to propose accepts and let the user confirm rather than run --accept directly.",
    );
  }
  return lines;
}

// A-2: the propose-correction footer. A correction is propose-only, so it must NOT
// borrow the accept footer's "user's authority" language: nothing in the live graph
// changed. It names the proposed correction, points at the console, and states that
// a human applies it later (and flags a deduped re-proposal so the caller does not
// think a fresh record was created).
export function renderCorrectionFooter(
  candidateId: string,
  result: CorrectionResult,
  consoleUrl: string,
): string[] {
  const what =
    result.correctionKindId === "NO_RELATION"
      ? "no relation (the edge should not exist)"
      : `${result.correctedRelationTypeKey}`;
  const lines = [
    `proposed correction for relationship candidate ${candidateId}: ${what} ` +
      `(${result.curationStatusId.toLowerCase()}, not yet applied to the graph).`,
    `  ${consoleUrl}`,
  ];
  if (result.deduped) {
    lines.push(
      "This matches a correction already proposed for this candidate, so no new record was created (deduped).",
    );
  }
  lines.push(
    "A human applies or dismisses proposed corrections; this did not change the live knowledge graph.",
  );
  return lines;
}

// Public entrypoint: wires real config + the control HTTP boundary.
export async function runKbReview(argv: string[]): Promise<number> {
  let cfg: KbCliConfig;
  try {
    cfg = readKbConfig();
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  const consoleBase = getConsoleUrl(cfg);

  const deps: KbReviewDeps = {
    fetchCandidate: async (id) => {
      try {
        const r = await get<{ candidate: RelationshipCandidate | null }>(
          cfg,
          `/internal/v1/relationship-candidates/${encodeURIComponent(id)}?workspaceId=${encodeURIComponent(
            cfg.workspaceId,
          )}`,
          10000,
        );
        return r.candidate ?? null;
      } catch (e) {
        if ((e as HttpError).status === 404) return null;
        throw e;
      }
    },
    submitVerdict: async (id, verdict, body) =>
      post<{ statusId: string; [k: string]: unknown }>(
        cfg,
        `/internal/v1/relationship-candidates/${encodeURIComponent(id)}/${verdict}`,
        body,
        15000,
      ),
    submitCorrection: async (id, body) =>
      post<CorrectionResult>(
        cfg,
        `/internal/v1/relationship-candidates/${encodeURIComponent(id)}/propose-correction`,
        body,
        15000,
      ),
  };

  return runKbReviewWith(argv, { workspaceId: cfg.workspaceId, actorUserId: cfg.actorUserId, consoleBase }, deps);
}
