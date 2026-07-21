# Changelog

## 0.2.24 (2026-07-21)

This release brings Meetless to Codex. `mla codex install` wires the connector in, hooks and
wrapper included, so the governance you already get in Claude Code runs there too: governed paths
are enforced on `apply_patch`, MCP reads and governed writes are classified correctly, and because
Codex has no ASK response in its PreToolUse seam the connector resolves the decision itself instead
of stalling. `mla doctor` now reports connector health and fails loudly on a half-finished install
rather than looking fine. Enforcement also grows a second rule family: an allowlist for a
date-prefixed note vault that deliberately lives outside your checkout, so working notes can be
governed by where they belong rather than only by where they are forbidden. On the conflict side,
`mla conflicts resolve` takes a new `--outcome discard-both` for contradictions where neither side
survives.

- `mla codex install` and `mla codex uninstall` wire the Meetless connector into Codex
- a static Codex plugin package ships `mla mcp`, so governed memory is reachable in-session
- governed path rules are enforced on Codex's `apply_patch`
- MCP reads and governed writes are classified correctly on the Codex seam
- the connector resolves its own decision where Codex cannot return ASK from PreToolUse
- `mla doctor` reports Codex connector health and fails on a partial setup
- a second enforcement rule family: an allowlist for a date-prefixed note vault outside the checkout
- only `YYYYMMDD-*` notes are governed by that rule; `README.md` and ordinary docs stay outside it
- one helper now names a governed root everywhere, so the attest prompt and the block can never disagree
- `mla doctor` reports rule bundle health alongside the Codex connector checks
- `mla conflicts resolve` accepts `--outcome discard-both`; the `reject-both` spelling is retired. Hosted backends serve `discard-both` from the next `control` release

## 0.2.23 (2026-07-19)

This release makes your coding agent a first-class participant in resolving conflicts and
capturing evidence. A new `meetless__dismiss_conflict` MCP tool lets the agent clear a flagged
conflict without leaving its session, and a verify-then-dismiss steer makes it confirm what
actually changed before it does, so dismissals stay honest. Meetless now captures the work
product your agent produces as it goes, seals each capture when the edit window closes, and reaps
it locally after 48 hours. Under the hood, the scanner normalizes content and stamps a local
digest for every artifact so repeated scans reconcile idempotently instead of churning, evidence
is validated for materiality and grounding before it counts, and `mla stats` presents coverage
gaps as a readable roadmap instead of raw enum slugs.

- your coding agent can dismiss a flagged conflict from its own session with the new `meetless__dismiss_conflict` MCP tool
- a verify-then-dismiss steer makes the agent confirm what changed before dismissing an eligible conflict
- Meetless captures your agent's work product as it goes, seals it when the edit window closes, and reaps it locally after 48 hours
- evidence is validated for materiality and grounding before it is counted
- the scanner normalizes content consistently and stamps a local digest for every scanned artifact
- repeated scans reconcile idempotently through a prompt-time rehash gate
- `mla stats` shows coverage gaps as a readable roadmap instead of raw enum slugs
- fixed a doubled content-type header on the agent-dismiss path

## 0.2.22 (2026-07-17)

This release makes the knowledge trust surface usable from the terminal. `mla kb promote` now
targets the live scope route and a new `mla kb demote` reverses it, so you can move a document
between Team and Personal trust without leaving the CLI. Workspace invites hand you a web join
link now, so the people you invite sign in and land in their workspace from the browser instead
of needing the CLI themselves. First run gets friendlier: `mla activate` explains what it is
doing and `mla onboard` narrates each step so first timers do not stall. Under the hood, command
results can be emitted as machine readable JSON for scripting, the scan cache is isolated per
checkout so two clones of one workspace stop clobbering each other, and a partial ingest or run
keeps whatever landed instead of throwing all of it away.

- `mla kb promote` targets the live scope route, and a new `mla kb demote` reverses it
- `mla workspace invite` prints a web join link so invitees join from the browser
- `mla activate` explains itself and `mla onboard` narrates, so first timers stay
- machine readable (JSON) output for command results, with protocol boundary guards and invoker telemetry
- WARN governance violations persist as enforcement incidents for the review queue
- PERSONAL deny enforcement is scoped to its attested checkout
- scan cache is isolated per scan root so two checkouts of one workspace stop stomping each other
- the context budget expands past the cliff so required rules always ride whole
- a partial corpus ingest keeps the docs that landed instead of discarding them
- a partial run keeps what persisted instead of throwing it away
- `materialize` enriches rule authority mints before writing the projection
- internal identifiers are scrubbed from the public mirror surface

