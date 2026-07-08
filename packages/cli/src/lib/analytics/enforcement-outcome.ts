// Enforcement-outcome classifier (STAR's R, "the result of our action").
//
// A deny incident tells the review queue WHAT we blocked (the tool + the path) and WHY
// (the rule). It does NOT tell the reviewer what happened NEXT -- did the agent take the
// hint and write to the right place, drop the mutation, or push against the rule and get
// blocked again? Without that, a reviewer cannot judge whether the deny was correct: a
// false positive and a true positive look identical at block time. This module derives
// the "what happened next" purely from the session transcript, so the console review
// queue can show the follow-through beside each deny.
//
// The one non-obvious simplification: the incidents list is itself the authoritative
// denied-set. We do NOT parse tool_result / deny markers out of the transcript. The
// transcript supplies only (a) the ORDER of Write/Edit attempts and (b) the universe of
// attempts. An attempt is "denied" iff it matches an incident by (tool, path-suffix); an
// attempt that matches NO incident passed (for the notes-location pilot the only deny
// mechanism is the mla enforcement incident, so "not in incidents" ~= "passed"). This
// keeps the classifier immune to transcript deny-message format drift.
//
// Classification is TERMINAL at the first Stop that observes the reaction: Stop fires at
// the end of each turn, and the agent's same-turn reaction to a deny is already in the
// transcript by then. No idle reaper. Only the three terminal classes are ever returned
// for emission; `pending` (deny is the last thing in the transcript) and `indeterminate`
// (the deny attempt is not locatable in the transcript) are surfaced but never emitted.

import { EnforcementOutcome } from "./envelope";

// The PII-safe facts of one deny incident the classifier needs. Built by the correlate
// command from a stored mla_enforcement_incident line. Only `decision === "deny"`
// incidents should be passed (a warn does not block, so it has no follow-through to
// classify).
export interface IncidentFacts {
  incidentId: string;
  // The closed enforced-tool enum from the incident ("Write" | "Edit" | "unknown").
  enforcedTool: string;
  // The runtime-relative path the rule blocked. null on pre-capture / non-file denies,
  // which are unmatchable and therefore classify as `indeterminate`.
  blockedPath: string | null;
  // Epoch ms the incident was emitted. Orders incidents so the order-zip pairs each
  // incident with the correct transcript attempt when a path is blocked more than once.
  occurredAtMs: number;
}

export type EnforcementOutcomeStatus = "terminal" | "pending" | "indeterminate";

// The classification of ONE incident. `outcome` and the counts are meaningful only when
// status === "terminal"; pending/indeterminate carry a null outcome and zero counts and
// must NOT be emitted (they are re-derived on a later Stop, or stay blind forever).
export interface ClassifiedIncident {
  incidentId: string;
  status: EnforcementOutcomeStatus;
  outcome: EnforcementOutcome | null;
  followupAttempts: number;
  retriedBlockedCount: number;
}

// One Write/Edit tool_use the agent emitted, in transcript order. `absPath` is the raw
// (absolute) file_path from the tool input; the incident's blocked_path is runtime-
// relative, so the join is a suffix match (pathMatches below).
interface TranscriptAttempt {
  seq: number;
  tool: "Write" | "Edit";
  absPath: string;
  lineIndex: number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Forward-pass the transcript JSONL and pull every Write/Edit tool_use in order, plus the
// index of the last ASSISTANT line seen. The last-assistant index is the pending signal:
// if the agent produced no assistant message after a deny, it has not reacted yet. A
// truncated / non-JSON line is skipped, never fatal (mirrors scanTranscriptForDecisions).
export function parseTranscriptAttempts(lines: string[]): {
  attempts: TranscriptAttempt[];
  maxAssistantLineIndex: number;
} {
  const attempts: TranscriptAttempt[] = [];
  let maxAssistantLineIndex = -1;
  let seq = 0;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const trimmed = lines[lineIndex].trim();
    if (trimmed.length === 0) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isPlainObject(obj)) continue;
    if (obj.type !== "assistant") continue;

    maxAssistantLineIndex = lineIndex;
    const message = obj.message;
    const content = isPlainObject(message) ? message.content : undefined;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        isPlainObject(block) &&
        block.type === "tool_use" &&
        (block.name === "Write" || block.name === "Edit") &&
        isPlainObject(block.input) &&
        typeof block.input.file_path === "string" &&
        block.input.file_path.length > 0
      ) {
        attempts.push({
          seq: seq++,
          tool: block.name,
          absPath: block.input.file_path,
          lineIndex,
        });
      }
    }
  }
  return { attempts, maxAssistantLineIndex };
}

// Does an absolute transcript path match an incident's runtime-relative blocked path?
// Suffix match, path-segment aligned so "notes/x.md" matches ".../a/notes/x.md" but NOT
// ".../footnotes/x.md". Also matches an exact-equal degenerate case. A leading "./" on
// the blocked path is stripped first. Empty blocked path never matches.
export function pathMatches(absPath: string, blockedPath: string): boolean {
  const abs = absPath.replace(/\\/g, "/");
  let rel = blockedPath.replace(/\\/g, "/");
  if (rel.startsWith("./")) rel = rel.slice(2);
  if (rel.length === 0) return false;
  return abs === rel || abs.endsWith(`/${rel}`);
}

