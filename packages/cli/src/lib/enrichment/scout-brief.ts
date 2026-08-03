// Onboarding scout briefs: the internal subagent prompt for each scout role.
//
// `/mla onboard` runs `enrich plan` (writes the authoritative run record), then
// dispatches one subagent per incomplete scout, then runs `enrich ingest`. This
// module renders the per-role brief from the run record so EVERY input a scout sees
// (the exact document targets, the bounded git evidence) is exactly what `enrich
// ingest` will validate against. The brief is a pure function of (run, role): no
// clock, no randomness, no IO. `enrich brief --run-id --role` prints it.
//
// The shared rules of engagement (role identity, candidate kinds, evidence rule,
// non-authoritative posture, untrusted-content rule) come from buildScoutPolicy in
// ../scanner/scout-mission, the SAME source the human copy/paste mission uses, so
// the two surfaces cannot drift (plan §4).
//
// Capability boundary: SCOUT_TOOL_ALLOWLIST is the single source of truth for what
// each scout may do. The documentation and reconciliation scouts get Read only; the
// history scout gets nothing (it interprets in-prompt evidence). A static test (gate 7)
// asserts NO allowlist contains a shell, mutation, or network tool, and the subagent .md
// definitions' `tools:` frontmatter is cross-checked against this map.

import {
  OnboardingRun,
  ScoutName,
  SCOUT_NAMES,
  DocumentationTarget,
  PreparedGitEvidence,
  MAX_STATEMENT_LENGTH,
  MAX_CLAIM_TEXT_LENGTH,
  MAX_CLAIM_SCOPE_LENGTH,
  DOC_CLAIM_CLASSES,
  claimClassPhraseExamples,
  RECONCILIATION_FINDING_KIND,
  SCOUT_CANDIDATE_KINDS,
  scoutMayEmitKind,
  assertNever,
  scoutCandidateCap,
} from "./protocol";
import { buildScoutPolicy, ScoutPolicy } from "../scanner/scout-mission";

// The capability each scout role is granted. Read-only for documentation; no tools
// for history (the plan precomputes and inlines its evidence). Deliberately narrow:
// the deterministic plan already discovered and ranked inputs, so scouts never need
// Glob/Grep, and they never need shell, write, or network. Widen only if real
// dogfood proves a need (plan §4).
export const SCOUT_TOOL_ALLOWLIST: Record<ScoutName, readonly string[]> = {
  documentation: ["Read"],
  history: [],
  // Reads the ranked doc targets itself so it depends on NEITHER sibling scout's output and
  // adds no serial stage. Its commit evidence is inlined by the plan, exactly as the history
  // scout's is. Read only: it never runs git, and never gets a shell. Every git operation
  // this finding needs (blame, ancestry, author) happens later, in the trusted CLI, against
  // anchors ingest has already validated.
  reconciliation: ["Read"],
};

// The Claude Code subagent `name:` each scout role dispatches as. `/mla onboard`
// (the mla-onboard skill) reads this to pick the subagent_type per role, and
// wire.ts installs one ~/.claude/agents/<name>.md per role whose `tools:`
// frontmatter is rendered from SCOUT_TOOL_ALLOWLIST above. Single source of truth
// so the skill, the installed agent files, and the contract test cannot drift.
export const SCOUT_AGENT_NAME: Record<ScoutName, string> = {
  documentation: "meetless-doc-scout",
  history: "meetless-history-scout",
  reconciliation: "meetless-reconciliation-scout",
};

function renderCategoryLines(policy: ScoutPolicy): string[] {
  return policy.categories.map((c) => `  • ${c.kind}: ${c.gloss}`);
}

function renderDocumentationTargets(targets: DocumentationTarget[]): string[] {
  if (targets.length === 0) {
    return [
      "(The plan issued no document targets for this run. Return status \"complete\"",
      " with an empty candidates array.)",
    ];
  }
  return [...targets]
    .sort((a, b) => a.rank - b.rank)
    .map((t) => `  ${t.rank}. ${t.path}  [${t.tier}]`);
}