## 0.2.21 (2026-07-14)

`mla kb reingest` could not find the notes it had itself ingested, on Linux.

An identity like `notes/hermes-agent/readme.md` is **casefolded**, unconditionally, when it is
minted. That makes it an identity, not a path: nothing on disk is named `readme.md`, the file is
`README.md`. The resolver took that folded string and `statSync`'d it as if it were a path. On
macOS that works by accident, because the kernel folds case for you, and macOS is the only place
anyone had run it. On Linux it resolved nothing, silently, so **every note whose filename carries
an uppercase letter (`README.md` and `INDEX.md` among them) was unreingestable.** It did not
error; it just found nothing, which reads exactly like "no such note".

0.2.21 folds the directory listing instead of the path, so the identity resolves to the real
on-disk name on any filesystem. Two files that fold to the same identity are now a hard error
rather than a coin flip: both mint the same id, so picking either one is picking at random.

The server half of the same bug shipped to production separately today, and it was the worse
half: intel runs on Linux, so `INDEX.md` and every other capitalized note was unresolvable in
prod for everyone.

Also in this release:

- **`mla kb claims`, `mla kb accept`, `mla kb reject`.** Trust is now reviewed at the grain of the
  individual claim, not the whole document. List what a document asserts, accept or reject each
  assertion on its own evidence.
- **A poisoned `$HOME` no longer re-roots your state.** Every shell entry point (nine hooks, the
  installer, the demo box) now repairs a `$HOME` that is empty or unreadable, or refuses to act.
  An empty `$HOME` had npm falling back to a literal `~` directory inside whatever repo you
  happened to be standing in.
- **An onboarding scout that landed none of its candidates no longer reports "complete".**

## 0.2.20 (2026-07-13)

If you installed mla on a brand new Mac, it never reached your PATH.

The installer only added itself to shell startup files that already existed, and a fresh macOS
account has none of them: no `.zshrc`, no `.bashrc`, no `.profile`. So on the machine where a
clean install matters most, it wrote nothing, exited successfully, and told you to restart your
shell. Every new terminal then answered `command not found: mla`. Reinstalling did not help,
because the reinstall did the same nothing.

0.2.20 creates the startup file when it is missing instead of skipping it, and writes `.zshenv`
rather than only `.zshrc`. The second half matters more than it looks: zsh reads `.zshrc` only
for interactive shells, and the shell a coding agent spawns is not interactive. That is why `mla`
could work in your terminal and still come back "command not found" inside Claude Code.

Already stuck on a broken install? You do not have to reinstall. Add the line the installer
should have added, then open a new terminal:

    echo '. "$HOME/.meetless/bin/env"' >> ~/.zshenv

Also in this release: a poisoned `$HOME` no longer re-roots every mla state path under your
working directory, scoped rules are delivered to the agent that reads them (they had never once
fired in a real repo), and the Claude Code plugin now ships the current hooks instead of a stale
copy of them.

- test(cli): the sidecar spec deleted its temp home while its own detached hooks were still writing
- fix(cli): the CLI shipped the broken install command baked into its own docs
- fix(cli): resolve-mla ran before the $HOME repair, so it planted the ~ tree itself
- fix(cli): a poisoned $HOME re-rooted every state path under the cwd
- fix(mla): scoped rules have never once been delivered in this repo
- fix(cli): warn against the budget we actually enforce, not a cap that never existed
- test(cli): the install canary opted out of PATH setup, the one thing it should guard
- fix(cli): installer skipped rc files that did not exist, so a fresh Mac never got mla on PATH
- fix(cli): one notes-vault resolver, so `kb reingest` can find what `kb add` minted
- test(cli): cover attest's delivery, the one mutating verb whose refresh nothing asserted
- fix(cli): Stop hook's review card honors MEETLESS_HOME, and its spec drives the real function
- fix(cli): honor MEETLESS_HOME in every scanner state path, and contain the test suite
- fix(cli): stop best-effort git probes from leaking stderr into the operator's terminal
- fix(cli): deliver rule changes to the agent, at the seam instead of one caller