// Classify every deny incident against the transcript. Returns one ClassifiedIncident per
// input incident (order preserved), so the caller can emit the terminal ones and log the
// pending/indeterminate counts. The caller owns idempotency (the skip-set of incidents
// that already have a terminal outcome); this function is pure and always classifies the
// full set so the denied-set / order-zip stays correct even for already-closed incidents.
export function deriveEnforcementOutcomes(
  incidents: IncidentFacts[],
  transcriptLines: string[],
): ClassifiedIncident[] {
  const { attempts, maxAssistantLineIndex } = parseTranscriptAttempts(transcriptLines);

  // Order-zip: walk incidents oldest-first and claim the earliest still-unclaimed
  // transcript attempt that matches by (tool, path-suffix). Because a blocked attempt
  // always precedes its own redirect in transcript order, and a retry mints a NEW
  // incident, claiming earliest-unclaimed pairs each incident with its true deny even
  // when a suffix collides (e.g. wrong-dir "notes/x.md" vs the vault's ".../notes/x.md").
  const ordered = [...incidents].sort(
    (a, b) => a.occurredAtMs - b.occurredAtMs || (a.incidentId < b.incidentId ? -1 : 1),
  );
  const claimedSeqByIncident = new Map<string, number>();
  const deniedSeqs = new Set<number>();
  for (const inc of ordered) {
    if (inc.blockedPath === null || inc.blockedPath.length === 0) continue; // unmatchable
    for (const att of attempts) {
      if (deniedSeqs.has(att.seq)) continue;
      if (att.tool !== inc.enforcedTool) continue;
      if (!pathMatches(att.absPath, inc.blockedPath)) continue;
      claimedSeqByIncident.set(inc.incidentId, att.seq);
      deniedSeqs.add(att.seq);
      break;
    }
  }

  // Classify each incident from its claimed attempt. Terminal class is read from the
  // IMMEDIATE next Write/Edit attempt after the deny (blocked -> retried_blocked, passed
  // -> complied_redirected); no later attempt but the agent DID react -> complied_stopped;
  // no later attempt and no assistant message after the deny -> pending (re-derive next
  // Stop). An incident with no claimed attempt -> indeterminate.
  return incidents.map((inc): ClassifiedIncident => {
    const seq = claimedSeqByIncident.get(inc.incidentId);
    if (seq === undefined) {
      return {
        incidentId: inc.incidentId,
        status: "indeterminate",
        outcome: null,
        followupAttempts: 0,
        retriedBlockedCount: 0,
      };
    }
    const denyAttempt = attempts[seq]; // seq is a dense 0-based index into attempts
    const later = attempts.filter((a) => a.seq > seq);

    // Follow-through window: the reaction BURST, not everything the agent did for the
    // rest of the session. It runs from the deny up to AND INCLUDING the first
    // non-blocked (redirect) attempt -- once the block is resolved, later unrelated
    // edits are no longer follow-through to THIS deny. If every later attempt is a
    // blocked retry (the agent never redirected), the window is the full retry run.
    // This keeps both counts terminal at the reaction regardless of WHEN the Stop hook
    // physically correlates: a deny whose window is closed late (a straggler Stop, or a
    // long turn with the deny early) still reports the burst, not the dozens of
    // unrelated edits that trailed it. Classification below is unaffected -- it reads
    // only the immediate next attempt (later[0]).
    const firstRedirectIdx = later.findIndex((a) => !deniedSeqs.has(a.seq));
    const reactionWindow =
      firstRedirectIdx === -1 ? later : later.slice(0, firstRedirectIdx + 1);
    const followupAttempts = reactionWindow.length;
    const retriedBlockedCount = reactionWindow.filter((a) => deniedSeqs.has(a.seq)).length;

    if (later.length > 0) {
      const next = later[0];
      const outcome: EnforcementOutcome = deniedSeqs.has(next.seq)
        ? "retried_blocked"
        : "complied_redirected";
      return {
        incidentId: inc.incidentId,
        status: "terminal",
        outcome,
        followupAttempts,
        retriedBlockedCount,
      };
    }

    // No further Write/Edit. If an assistant message came AFTER the deny, the agent had
    // its turn and chose not to re-mutate (complied_stopped). If the deny is literally the
    // last assistant activity, the reaction is not observable yet -> pending, no emit.
    if (maxAssistantLineIndex > denyAttempt.lineIndex) {
      return {
        incidentId: inc.incidentId,
        status: "terminal",
        outcome: "complied_stopped",
        followupAttempts: 0,
        retriedBlockedCount: 0,
      };
    }
    return {
      incidentId: inc.incidentId,
      status: "pending",
      outcome: null,
      followupAttempts: 0,
      retriedBlockedCount: 0,
    };
  });
}