function renderGitEvidence(evidence: PreparedGitEvidence[]): string[] {
  if (evidence.length === 0) {
    return [
      "(The plan issued no commit history for this run. Return status \"complete\"",
      " with an empty candidates array.)",
    ];
  }
  const lines: string[] = [];
  for (const c of evidence) {
    lines.push(`commit ${c.commit}`);
    lines.push(`  date: ${c.timestamp}`);
    lines.push(`  subject: ${c.subject}`);
    if (c.body && c.body.trim().length > 0) {
      lines.push("  message:");
      for (const bodyLine of c.body.split("\n")) {
        lines.push(`    ${bodyLine}`);
      }
    }
    if (c.changedFiles.length > 0) {
      lines.push("  files:");
      for (const f of c.changedFiles) {
        const renamed = f.renamedFrom ? ` (from ${f.renamedFrom})` : "";
        lines.push(`    ${f.status}  ${f.path}${renamed}`);
      }
    }
    if (c.diffExcerpt && c.diffExcerpt.trim().length > 0) {
      lines.push("  diff excerpt:");
      for (const diffLine of c.diffExcerpt.split("\n")) {
        lines.push(`    ${diffLine}`);
      }
    }
    lines.push("");
  }
  return lines;
}

function toolLine(role: ScoutName): string {
  const tools = SCOUT_TOOL_ALLOWLIST[role];
  if (tools.length === 0) {
    return (
      "You have NO tools. Do not attempt to read files, run commands, or fetch " +
      "anything; everything you need is reproduced in this brief."
    );
  }
  return `Your only tools are: ${tools.join(", ")}. Do not attempt any other tool.`;
}

// Each scout's INDEPENDENT hard cap (verdict item 8: no reallocation). Read from
// scoutCandidateCap, the SAME function ingest allocates from, so the number a scout is told
// to aim at is by construction the number ingest will honor. A single persisted scalar on the
// run's `limits` cannot express per-role caps, which is why none exists: a role capped at 3
// would be told to aim at 10 and have 7 findings silently dropped. At least 1 so a scout is
// never told to surface nothing.
function perScoutTarget(role: ScoutName): number {
  return Math.max(1, scoutCandidateCap(role));
}

// The per-role anchor contract. A switch, not a ternary: an `else` branch would have handed a
// new role whichever contract happened to be written second, and the compiler would not have
// said a word. Adding a ScoutName now fails the build here (see assertNever).
function anchorContract(role: ScoutName): { evidenceExample: string; anchorRule: string } {
  switch (role) {
    case "documentation":
      return {
        evidenceExample:
          '{ "type": "file", "path": "<one of the documents above>", "startLine": 10, "endLine": 24 }',
        anchorRule:
          "Every candidate needs at least one `file` anchor whose path is exactly one of the documents listed above; the line range must point at the text that states the claim.",
      };
    case "history":
      return {
        evidenceExample:
          '{ "type": "commit", "commit": "<one of the commits above>", "path": "optional/historical/path" }',
        anchorRule:
          "Every candidate needs at least one `commit` anchor whose SHA is exactly one of the commits listed above; an optional `path` may name a historical file even if it no longer exists at HEAD.",
      };
    case "reconciliation":
      return {
        evidenceExample:
          '{ "type": "file", "path": "<the document above that states the rule>", "startLine": 10, "endLine": 24 },\n' +
          '                     { "type": "commit", "commit": "<the commit above that does the opposite>", "path": "the/file/it/touched" }',
        anchorRule:
          "Every candidate needs BOTH anchors: a `file` anchor whose path is exactly one of the documents above and whose line range covers the exact sentence stating the rule, AND a `commit` anchor whose SHA is exactly one of the commits above with the `path` set to the file that commit touched. One anchor alone is not a finding: without the document there is no rule, and without the commit there is no divergence.",
      };
    default:
      return assertNever(role, "anchorContract");
  }
}

