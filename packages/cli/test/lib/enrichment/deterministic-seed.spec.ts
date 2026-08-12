import {
  planDeterministicSeed,
  seedRelPath,
  MAX_SEED_FILES,
  MAX_SEED_FILE_BYTES,
  type SeedReceipt,
} from "../../../src/lib/enrichment/deterministic-seed";

// The deterministic bind-time seed (notes/20260805-onboarding-reachability-and-aha-proposal.md
// P0-1, as corrected by An's review on 2026-08-06: T1 instruction files ONLY).
//
// The failure this exists to prevent is measured, not hypothetical: 24 production workspaces ran
// the injection hook 459 times and received nothing, because `retrieve_knowledge` has no corpus to
// answer from and the only door to one (`/mla onboard`) needs a human to type a command inside a
// session. This module makes a corpus exist with no agent, no token, and no human.
//
// The three bounds it must not break, all of them An's:
//   - T1 ONLY. A README is explanation, a CONTRIBUTING is process, an ADR is history. Only a file
//     whose declared purpose is instructing an agent is seeded verbatim.
//   - born PENDING, which the SERVER forces. Nothing here can accept anything.
//   - a hard cap, so a monorepo carrying one CLAUDE.md per package cannot flood the corpus.

function planWith(
  files: Record<string, string>,
  opts: { tracked?: string[] | null; prior?: SeedReceipt | null; repoName?: string } = {},
) {
  return planDeterministicSeed({
    repoName: opts.repoName ?? "acme",
    tracked: opts.tracked === undefined ? Object.keys(files) : opts.tracked,
    readFile: (p: string) => (p in files ? files[p] : null),
    prior: opts.prior ?? null,
  });
}

describe("planDeterministicSeed: what gets seeded", () => {
  it("seeds T1 agent-instruction files and NOTHING else", () => {
    const plan = planWith({
      "CLAUDE.md": "# Rules\n\n- Never commit secrets.\n",
      "AGENTS.md": "Use pnpm, not npm.\n",
      ".cursor/rules/style.mdc": "Prefer named exports.\n",
      ".claude/rules/db.md": "Migrations MUST be reversible.\n",
      // Everything below is deliberately NOT seeded. An's correction: "Leave README,
      // CONTRIBUTING, and ADRs to the richer onboarding scouts for now. They contain
      // explanations, history, examples, alternatives, superseded decisions, and
      // descriptive prose. 'Verbatim' does not magically make a sentence a rule."
      "README.md": "This project does X. You must install node first.\n",
      "CONTRIBUTING.md": "Always run the tests before opening a PR.\n",
      "docs/adr/0001-use-postgres.md": "We MUST use Postgres.\n",
      "src/index.ts": "export const x = 1;\n",
    });

    expect(plan.candidates.map((c) => c.repoPath).sort()).toEqual([
      ".claude/rules/db.md",
      ".cursor/rules/style.mdc",
      "AGENTS.md",
      "CLAUDE.md",
    ]);
  });

  it("seeds a nested per-package CLAUDE.md, because a monorepo keeps one per package", () => {
    const plan = planWith({
      "CLAUDE.md": "root rules\n",
      "apps/control/CLAUDE.md": "control rules\n",
      "packages/ui/AGENTS.md": "ui rules\n",
    });
    expect(plan.candidates.map((c) => c.repoPath).sort()).toEqual([
      "CLAUDE.md",
      "apps/control/CLAUDE.md",
      "packages/ui/AGENTS.md",
    ]);
  });

  it("sends the file's bytes VERBATIM (a seed is never a paraphrase)", () => {
    const body = "# Rules\n\n- **Never** force-push to main.\n\nSome prose.\n";
    const plan = planWith({ "CLAUDE.md": body });
    expect(plan.candidates[0].content).toBe(body);
  });
});

describe("planDeterministicSeed: identity", () => {
  // A KB identity must be stable across MACHINES (a teammate's clone at a different absolute
  // path is the same document, and must dedup to `noop_unchanged`, not mint a duplicate) and
  // distinct across SIBLING REPOS (this dogfood workspace is bound by three markers: the
  // umbrella dir, meetless/, and intel/, so a bare "CLAUDE.md" identity would have three repos
  // overwriting each other's revision on every seed).
  it("namespaces by repo NAME, not by absolute path, so a teammate's clone dedups", () => {
    expect(seedRelPath("acme", "CLAUDE.md")).toBe("repo-instructions/acme/CLAUDE.md");
    expect(seedRelPath("acme", "apps/control/CLAUDE.md")).toBe(
      "repo-instructions/acme/apps/control/CLAUDE.md",
    );
  });

  it("keeps sibling repos on ONE workspace from colliding", () => {
    expect(seedRelPath("meetless", "CLAUDE.md")).not.toBe(seedRelPath("intel", "CLAUDE.md"));
  });
});

