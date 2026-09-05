# Changelog

## 0.2.40 (2026-09-05)

**New**
- Coordination driver tools in the `mla` MCP. From your session, acting as your authenticated self, you can submit a coordination goal, read its state, list the proposals waiting for review, review one, and propose closing the goal.

**Fixed**
- `mla` no longer treats a git subcommand written inside a quoted, multi-line string as a real command, so what it flags matches what actually ran.

## 0.2.39 (2026-08-29)

Mostly internal correctness. If you are already on 0.2.38, there is nothing here you need.

**Fixed**
- When the Meetless backend has trouble mid-session, `mla` now reports the actual error status instead of guessing at a diagnosis, so a degraded run is easier to tell apart from a real problem in your own code.

## 0.2.38 (2026-08-27)

If your Codex sessions have not been turning into knowledge, this release makes the condition impossible to miss and names the one command that fixes it. Plus two additions to `mla kb`.

**New**
- `mla kb tensions <doc>` shows the unresolved tensions recorded against a document in your governed knowledge, straight from the terminal.
- `mla kb` now reports documents that were captured but never finished indexing, so a stuck ingest shows up instead of staying silent.

**Fixed**
- A half-installed Codex integration now says so on every ordinary `mla` command and once at the start of each Codex session, naming the missing hook and the consequence. It was visible only to someone who ran `mla doctor` before, and earlier reported itself as "not installed" while firing on every event.

**Heads up**
- **If you installed the Codex integration before 2026-07-21, it can record everything and produce no durable knowledge at all.** In production, most active Codex workspaces that did real work finalized nothing. The repair is one command: upgrade, then `mla codex install` (upgrade first, because the install provisions the hook scripts from the binary that runs it).
- `mla` now requires Node 22 or newer. Upgrade Node before updating.

## 0.2.37 (2026-08-18)

Mostly internal correctness. The one worth a look: if you run `mla` under Codex, it can
finally tell you when the integration is only half-installed.

**Fixed**
- `mla codex install` now detects a partial Codex setup instead of reporting a clean one. An older install that predates the Stop hook was recording your sessions but saving no knowledge from any of them, and said nothing was wrong.
- Onboarding names each governance candidate after what it actually proposes now, instead of labeling them all "Candidate".

**Heads up**
- On Codex and nothing has been showing up? Re-run `mla codex install`. An install from before this fix was capturing activity and finalizing none of it.
- Corrected 2026-08-19: `mla doctor` is not sufficient to verify this. It checks whether the hooks are REGISTERED, and measurement since found that most affected installs pass that check and still finalize nothing. Verify by finishing a session and confirming it produced a turn (`mla session show <session-id>`), not by a green doctor line.

## 0.2.36 (2026-08-12)

Several repositories can now share one workspace. Point each checkout at the workspace
you already have instead of provisioning a new one per folder, and find the id you need
without leaving the terminal.

**New**
- `mla workspace list` prints every workspace you belong to, next to its id.
- `mla activate --workspace <id>` binds the current folder to a workspace that already exists, instead of creating another one.

**Fixed**
- A git worktree now inherits the workspace of the checkout it came from. Before this, an agent working inside a worktree ran ungoverned.
- Several checkouts bound to one workspace stop overwriting each other's setup. A repo could quietly lose its own rules and keep working as if nothing was missing.

## 0.2.35 (2026-08-10)

The largest release so far, and most of it is `mla` learning to tell you the truth about
its own work. The numbers it reported only ever described what it pushed at your agent,
never whether your agent then went and fetched something itself, so the one signal that
says "the push path missed" was invisible. That side is now measured and reported. Acting
on it is the rest of the release: the evidence budget was spending most of itself
re-sending material the agent already had.

**New**
- `mla stats ask` reports the pull path beside the push path, split by what the agent was
  actually asking for. Until now a hook timeout counted as "unknown" rather than as a
  diagnosis, and a five-day regression could hide inside a window average that only ever
  showed its mean.