// The `inconsistency` payload, rendered ONLY for the role whose kind requires it. Every field
// here is re-derived by `enrich ingest` from the evidence the plan already froze: the quote is
// re-read from the document at the run's head commit and must match verbatim, and the path,
// status, and renamedFrom must match the commit's prepared file list exactly. So this block is
// not asking the scout to summarize; it is asking it to COPY, and anything it invents is
// rejected rather than persisted. The durable rule kind is deliberately NOT asked for: the CLI
// stamps it (FINDING_PROPOSED_RULE_KIND) and treats a candidate that carries one as an unknown
// field, so requesting it here would reject every scout that answered honestly.
function renderInconsistencyField(role: ScoutName): string[] {
  if (!scoutMayEmitKind(role, RECONCILIATION_FINDING_KIND)) {
    return [];
  }
  return [
    '      "inconsistency": {',
    `        "claimClass": "<one of: ${DOC_CLAIM_CLASSES.join(" | ")}>",`,
    `        "claimText": "<the rule sentence COPIED VERBATIM from the document, ${MAX_CLAIM_TEXT_LENGTH} characters or fewer>",`,
    `        "claimScope": "<a path the quoted sentence itself writes out, ${MAX_CLAIM_SCOPE_LENGTH} characters or fewer>",`,
    '        "divergence": {',
    '          "path": "<the file the commit touched, copied exactly from that commit\'s files list above>",',
    '          "status": "<that file\'s status letter, copied exactly from the same line>",',
    '          "renamedFrom": "<ONLY for a rename/copy: the old path shown in parentheses on that line>"',
    "        }",
    "      },",
  ];
}

// No longer takes the run: every number here is now a property of the ROLE (its own cap) or a
// protocol constant. The run's `limits.maxCandidatesTotal` is derived from the per-role caps,
// so quoting it told the scout a ceiling that could never bind it before its own cap did.
function renderOutputContract(role: ScoutName): string[] {
  const { evidenceExample, anchorRule } = anchorContract(role);
  return [
    "Return EXACTLY one JSON object and nothing else (no prose before or after it):",
    "",
    "{",
    `  "scout": "${role}",`,
    '  "status": "complete",            // or "timed_out" if you ran out of time, "failed" if you could not proceed',
    '  "candidates": [',
    "    {",
    '      "kind": "<one of the kinds listed above>",',
    `      "statement": "<one specific claim, ${MAX_STATEMENT_LENGTH} characters or fewer>",`,
    `      "evidence": [ ${evidenceExample} ],`,
    `      "sourceScout": "${role}",`,
    ...renderInconsistencyField(role),
    '      "rationale": "<optional: WHY this governs, in YOUR words. OMIT this AND rationaleSource together when the why is obvious>",',
    '      "rationaleSource": "AGENT_SUMMARY"   // PAIRED with rationale: include ONLY when you wrote a rationale above; omit it whenever rationale is omitted',
    "    }",
    "  ]",
    "}",
    "",
    anchorRule,
    "The `rationale` and `rationaleSource` fields are OPTIONAL and are a PAIR. Include a " +
      "rationale only when the evidence makes the WHY non-obvious, and keep it to one short " +
      'sentence. You are an agent, so your rationale is always `"AGENT_SUMMARY"`: it is recorded ' +
      "as your paraphrase, never as the user's own words. If you omit `rationale`, you MUST also " +
      "omit `rationaleSource` (a source with no rationale attributes nothing and is dropped). Do " +
      "NOT invent a rationale to look thorough: omitting both fields is always better than a " +
      "fabricated reason.",
    `Keep each statement to ${MAX_STATEMENT_LENGTH} characters or fewer: a longer statement is ` +
      "rejected outright at ingest, not truncated, so state the claim concisely and let the " +
      "evidence anchor carry the detail.",
    `Aim for the highest-value ${perScoutTarget(role)} candidates or fewer. That cap is yours ` +
      "alone: it is not shared with, borrowed from, or reallocated to any other scout, so " +
      "candidates past it are dropped at ingest. Scouts have different caps, and yours is the " +
      "only number that governs you. Pick the highest-value ones rather than padding.",
    'Zero candidates with status "complete" is a valid, successful result: only record a',
    "candidate you can anchor to the evidence above.",
    ...renderContradictionRule(role),
    "Do not append free prose; the JSON object above is the entire output.",
  ];
}

