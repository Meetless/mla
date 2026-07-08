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
// each scout may do. The documentation scout gets Read only; the history scout gets
// nothing (it interprets in-prompt evidence). A static test (gate 7) asserts neither
// allowlist contains a shell, mutation, or network tool, and the subagent .md
// definitions' `tools:` frontmatter is cross-checked against this map.

import {
  OnboardingRun,
  ScoutName,
  SCOUT_NAMES,
  DocumentationTarget,
  PreparedGitEvidence,
  MAX_STATEMENT_LENGTH,
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
};

// The Claude Code subagent `name:` each scout role dispatches as. `/mla onboard`
// (the mla-onboard skill) reads this to pick the subagent_type per role, and
// wire.ts installs one ~/.claude/agents/<name>.md per role whose `tools:`
// frontmatter is rendered from SCOUT_TOOL_ALLOWLIST above. Single source of truth
// so the skill, the installed agent files, and the contract test cannot drift.
export const SCOUT_AGENT_NAME: Record<ScoutName, string> = {
  documentation: "meetless-doc-scout",
  history: "meetless-history-scout",
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

// Each scout's INDEPENDENT hard cap (verdict item 8: no reallocation). ingest bounds every
// scout at maxCandidatesPerScout regardless of what the other scout produced, so this is the
// exact ceiling a scout should aim at; telling it up front stops it over-producing candidates
// ingest would only drop. At least 1 so a scout is never told to surface nothing.
function perScoutTarget(run: OnboardingRun): number {
  return Math.max(1, run.limits.maxCandidatesPerScout);
}

function renderOutputContract(run: OnboardingRun, role: ScoutName): string[] {
  const evidenceExample =
    role === "documentation"
      ? '{ "type": "file", "path": "<one of the documents above>", "startLine": 10, "endLine": 24 }'
      : '{ "type": "commit", "commit": "<one of the commits above>", "path": "optional/historical/path" }';
  const anchorRule =
    role === "documentation"
      ? "Every candidate needs at least one `file` anchor whose path is exactly one of the documents listed above; the line range must point at the text that states the claim."
      : "Every candidate needs at least one `commit` anchor whose SHA is exactly one of the commits listed above; an optional `path` may name a historical file even if it no longer exists at HEAD.";
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
    `Aim for the highest-value ${perScoutTarget(run)} candidates or fewer. That per-scout cap is ` +
      "yours alone: it is not shared with or reallocated to the other scout, so candidates past it " +
      `are dropped at ingest. The run keeps at most ${run.limits.maxCandidatesTotal} candidates ` +
      "across all scouts. Pick the highest-value ones rather than padding.",
    'Zero candidates with status "complete" is a valid, successful result: only record a',
    "candidate you can anchor to the evidence above.",
    "If two sources contradict each other on a governing point, that IS a governance",
    "signal: surface it as a `decision` or `deprecation` candidate that names which",
    "source supersedes which, anchored to both. Do not append free prose; the JSON",
    "object above is the entire output.",
  ];
}

/**
 * Render the brief for one scout role from the authoritative run record. Pure: the
 * same (run, role) always yields the same string. The documentation brief lists the
 * exact ranked document targets and grants Read; the history brief inlines the
 * bounded git evidence and grants no tools. Both state the shared scout policy and
 * the JSON output contract `enrich ingest` expects.
 */
export function buildScoutPrompt(run: OnboardingRun, role: ScoutName): string {
  const policy = buildScoutPolicy();
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
    `Wall-clock deadline: ${run.deadlineAt}. If you approach it, stop and return what you`,
    'have so far with status "timed_out" rather than working past the deadline.',
    "",
  ];

  const body =
    role === "documentation"
      ? [
          "Read ONLY these documents, in rank order. The plan already selected and ranked",
          "them; do not search for, glob, or open any other file.",
          "",
          `The paths below are relative to the repository root: ${run.repositoryRoot}`,
          "Your working directory may NOT be that root, so read each document by its",
          "absolute path (join the root and the relative path). In every candidate's",
          "evidence, write the path exactly as listed below (relative), not the absolute",
          "one: ingest anchors evidence against the repository root and rejects absolute",
          "paths.",
          "",
          ...renderDocumentationTargets(run.documentationTargets),
        ]
      : [
          "You cannot open files or run git. The relevant history is reproduced below,",
          "bounded to what fits this brief. Interpret it: why a current design exists, what",
          "was reversed or superseded, which mistake keeps reappearing, which approach was",
          "killed.",
          "",
          ...renderGitEvidence(run.historyEvidence),
        ];

  return [...head, ...body, "", ...renderOutputContract(run, role)].join("\n");
}