## 0.2.19 (2026-07-13)

Accepting a rule now actually delivers it.

0.2.18 fixed the first half of this: `mla enrich accept` began minting the rules you
approve into your workspace, instead of writing them to a local file the injector does
not read. That made the rule real. It did not make it reachable.

Minting reaches the authority, and nothing on the hot path fetches the authority.
`mla scan` reads a local rule cache, and the prompt hook reads the cache that scan
writes, and no hook ever runs a scan. So a rule you had just approved on screen was
live on the backend and still invisible to your agent, while accept told you it was
injected. Inside a live session something else eventually swept it up, a turn late.
Outside one, in a script or in CI, it never arrived at all.

Accept now refreshes those caches itself. An accepted rule applies from your very next
turn, with no `mla scan` in between, and if the refresh ever fails, accept says so
instead of claiming success. Re-run accept any time a cache looks stale: it will heal
it.

Also in this release: ask the MCP server who approved a decision and it will now tell you.
The evidence it returns always carried the reviewer and the timestamp; the tool never said so,
so agents read those fields as absent and answered UNKNOWN over data they were holding.

- fix(cli): make enrich accept deliver the rules it mints, not just mint them
- feat(mla): price the rules we bill every user for, including the turn where they stop working
- fix(mcp): tell the agent the audit trail exists, so it stops answering UNKNOWN over data it has

## 0.2.18 (2026-07-13)

Four silent bugs. Every one of them let the CLI look like it was working: nothing
errored, nothing logged, and nothing you could see was wrong.

The worst one broke onboarding end to end. `mla enrich accept` wrote the rule you
approved into a local projection file that the injector does not read, so the rule
never reached your agent. You accepted it, the CLI said yes, and Claude Code never
saw it. Acceptance now mints the rule, which is what it always claimed to do.

Two of the same shape in the rules surface. `mla rules add --applies-to "src/api/**"`
parsed your glob and then minted the rule ambient anyway, so a rule you deliberately
scoped to one directory was injected on every single turn instead. And a forbidden
root written the natural way, with a trailing slash (`legacy/`), matched nothing and
enforced nothing.

Last, a speed fix. Every npm install of mla was taking the slow enforcement path on
every Write and Edit, roughly 12x the latency of the fast one, because the packed
tarball drops the exec bit off everything that is not a `bin` entry. The hook now
runs the fast entrypoint regardless.

- fix(cli): acceptance IS the mint, so an onboarded rule finally reaches the agent
- fix(cli): accept no longer tells you to git-push a projection to share a rule
- fix(cli): --applies-to parsed the glob, then minted an ambient rule anyway
- fix(cli): a forbidden root typed with a trailing slash enforced nothing
- fix(cli): every npm install took the SLOW pretool transport, on every tool call
- refactor(analytics): enhance id matching and source ID extraction

## 0.2.17 (2026-07-12)

The self-documenting CLI. `mla docs` now answers out of a corpus compiled into the
binary, and `mla docs ask "<question>"` routes a real question through Control.

- feat(cli): T6 command registry as the single source for dispatch, help, and the docs command index
- feat(cli): offline docs surface (mla docs / <topic> / search) + registry-driven --help (T8-T12)
- feat(cli): wire `mla docs ask` to Control, share the ask presenter (T21-T25)
- feat(utils): make the docs-corpus drift gate testable, regenerate the corpus (T26)
- feat(mla): mint an ask delivery key at the MCP tool-call boundary
- feat(cli,control): survive an account-only login and self-heal the actor on activate
- fix(docs-cli): compile the corpus into the CLI instead of shipping it as an fs asset
- fix(docs-ask): the abstention sentence is ours, and pin the edge to the one route
- fix(docs): stop shredding Vietnamese, and tell the truth about docs_answer cost
- fix(docs): stopword filter, corpus-budget tripwire, measured cost model
- fix(docs): document the docs surface, unbreak the mirror's suite, let the smoke gate speak
- fix(docs): close the code-review findings on the self-documenting CLI
- fix(cli): a help flag inside a docs question is part of the question
- fix(cli): ship WARN as the enforcement ceiling, and make the sweep obey it
- fix(enforce): a rule about a PATH must hold against every tool that writes it
- fix(cli): extract rules at sentence grain, not line grain
- fix(cli): let `enrich plan --force` reclaim an abandoned onboarding lock
- fix(cli): resolve the enrich git root from cwd, not the activation marker
- fix(cli): a rejected onboarding candidate must say what it dropped
- fix(cli): re-anchor the scout deadline at brief time, not plan time
- fix(cli): activate must not claim a live injection it never performed
- fix(cli): activate must never rewrite the user's .gitignore
- fix(cli): activate told you to restart and not to restart, in one breath
- fix(cli,ci): publish only from the release tag; detect a symlinked-HOME install
- fix(cli): drive the Homebrew canary through Tap-Trust, and tell users about it
- test(cli): gate the bundled docs corpus in both shipped artifacts
- test(mla): pin the analytics command allowlist to the dispatch registry
- test(enforce): register posttool-sweep.sh in the hook-template manifest
- ci(release): gate the CLI build on a live prod-edge allowlist probe (no silent 404s)