// The prohibition grammar, rendered from the validator's own phrase tables. The scout is not
// asked to judge whether a sentence "is a rule": it is shown the exact shapes the CLI matches,
// because a class the quote does not state is the single cheapest way to fabricate governance
// out of a description ("this file is generated" is a fact about the past, not a prohibition).
function renderClaimGrammar(): string[] {
  const lines = [
    "The quote must PROHIBIT something, and the prohibition must belong to the class you",
    "picked. A sentence that only describes what happens is not a rule and is rejected. The",
    "CLI matches a small fixed phrase list, so use the document's own wording in one of these",
    "shapes:",
  ];
  for (const cls of DOC_CLAIM_CLASSES) {
    const ex = claimClassPhraseExamples(cls);
    lines.push(`  ${cls}: "... ${ex.passive} ..." or "... ${ex.imperative} ..."`);
  }
  lines.push(
    "Close synonyms of those verbs are accepted, as are the other common modals (must not,",
    "should never, may not, cannot, shall not). A different class's verb is not: a delete",
    "prohibition filed as `never_modify` is a fabricated rule, and the status letter cannot",
    "tell them apart because it only proves that SOME change landed.",
  );
  return lines;
}

// What each role does with a contradiction. A switch, not one paragraph shown to everyone: the
// two extraction scouts each hold half the evidence and must fold a conflict into an ordinary
// governance candidate, while the reconciliation scout has a kind for exactly this and would be
// rejected at ingest for emitting `decision` or `deprecation` instead (SCOUT_CANDIDATE_KINDS).
function renderContradictionRule(role: ScoutName): string[] {
  switch (role) {
    case "documentation":
    case "history":
      return [
        "If two sources contradict each other on a governing point, that IS a governance",
        "signal: surface it as a `decision` or `deprecation` candidate that names which",
        "source supersedes which, anchored to both.",
      ];
    case "reconciliation":
      return [
        "A historical commit and a current document are NOT automatically inconsistent. The",
        "document must already have stated the rule when the commit landed; a commit that",
        "predates the rule broke nothing. The CLI proves that ordering with git after you",
        "return, and silently drops any finding it cannot prove, so spend your effort on the",
        "ones where the document is visibly older than the change, and report nothing when",
        "you are unsure.",
        "Copy, do not paraphrase. `claimText` must be the document's own sentence, character",
        "for character; the CLI re-reads that line range and rejects anything that is not an",
        "exact quote. `divergence.path`, `divergence.status`, and `divergence.renamedFrom`",
        "must be copied from the commit's files list above, and are checked the same way.",
        "The status letter has to PROVE the claim you picked: `never_modify` needs M,",
        "`never_add` needs A, `never_delete` needs D, `never_rename` needs R. A copy (`C`)",
        "leaves the governed file exactly where the document put it and adds a second file",
        "beside it, so it renames nothing. A file that was merely modified does not prove a",
        "rule about adding files, and a rule you cannot state as one of those four classes",
        "is not a finding for this run.",
        ...renderClaimGrammar(),
        "`claimScope` must be a path the quoted sentence WRITES OUT, character for character:",
        "the exact file path, or a directory ending in `/` when the document itself wrote the",
        "directory. The CLI never infers or widens a scope, so a parent directory you derived",
        "from a filename is rejected, and the scope must still cover `divergence.path`. A rule",
        "about one file says nothing about its neighbours.",
      ];
    default:
      return assertNever(role, "renderContradictionRule");
  }
}

/**
 * Render the brief for one scout role from the authoritative run record. Pure: the
 * same (run, role, deadlineAt) always yields the same string. The documentation brief
 * lists the exact ranked document targets and grants Read; the history brief inlines the
 * bounded git evidence and grants no tools; the reconciliation brief carries both halves,
 * because a doc/code disagreement is invisible to anyone holding only one. Every brief
 * states the shared scout policy and the JSON output contract `enrich ingest` expects.
 *
 * `deadlineAt` overrides the run's frozen deadline. `enrich brief` passes one, because
 * run.deadlineAt is anchored to PLAN time and the scout does not start at plan time: the
 * agent runs one `enrich brief` call per role and then relays each brief verbatim into the
 * Task prompt, and the history evidence is tens of kilobytes of git that the orchestrator
 * must emit token by token. That relay alone can burn minutes. Handing the scout a deadline
 * that is already spent (or already past, at which point the brief orders it to return
 * `timed_out` having read nothing) makes the budget a trap rather than a bound. The brief is
 * rendered immediately before dispatch, so brief-time is the closest honest anchor for a
 * budget that is meant to bound the SCOUT's work. The run record keeps its own deadlineAt
 * for audit and lock math; only the sentence the scout reads moves.
 */