- `mla kb reconcile` finds notes that have left disk and lets you decide which ones are
  really gone. A deleted note used to keep being served as current.
- Agent-memory capture for reference and feedback memories, and it names the files it
  withheld along with the rule that withheld them.
- Rules can now be scoped to a command, not just a path, so the interception plane can act
  on what your agent is about to do rather than only where.
- A shared corpus: seeding no longer needs an agent, a token, or a human in the loop, and
  the corpus can be shared with your team.
- `mla status` reports what it actually observed, not only what is configured.

**Changed**
- Every enforcement message names something you can act on. A block used to cite a rule id
  and nothing else, and a warned incident could not tell you whether the rule was advisory
  or simply capped.
- The turn recap states how much context it injected, measured rather than assumed, and a
  turn that loses its evidence says so in that turn instead of going quiet.
- Retrieval stops re-presenting evidence your agent already holds, and points it back at
  what it has when it reaches for the same thing again.

**Fixed**
- `mla doctor` checks the rules file your model actually reads. It used to verify the
  cache and the receipt and never the artifact, so a stale projection passed.
- Onboarding no longer fails every new user and then prescribes a command that could not
  have helped them.
- `mla kb` opens the canonical documents. The ones most worth reading were exactly the
  ones the detail tool could not address.
- A note's identity no longer depends on where `.git` happens to sit, which had forked one
  file into two.
- Sharing a note that merely mentions a public project key is no longer refused as if it
  were a credential.

Worth upgrading for anyone who reads `mla stats` or relies on the hook path. If you use
`mla kb`, reconcile is the reason to upgrade today.

## 0.2.34 (2026-08-04)

Repairs, plus one number that had been wrong since the day we shipped it.

**Fixed**
- `mla stats` now counts how often your agent checked governed memory before writing code. That number read zero for every workspace, however much your agent was actually consulting.
- Plugin installs get that fix too, not only source installs.
- `mla` no longer crashes when a command's output gets cut off, which could stall your agent mid-session.
- A checkout that cannot read its rules bundle no longer wipes another checkout's rules.

Worth upgrading if you use `mla stats` or the Claude Code plugin.

## 0.2.33 (2026-08-03)

Two copies of the same repo were quietly breaking each other. If you only ever clone a repo once, nothing here affects you.

**Fixed**
- A second clone, worktree or sandbox of a repo no longer takes over the first one's setup. The first one keeps it until that copy is gone from disk.
- `mla status` stopped saying "not activated" for a repo you had already activated.
- A scan run from a sandbox can no longer overwrite the rules your real checkout is governed by.

## 0.2.32 (2026-08-03)

`mla upgrade` could tell you it upgraded and leave you on the old version. That is fixed, along with a workspace that had no way to tell you it was empty.

**Fixed**
- `mla upgrade` replaces the binary that is actually running. On a custom install location it verified the download, changed nothing, and printed success.
- Retrieval now tells your agent when a workspace has nothing it can answer from, instead of coming back empty and letting the agent conclude the fact was never recorded. Most activated workspaces were in that state.
- `mla activate` hands you to onboarding whenever nobody has onboarded the workspace, not only when you are the first person in the folder.
- A session opening on an activated but empty workspace says so once, and says nothing at all when it cannot find out.
- `mla ask` no longer sends your question to the tracing plane.
- `mla enrich resolve` is idempotent: repeating a resolution that already succeeded no longer re-mints the rule or moves the timestamp.

## 0.2.31 (2026-08-01)

`mla enrich` gets a third scout. Reconciliation reads your documentation against your git history and reports where the two have drifted apart: a rule a document still states that a commit already broke.

**New**
- Reconciliation findings, each one checked against your actual repository before it is saved. Anything the CLI cannot verify itself is dropped, because a finding like this is an accusation.
- `mla enrich resolve` closes a finding with one of three answers, and mints a rule only when you say the code diverged. Your pick is the approval; there is no second prompt.