## 0.2.16 (2026-07-12)

Supersedes 0.2.15, which failed its release gate and never published to any surface.

- feat(cli): collapse mla onboarding to two steps (install, then /mla activate)
- feat(console,cli): retire KB document-grain review UI and CLI (Design A)
- feat(cli): Phase 3a mla doctor --json emitter with stable check ids
- feat(cli): Phase 2 npm exact-tarball publish (pack -> gate -> smoke -> publish)
- feat(cli): stamp MOVE provenance on promote/demote mints
- feat(cli): add userAgent to authentication requests for version tracking
- fix(cli): mla doctor bad flag is a usage error (exit 2), not an internal fault
- fix(cli): fold TEAM rules on a marker-bound foreign workspace
- ci(mla): run the CLI test suite in CI as a release gate (--forceExit + 15m timeout)
- test(cli): Phase 5 post-publish distribution canaries (per-surface)
- test(cli): Phase 1 packaged-binary smokes + extract-verify release gate
- test(cli): make 8 CI-non-hermetic specs self-provision their dogfood deps

## 0.2.14 (2026-07-11)

- fix(mla): record governed MCP pulls end-to-end (tool_used_mcp outcome + ingest gap)
- feat(cli): rules add defaults PERSONAL, add rules promote, humanize scope column
- fix(cli): mla workspace reactivate accepts a positional workspace id
- fix(cli): show doctor WSL hint only on non-interactive (agent-driven) runs
- fix(cli): unknown-command errors point at 'mla upgrade', not a dead end
- docs(cli): state macOS/Linux support and Windows-via-WSL in README
- feat(cli): flag WSL cross-boundary mla invocation in doctor and installer
- fix(cli): materialize better-sqlite3 native addon so CE0 store works in the packaged binary
- feat(cli): add --ceiling/--forbidden-root WARN arming surface to rules attest
- feat(cli): mla deactivate retires the workspace (two-verbs model)
- feat(mla): add WARN rung so enforceable rules take non-blocking graduated action

## 0.2.13 (2026-07-10)

- refactor(cli): implement portable hook mutex for concurrency management

## 0.2.12 (2026-07-10)

- fix(cli): route every workspace-membership 403 through one canonical handler
- fix(cli): mla status distinguishes non-membership from not-activated; whoami prints the workspace CUID and gains --json
- fix(cli): bug status/list accept --workspace and stop claiming a lookup "was not filed"
- fix(cli): doctor hook checks follow the install surface, not just ~/.meetless
- fix(cli): activate stops falsely telling plugin users to run mla init
- fix(cli): doctor asserts the whoami-resolved workspace matches the folder binding
- fix(cli): retry per-document persist failures on enrich ingest resume
- fix(cli): preserve the errno on system faults so fresh-box failures are diagnosable
- fix(cli): reconcile mla_command classifier with the real dispatch table

## 0.2.11 (2026-07-10)

- fix(mla): mla login self-heals on a contended session probe instead of suppressing the browser
- refactor(cli): update login completion message and auto-close behavior
- feat(cli): add workspace member management commands
- feat(cli): add `enrich accept` to materialize a run's durable rules from the sidecar
- feat(cli): onboard skill Step 5 surfaces durable rules for local acceptance
- test(cli): cover `enrich accept` and the candidates sidecar IO