describe("planDeterministicSeed: idempotency", () => {
  // This runs on SessionStart, which is every session forever. Re-POSTing unchanged file bodies
  // every time would be a standing network cost for a guaranteed `noop_unchanged`.
  it("seeds nothing when every digest matches the prior receipt", () => {
    const files = { "CLAUDE.md": "rule one\n", "AGENTS.md": "rule two\n" };
    const first = planWith(files);
    expect(first.candidates).toHaveLength(2);

    const receipt = receiptFrom(first.candidates);
    const second = planWith(files, { prior: receipt });
    expect(second.candidates).toHaveLength(0);
    expect(second.unchanged).toBe(2);
  });

  it("reseeds ONLY the file whose content changed", () => {
    const before = { "CLAUDE.md": "rule one\n", "AGENTS.md": "rule two\n" };
    const receipt = receiptFrom(planWith(before).candidates);

    const after = { "CLAUDE.md": "rule one CHANGED\n", "AGENTS.md": "rule two\n" };
    const plan = planWith(after, { prior: receipt });
    expect(plan.candidates.map((c) => c.repoPath)).toEqual(["CLAUDE.md"]);
    expect(plan.unchanged).toBe(1);
  });

  it("seeds a file that is NEW since the receipt", () => {
    const receipt = receiptFrom(planWith({ "CLAUDE.md": "rule one\n" }).candidates);
    const plan = planWith({ "CLAUDE.md": "rule one\n", "AGENTS.md": "brand new\n" }, { prior: receipt });
    expect(plan.candidates.map((c) => c.repoPath)).toEqual(["AGENTS.md"]);
  });

  it("normalizes before digesting, so a CRLF checkout does not reseed on every session", () => {
    const receipt = receiptFrom(planWith({ "CLAUDE.md": "a\nb\n" }).candidates);
    const plan = planWith({ "CLAUDE.md": "a\r\nb\r\n" }, { prior: receipt });
    expect(plan.candidates).toHaveLength(0);
  });
});

describe("planDeterministicSeed: bounds", () => {
  it("caps the batch so a large monorepo cannot flood the corpus", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < MAX_SEED_FILES + 7; i++) files[`pkg${i}/CLAUDE.md`] = `rules ${i}\n`;
    const plan = planWith(files);
    expect(plan.candidates).toHaveLength(MAX_SEED_FILES);
    // Never a SILENT truncation: a capped batch says so, because "we seeded everything" and
    // "we seeded the first 25 of 32" are different claims.
    expect(plan.skipped.filter((s) => s.reason === "cap")).toHaveLength(7);
  });

  it("skips a file past the size ceiling rather than POSTing a megabyte of prose", () => {
    const plan = planWith({ "CLAUDE.md": "x".repeat(MAX_SEED_FILE_BYTES + 1) });
    expect(plan.candidates).toHaveLength(0);
    expect(plan.skipped).toEqual([{ repoPath: "CLAUDE.md", reason: "too_large" }]);
  });

  it("skips an empty or whitespace-only instruction file", () => {
    const plan = planWith({ "CLAUDE.md": "   \n\n", "AGENTS.md": "" });
    expect(plan.candidates).toHaveLength(0);
    expect(plan.skipped.map((s) => s.reason)).toEqual(["empty", "empty"]);
  });

  it("skips an unreadable file instead of aborting the whole batch", () => {
    const plan = planDeterministicSeed({
      repoName: "acme",
      tracked: ["CLAUDE.md", "AGENTS.md"],
      readFile: (p) => (p === "CLAUDE.md" ? null : "good\n"),
      prior: null,
    });
    expect(plan.candidates.map((c) => c.repoPath)).toEqual(["AGENTS.md"]);
    expect(plan.skipped).toEqual([{ repoPath: "CLAUDE.md", reason: "unreadable" }]);
  });
});

describe("planDeterministicSeed: the enumeration tri-state", () => {
  // `git ls-files` returning null means the probe FAILED (not a git checkout, no git binary).
  // That is not the same as a checkout that tracks nothing, and conflating them is how a seeder
  // decides a repo has no instruction files when it simply could not look.
  it("declines to seed when the enumeration itself failed", () => {
    const plan = planWith({ "CLAUDE.md": "rules\n" }, { tracked: null });
    expect(plan.enumerated).toBe(false);
    expect(plan.candidates).toHaveLength(0);
  });

  it("an empty checkout IS an authoritative answer, and is not the same as a failed probe", () => {
    const plan = planWith({}, { tracked: [] });
    expect(plan.enumerated).toBe(true);
    expect(plan.candidates).toHaveLength(0);
  });
});

function receiptFrom(candidates: { repoPath: string; digest: string }[]): SeedReceipt {
  const entries: Record<string, { digest: string }> = {};
  for (const c of candidates) entries[c.repoPath] = { digest: c.digest };
  return { version: 2, seededAt: "2026-08-06T00:00:00.000Z", entries };
}