**Fixed**
- `mla activate` asks the server whether a shared workspace binding really grants you membership. It used to print "Already activated" from a committed marker file and then 403 on everything after.
- No command uploads traces to a workspace the server would refuse, and a blocked upload no longer prints a link to a trace that never left your machine.

## 0.2.30 (2026-07-29)

Nothing user-facing. Every command, flag and output behaves exactly as it did in 0.2.29. This version exists so the published surfaces sit on the same tree as the backend that shipped alongside it.

If you are on 0.2.29, there is nothing here you need.

## 0.2.29 (2026-07-29)

The scrub that keeps secrets off the wire had started refusing ordinary writing. It now tells a credential apart from a sentence about one.

**Fixed**
- Sharing a runbook or a design note no longer gets it scrubbed for merely saying "Bearer token" or "passphrase" out loud. Every refusal that matters is intact and pinned by a test.
- `mla scan` reports what your checkout no longer contains, so a file you deleted stops being cited as evidence.
- An `mla ask` that posted no actor is attributed properly, and a suspended account reads as suspended rather than as a customer who forgot to pay.
- A refusal we issued ourselves no longer reports itself as intel being down.

## 0.2.28 (2026-07-27)

This one is about what leaves your machine. Every payload `mla` sends now passes through a single checkpoint that refuses to send a body it cannot classify, so redaction is the default path instead of something each call site had to remember.

**New**
- `mla install` wires up Codex automatically, for parity with Claude Code.

**Fixed**
- An empty `retrieve_knowledge` explains why it was empty and names the remedy.
- A reachable intel is no longer reported as unreachable.
- The pending relationship queue is ordered by what needs attention rather than by arrival.
- `mla kb add` is no longer blocked by the egress checkpoint, and sends the real body.

## 0.2.27 (2026-07-24)

`mla scan` starts feeding reconciliation, and the CLI stops shrugging when an answer comes back thin.

**New**
- `mla scan` uploads a snapshot of your repo's governed instructions, so the backend can tell you where your working tree still assumes something that has since been decided differently.

**Fixed**
- The per-turn recap tells a real evidence outage apart from a legitimate no-match, and a correct abstain apart from a genuine miss. You can finally tell "nothing to say" from "something broke".
- A temporary billing hold is treated as retryable instead of as a hard failure.

## 0.2.26 (2026-07-23)

Your agent now meets a conflict while it works, instead of after the rework has landed.

**New**
- When a decision has superseded or drifted from what your working tree still assumes, `mla` pulls the matching findings and puts them in front of the agent at the moment it edits.
- `mla decisions show` exports a decision's full governed record as Markdown or JSON, naming evidence you are not entitled to read as private rather than linking to it.
- `mla ask` surfaces the documentation impact of a change in the same pass.

**Fixed**
- One malformed or empty document no longer sinks a whole ingest. It is skipped and the rest lands.

## 0.2.25 (2026-07-22)

0.2.24 wired Codex up. This release makes the wiring carry your work.

**New**
- Codex sessions reach Console with their full lifecycle captured, not just their opening, and decisions a human makes inside a Codex session are captured alongside the ones from Claude Code.
- `mla kb summary` and `mla kb dump` accept `--workspace`, like every sibling command already did. They used to report the activated workspace and print "0 chunks" for a corpus that landed elsewhere.

**Fixed**
- `mla kb add --mode corpus` works without a marker file, and writes nothing into the folder you asked it to read.
- A large corpus ingest no longer fails opaquely. Documents ride in batches, and a failed batch names every file it did not save.
- A retried ingest is safe: documents that already landed come back unchanged instead of duplicating.
- `--provenance` warns on a value it does not recognize, instead of silently recording a different one.

## 0.2.24 (2026-07-21)

This release brings Meetless to Codex.