export function buildScoutPrompt(run: OnboardingRun, role: ScoutName, deadlineAt?: string): string {
  // The kinds THIS role may emit, not every kind that exists. A scout produces what it is
  // shown, and ingest rejects a kind its author's role cannot anchor, so the two lists are
  // the same list (SCOUT_CANDIDATE_KINDS) rather than two that can drift apart.
  const policy = buildScoutPolicy(SCOUT_CANDIDATE_KINDS[role]);
  const head = [
    `Onboarding scout: ${role} (run ${run.runId}).`,
    "",
    ...policy.roleIdentity,
    "",
    "Surface these kinds of candidate (use the exact value for the `kind` field):",
    ...renderCategoryLines(policy),
    "",
    ...policy.evidenceRule,
    "",
    ...policy.untrustedContent,
    "",
    ...policy.nonAuthoritative,
    "",
    toolLine(role),
    `Wall-clock deadline: ${deadlineAt ?? run.deadlineAt}. If you approach it, stop and return what you`,
    'have so far with status "timed_out" rather than working past the deadline.',
    "",
  ];

  return [...head, ...renderMissionBody(run, role), "", ...renderOutputContract(role)].join("\n");
}

// The path-handling rule shared by every role that is granted Read. Written once so the
// documentation and reconciliation briefs cannot drift on the one instruction that decides
// whether a scout's evidence anchors survive ingest at all.
function renderPathRule(run: OnboardingRun): string[] {
  return [
    `The paths below are relative to the repository root: ${run.repositoryRoot}`,
    "Your working directory may NOT be that root, so read each document by its",
    "absolute path (join the root and the relative path). In every candidate's",
    "evidence, write the path exactly as listed below (relative), not the absolute",
    "one: ingest anchors evidence against the repository root and rejects absolute",
    "paths.",
  ];
}

// The per-role mission. A switch, not `documentation ? … : …`: under a ternary the
// reconciliation scout would have silently inherited the history brief, been told it cannot
// open files, and produced nothing, while the build stayed green.
function renderMissionBody(run: OnboardingRun, role: ScoutName): string[] {
  switch (role) {
    case "documentation":
      return [
        "Read ONLY these documents, in rank order. The plan already selected and ranked",
        "them; do not search for, glob, or open any other file.",
        "",
        ...renderPathRule(run),
        "",
        ...renderDocumentationTargets(run.documentationTargets),
      ];
    case "history":
      return [
        "You cannot open files or run git. The relevant history is reproduced below,",
        "bounded to what fits this brief. Interpret it: why a current design exists, what",
        "was reversed or superseded, which mistake keeps reappearing, which approach was",
        "killed.",
        "",
        ...renderGitEvidence(run.historyEvidence),
      ];
    case "reconciliation":
      return [
        "You hold BOTH halves of the evidence, and that is the entire point of this role.",
        "The other scouts each see one half: one reads the documents, one reads the history,",
        "and neither can see a disagreement that only exists BETWEEN them.",
        "",
        "Your job is narrow. Find places where a document states a rule and a commit in the",
        "list below did the opposite. Report only that. Do not report rules you agree with,",
        "do not summarize either source, and do not report a rule with no matching commit.",
        "",
        "Read ONLY the documents listed below, in rank order. Do not search for, glob, or",
        "open any other file, and do not run git: the commits are reproduced for you.",
        "",
        ...renderPathRule(run),
        "",
        "DOCUMENTS",
        ...renderDocumentationTargets(run.documentationTargets),
        "",
        "COMMITS",
        ...renderGitEvidence(run.historyEvidence),
      ];
    default:
      return assertNever(role, "renderMissionBody");
  }
}