**New**
- `mla codex install` wires the connector in, hooks and wrapper included, so the governance you already get in Claude Code runs there too.
- `mla doctor` reports Codex connector health and fails loudly on a half-finished install rather than looking fine.
- A second kind of rule: an allowlist for a date-prefixed note vault that deliberately lives outside your checkout, so working notes can be governed by where they belong rather than only by where they are forbidden.
- `mla conflicts resolve --outcome discard-both`, for contradictions where neither side survives.

**Heads up**
- The `reject-both` spelling is retired. Hosted backends serve `discard-both` from the next `control` release.

## 0.2.23 (2026-07-19)

Your coding agent becomes a first-class participant in clearing conflicts and capturing evidence.

**New**
- The agent can dismiss a flagged conflict from its own session, and is steered to confirm what actually changed before it does, so dismissals stay honest.
- Meetless captures your agent's work as it goes, seals each capture when the edit window closes, and cleans it up locally after 48 hours.

**Fixed**
- `mla stats` shows coverage gaps as a readable roadmap instead of raw enum slugs.
- Repeated scans stop churning: every scanned file carries a digest, so a rescan reconciles instead of redoing.

## 0.2.22 (2026-07-17)

The knowledge trust surface is usable from the terminal now, and first run is friendlier.

**New**
- `mla kb promote` and the new `mla kb demote` move a document between Team and Personal trust without leaving the CLI.
- `mla workspace invite` hands you a web join link, so the people you invite sign in and land in their workspace from the browser instead of needing the CLI themselves.
- Machine readable JSON output for command results.

**Fixed**
- `mla activate` explains what it is doing and `mla onboard` narrates each step, so first timers do not stall.
- Two clones of one workspace stop clobbering each other's scan cache.
- A partial ingest or run keeps whatever landed instead of throwing all of it away.

## 0.2.21 (2026-07-14)

`mla kb reingest` could not find the notes it had ingested itself, on Linux. Note identities are lowercased when they are minted, and the resolver then looked for that lowercased name on disk. macOS forgives that; Linux does not. So every note with a capital letter in its filename, `README.md` and `INDEX.md` among them, was unreingestable. It did not error. It found nothing, which reads exactly like "no such note".

**New**
- `mla kb claims`, `mla kb accept` and `mla kb reject`: review trust one claim at a time instead of one whole document at a time.

**Fixed**
- Capitalized filenames resolve on any filesystem. Two files that fold to one identity are now a clear error rather than a coin flip.
- An empty or unreadable `$HOME` no longer plants a literal `~` folder inside whatever repo you happened to be standing in.
- An onboarding scout that landed none of its candidates no longer reports "complete".

## 0.2.20 (2026-07-13)

If you installed mla on a brand new Mac, it never reached your PATH. The installer only added itself to shell startup files that already existed, and a fresh macOS account has none of them. So on the machine where a clean install matters most, it wrote nothing, exited successfully, and told you to restart your shell. Reinstalling did the same nothing.

**Fixed**
- The installer creates the startup file when it is missing, and writes `.zshenv` rather than only `.zshrc`. That second half is why `mla` could work in your terminal and still come back "command not found" inside Claude Code: zsh reads `.zshrc` only for interactive shells, and the shell a coding agent spawns is not interactive.
- Scoped rules are delivered to the agent that reads them. They had never once fired in a real repo.
- The Claude Code plugin ships the current hooks instead of a stale copy of them.

**Heads up**
- Already stuck on a broken install? You do not have to reinstall. Add the line the installer should have added, then open a new terminal:

```sh
echo '. "$HOME/.meetless/bin/env"' >> ~/.zshenv
```

## 0.2.19 (2026-07-13)

Accepting a rule now actually delivers it. 0.2.18 made `mla enrich accept` mint the rules you approve into your workspace, which made the rule real without making it reachable: nothing on the hot path fetched it, so a rule you had just approved on screen was live on the backend and still invisible to your agent, while accept told you it was injected.

**Fixed**
- An accepted rule applies from your very next turn, with no `mla scan` in between. If the refresh fails, accept says so instead of claiming success. Re-run accept any time a cache looks stale and it will heal it.
- Ask the MCP server who approved a decision and it tells you. The reviewer and the timestamp were always in the evidence it returned; the tool never said so, so agents read those fields as absent and answered UNKNOWN over data they were holding.

## 0.2.18 (2026-07-13)

Four silent bugs. Every one of them let the CLI look like it was working: nothing errored, nothing logged, and nothing you could see was wrong.

**Fixed**
- `mla enrich accept` wrote the rule you approved into a local file the injector does not read, so the rule never reached your agent. Acceptance now mints the rule, which is what it always claimed to do.
- `mla rules add --applies-to "src/api/**"` parsed your glob and then minted the rule ambient anyway, so a rule you deliberately scoped to one directory was injected on every single turn.
- A forbidden root written the natural way, with a trailing slash (`legacy/`), matched nothing and enforced nothing.
- Every npm install took the slow enforcement path on every Write and Edit, roughly 12x the latency of the fast one. The hook now runs the fast entrypoint regardless.

## 0.2.17 (2026-07-12)

The self-documenting CLI.

**New**
- `mla docs` answers out of a corpus compiled into the binary, so it works offline. `mla docs <topic>` and `mla docs search` browse it, and `mla docs ask "<question>"` routes a real question through Control.
- `--help` is driven by the same registry that dispatches commands, so help and reality cannot drift apart.

**Fixed**
- Vietnamese questions are no longer shredded by docs search.
- A login that resolved to an account but no actor self-heals on `mla activate` instead of leaving you stuck.
- A `--help` flag inside a docs question is treated as part of the question.

## 0.2.16 (2026-07-12)

Supersedes 0.2.15, which failed its release gate and never published to any surface.

**New**
- Onboarding is two steps: install, then `/mla activate`.
- `mla doctor --json` emits stable check ids for scripting.

**Fixed**
- A bad flag on `mla doctor` is a usage error, not an internal fault.
- Team rules fold correctly on a workspace you are bound to by a marker file.

**Heads up**
- Reviewing knowledge one document at a time is retired, in both the console and the CLI. Claim-grain review arrives in 0.2.21.

## 0.2.14 (2026-07-11)

**New**
- `mla deactivate` retires a workspace and `mla workspace reactivate` brings it back.
- `mla rules promote`, and `mla rules add` now defaults to PERSONAL scope.
- A WARN level for enforceable rules, so a rule can act on a violation without blocking you.

**Fixed**
- Unknown-command errors point you at `mla upgrade` instead of a dead end.
- `mla doctor` and the installer flag a WSL cross-boundary invocation, and the WSL hint only shows on agent-driven runs.
- The packaged binary carries its native database addon, so local state works in an installed build rather than only from source.

## 0.2.13 (2026-07-10)

Nothing user-facing. Internal work on how concurrent hooks coordinate. If you are on 0.2.12, there is nothing here you need.

## 0.2.12 (2026-07-10)

**Fixed**
- `mla status` tells "you are not a member of this workspace" apart from "this folder is not activated". Both used to read the same, and only one of them is your fault.
- `mla whoami` prints the workspace id and gains `--json`.
- `mla bug status` and `mla bug list` accept `--workspace`, and stop claiming a lookup "was not filed".
- `mla activate` stops telling plugin users to run `mla init`.
- `mla doctor` checks the hooks where they were actually installed, and confirms the workspace you are logged into matches the folder you are standing in.
- A document that failed to save during `enrich ingest` is retried when you resume.

## 0.2.11 (2026-07-10)

**New**
- `mla workspace member` commands for managing who is in a workspace.
- `mla enrich accept` materializes a run's durable rules, and onboarding surfaces them for you to accept.

**Fixed**
- `mla login` opens your browser instead of suppressing it when it hits a busy session probe.
