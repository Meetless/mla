# Changelog

## 0.2.34 (2026-08-04)

0.2.34 is about a measurement that had never once been taken. `mla` records when an agent
consults governed evidence before it writes code, and that number has been zero across every
production workspace since the lane was built. It was not zero because agents were not
consulting. It was zero because the hook that observes them was registered under the matcher
`mcp__meetless__`, and Claude Code decides whether a hook runs by matching that pattern against
the whole tool name, not against its beginning. A bare prefix therefore selects nothing at all.
The capture code underneath was correct and carried twenty unit tests; nothing tested that it was
ever reached, which is the only test that would have failed.

Fixing the matcher produced the second half of the same fault. The hook fired on a real call and
wrote `UNKNOWN` with no result: a row attesting that a consultation happened while unable to say
whether anything came back, which is precisely the quantity the lane exists to produce. Claude
Code sends the content-block array itself as the tool response, while the MCP shape wraps that
array in an object, and the classifier rejected anything that was not an object on its first line.
The twenty existing tests all constructed the wrapped form, so the suite had been agreeing with
its own fixture rather than with the client, and the dead matcher guaranteed no real payload ever
arrived to contradict it.

Those two fixes reach a source install. They did not reach a plugin install, because the plugin
ships a rendered copy of the hook registration and that copy still carried the original matcher.
It is regenerated here. Without it the repair would have been invisible to exactly the
distribution most people use.

Separately, the CLI could exit fatally on a closed stdout pipe. Node reports that condition as an
event on the stream rather than as a rejected promise, so neither the bootstrap's `.catch()` nor
the entrypoint's `try` could observe it, and with no listener attached it became an uncaught
exception. The site where it was caught in the wild is cosmetic, a trace URL printed at the end of
a command, but five of the CLI's writer sites are hook entrypoints whose stdout belongs to a
parent process that is allowed to exit first. One of those entrypoints exists specifically to fail
open so that a fault inside it can never turn into a blocked tool call, and a closed pipe was
defeating that guarantee from underneath.

- the consultation hook now matches the tool names it was always meant to match, so evidence
  consultation is recorded instead of silently never observed
- a consultation is classified correctly whichever response envelope the client sends, rather
  than recorded as `UNKNOWN`
- the bundled plugin carries the corrected hook registration, so plugin installs get the fix and
  not just source installs
- a closed stdout pipe no longer terminates the CLI, and no longer breaks the fail-open contract
  of the hook entrypoints
- a checkout that cannot read a bundle no longer overwrites another checkout's governing floor
  with an empty one

## 0.2.33 (2026-08-03)

0.2.33 is about state that several checkouts share and none of them owns. `mla` keeps a
per-workspace scan cache and a generated governing floor, and both were keyed by workspace id
alone. That key is right up until the same repository exists on disk twice, which on a machine
running agents is the ordinary case rather than the exotic one: a throwaway clone, a worktree, a
sandbox under a temp directory. The most recent scan won every time. A single scan from a
throwaway directory would take the cache slot away from the live checkout that had been using it,
and nothing anywhere reported the loss, because the next command simply found no cache and
behaved as though there had never been one. Four of the eleven slots in this machine's own home
were dark that way when the bug surfaced.

Downstream of that, `mla status` told a repository it was "not activated" whenever a sibling
checkout owned the slot. The cache read returns nothing for two structurally different reasons, a
slot that was never written and a slot stamped by another root, and status collapsed both into the
same sentence. The first is true. The second is false in the worst available direction: it sends
you to re-run activation on a workspace that is already activated. The generated floor had the
same shape with a wider blast radius, since a scan run from a sandboxed state root could overwrite
the `.claude/rules` projection of a real checkout, swapping the rules an agent is actually governed
by for whatever a temp directory produced.

Each of those pieces of state now has an owner. The first root to stamp a cache slot keeps its
repository-specific fields for as long as that root exists on disk, and slots whose root has
vanished are pruned ahead of the size cap, because recency is exactly backwards for this hazard:
throwaway roots are the newest slots. The floor projection records the state root that wrote it, so
a writer belonging to a different but still-live root declines instead of clobbering. A stamp
naming a root that is gone is abandoned, and a projection written before stamps existed is still
adoptable, so neither rule can strand you.

Last, a workspace id was being spliced into filesystem paths with nothing checking it was a path
component, reaching six path builders through one seam. The evidence was already on disk: a
directory named with the shell quotes still wrapped around the id, sitting beside the legitimate
one. Ids that are not safe path components are now rejected rather than sanitized, because a
sanitized id quietly addresses a different workspace than the one you asked for.

- a scan from a throwaway or sandboxed checkout no longer takes the workspace cache away from a
  live one; the first root to claim a slot keeps it until that root is gone from disk
- `mla status` distinguishes a workspace that was never activated from one whose cache slot is
  owned by a sibling checkout, instead of reporting both as "not activated"
- the generated governing floor records the state root that wrote it, so a scan from a sandbox
  cannot overwrite the rules a real checkout is governed by
- a workspace id that is not a safe path component is rejected at the single seam where it becomes
  a directory name, rather than being sanitized into a path for some other workspace

## 0.2.32 (2026-08-03)

0.2.32 opens with the upgrade path, because it was the one command that could lie to you and still
exit 0. `mla upgrade` decided it was allowed to self-replace by finding the running binary under
`MLA_INSTALL_DIR`, then named the file it would actually overwrite from `MEETLESS_HOME`. Set
`MEETLESS_HOME` anywhere non-default and those two roots part. The upgrade then downloaded the
release, verified its signature and its checksum, renamed the new binary into a path nothing
executes, wrote no rollback slot, left the real binary sitting on the old version, printed
"Upgraded mla 0.2.30 to 0.2.31", and returned success. The binary that gets replaced is now the
binary that is running. The self-update canary had caught this on both runs it ever made, and both
times it was read as a bug in the canary.

The rest of the release is about a workspace that has nothing indexed and no way to learn that.
Measured in prod: 72 of the 80 live repository workspaces are activated with an empty corpus, and
eight of them served 283 `retrieve_knowledge` pulls over six days that all came back empty. An
agent reads an empty pull as "this fact was never recorded" rather than "nothing here was ever
indexed", so it reports an absence of evidence as an absence of the fact. Three changes close that
gap. The retrieval tools now distinguish a workspace that never ingested from one whose documents
all landed in a capture lane that cannot ground an answer, and say plainly that retrieval will
return nothing for every query instead of naming an onboarding step you already ran. `mla activate`
hands off to onboarding on a standing condition, "this workspace has never been onboarded", rather
than the one-time edge that reached only whoever ran the very first activate in a folder and never
a teammate who cloned a committed marker. And a session that opens on an activated but empty
workspace says so once, to the agent, and stays quiet whenever it cannot find out.

Two more things were quietly wrong. The scan cache was keyed by workspace id alone, so a repository
checked out three times bound one workspace to a single cache slot and the most recent scan
darkened the other two roots; `mla doctor` was asking whether any scan existed rather than whether
this root could read one, and the hook receipt was reporting what a delivery intended rather than
what it did. Separately, `mla ask` was putting your question on the trace plane twice, once as a
root span name built from raw argv and once as an argv attribute, through a redactor written to
strip credentials and paths, which by construction leaves prose alone. Four seams carried it, not
one. The trace plane now reduces argv the way the analytics plane always has: a known command, a
known subcommand, approved flag names, and positionals dropped whole.

- `mla upgrade` replaces the binary that is actually running, so an install under a custom
  `MEETLESS_HOME` can no longer report an upgrade it did not perform
- the retrieval tools tell an agent when a workspace holds captured documents that will never
  ground an answer, instead of repeating an onboarding step that has already been run
- the onboarding hand-off reaches everyone who activates a workspace nobody has onboarded, not only
  the first person in the folder
- a session opening on an activated workspace with an empty corpus says so once, and says nothing
  at all when the check does not come back
- the scan cache is keyed by root as well as by workspace, so three checkouts of one repository
  stop erasing each other's scans
- `mla doctor` reports whether this root can read a scan, and the hook receipt reports what was
  delivered rather than what was intended
- `mla ask` no longer sends your question to the trace plane, on any of the four seams that
  carried it
- handled failures record why they failed, so a usage mistake and an infrastructure fault stop
  sharing one undiagnosable bucket
- `mla enrich resolve` is idempotent: repeating a resolution that already succeeded no longer
  re-mints the rule, rewrites the rules file, or moves the timestamp the audit trail exists to hold
- deleting a scout no longer makes every run that ever used it unreadable, and a model can no
  longer name its own rule class
- the public mirror's scrub rules are enforced at commit time now, all eleven of them, so a fixture
  carrying a real name, an internal path, or a real workspace id fails where the cost is one edit
  rather than silently holding the mirror a version behind

## 0.2.31 (2026-08-01)

0.2.31 gives `mla enrich` a third scout and somewhere for its findings to go. Reconciliation reads
your documentation against your git history and reports where the two have drifted apart: a rule a
document still states that a commit already broke. A finding like that is an accusation, so the CLI
refuses to persist one it cannot prove against your repository. The claimed file change is compared
field for field against what git actually reports, the quote must be an exact substring of the
document as of the head commit (what gets stored is the CLI's own span, never the model's string),
and the ordering is settled by `git merge-base --is-ancestor` rather than by dates, because a
timestamp does not prove which change came first. Anything the CLI cannot check itself is dropped.
Findings then lead the run summary instead of hiding under twenty tallies, and the new
`mla enrich resolve` closes one with a real answer: say the code diverged and the rule is minted
through the same governance path `enrich accept` uses, or record that the doc is stale or that this
is a deliberate carve-out and nothing is minted. Your pick is the approval; there is no second
prompt.

Two silent failures also got their voice back. `mla activate` on an already-bound repository used
to print "Already activated" from local state alone, so a new hire who cloned a repo with a
committed `.meetless.json` got a green exit and then a 403 on everything afterwards, because
binding to a workspace marker is not the same as holding membership in it. Activate now asks
control, and only a real deny answer changes the verdict, so being offline still behaves the way
it always has. And every command was uploading a trace batch that the server was built to refuse:
the relay is only permitted for workspaces explicitly opted into tracing, the CLI applied that rule
to error reporting and not to trace upload, and the resulting refusals were silenced on both sides.
The CLI now asks permission before it builds the relay, and a withheld relay no longer reports
success or prints a trace link for a trace that never left your machine.

- the reconciliation scout finds where your docs and your git history disagree, and proves every
  finding against the repository before persisting it
- `mla enrich resolve` closes a finding with one of three answers, minting the rule only when you
  say the code diverged
- ingest findings now lead the run summary with a runnable next command instead of being written
  somewhere no surface reads
- `mla activate` verifies a shared binding grants real membership instead of trusting the marker
  file
- no command uploads a trace batch to a workspace the server would refuse, and a suppressed relay
  no longer claims it succeeded
- an empty prompt is classified as our plumbing failing rather than as the router declining to
  answer

## 0.2.30 (2026-07-29)

0.2.30 carries no user-facing change. Every command, flag, and output behaves exactly as it did in
0.2.29; the version exists so the published surfaces sit on the same tree as the backend that
shipped alongside it. What did change is hygiene the public mirror inherits. The CLI workspace had
been sitting outside the repo's lint gate entirely, so its source was the one part of the codebase
nothing was checking, and it is now inside that gate. Two test fixtures were also carrying things
that had no business leaving this machine: a real internal workspace-user id threaded through the
ask parity fixtures, and a private filesystem path named in a hook spec. Both are genericized. If
you are already on 0.2.29, there is nothing here you need.

- the CLI workspace is inside the repo's lint gate instead of outside its field of view
- a real user id no longer rides along inside the ask parity fixtures
- a test fixture no longer names a private notes path the public mirror cannot carry

## 0.2.29 (2026-07-29)

0.2.29 is mostly the redactor learning the difference between a credential and a sentence about
one. The scrub that keeps secrets off the wire had started refusing runbooks, design notes, and
anything that merely said "Bearer token" or "passphrase" out loud, which made the safe path the
annoying one. It now reads a value the way a person does: on the same line as its name, set by a
header rather than described in prose, and a reference to a secret is not the secret. Every
refusal that matters is intact and pinned by a test, including the two residuals that were
previously only a comment. The other half of the release is `mla scan` finally reporting absence:
it tells control what the checkout no longer contains, so a file you deleted stops being cited as
evidence. That half needs the backend shipped alongside it, and it is. Two spend paths also got
their attribution back, an ask that posted no actor and a suspended account that read like a
customer who forgot to pay, and three error paths stopped blaming intel for refusals we issued
ourselves.

- a reference to a credential is not the credential, so a runbook stops being scrubbed
- a value lives on the same line as its name
- a header sets a value; a sentence describing one does not
- a bare word is not a value unless a human chose it
- an elision and a name are references, not values
- `scope_key` is a domain identifier, not a credential
- a passphrase is a password, and the word list now knows it
- a phrase is a credential shape, so a token-shaped placeholder stays refused
- a credential-word suffix cannot buy an exemption for what sits in front of it
- the two measured prose residuals carry an executable ruling instead of a comment
- the `redis_directive` residual is pinned as a ruling, not a gap
- `mla scan` states what the checkout contains, so control can sweep what it no longer sees
- the scan reports absence, so evidence you deleted stops being cited
- the plugin artifact is the shipped hook, so it moves with its source
- CI gates the plugin, because the plugin is what ships the hooks
- retrieval is no longer paid for on prompts nobody asked
- the one non-KB provider we actually shipped is no longer starved
- the retrieval profile stops eating the subject of the question
- an ask that posts no actor is anonymous spend, so it now carries one
- a suspended account reads as suspended, not as a customer who forgot to pay
- a recovered evidence outage stops shouting that intel is down
- a refusal we issued ourselves is not the server going down
- the governance nudge says why it is quiet, and it has been quiet since July 7
- the export gate scans what we publish and gates the harvest, not the mention
- the public corpus fixture is synthetic rather than a harvest of the private tree
- the activation gate spec no longer races its own detached spawns

## 0.2.28 (2026-07-27)

0.2.28 is about what leaves your machine. Every payload `mla` sends now passes through a single
egress boundary that refuses to ship a body it cannot classify, so redaction is the default path
instead of something each call site had to remember. The boundary now covers the four MCP routes
it was previously refusing outright, reads its field list off the actual caller rather than
guessing from the route name, and carries a third redaction profile for the events ledger so your
file paths survive a scrub that secrets do not. A refusal that used to be swallowed now says so,
once, instead of failing quietly forever. Alongside that, install wires Codex automatically for
parity with Claude Code, and the MCP tools got more honest: an empty `retrieve_knowledge` tells
you why it was empty and names the remedy, a reachable intel stops being reported as unreachable,
and the pending relationship queue is ordered by what needs attention rather than by arrival.

- one egress boundary that no request body can leave unclassified
- the `/v1/ask` payload builder redacts by default, closing the last raw egress path
- every network capture is redacted at the boundary, not just two of them
- the four MCP egress routes the boundary was refusing are registered
- egress field lists are read off the caller, not inferred from the route name
- a third redactor profile keeps file paths in the events ledger while still scrubbing secrets
- a swallowed egress refusal is permanent, so it now reports itself once
- a JWT is redacted whole, and the wire question keeps its retrieval key
- an injected redaction function can no longer redact less, and names survive
- the redaction corpus fixture carries synthetic identifiers, and its generator now enforces that
- a hook event attributes touched files to the session that changed them, not the whole dirty tree
- `mla kb add` is no longer blocked by the egress boundary, and sends the real body
- `mla adoption` reports a governed-catch floor rather than leaving follow-through unmeasured
- `mla install` auto-wires Codex for parity with Claude Code, reported source-neutrally
- an empty `retrieve_knowledge` explains why and names the remedy
- a reachable intel is no longer reported as unreachable
- the pending relationship queue is attention-ordered rather than FIFO
- the abstain gauge stops counting the router's own design as recall debt
- `publish-gcs` is write-once, so a republish can never overwrite a shipped artifact
- the codex connector manifest version is kept in lockstep by `plugin:sync`
- the reported workspace root is honest for public eyes

## 0.2.27 (2026-07-24)

0.2.27 makes `mla scan` a reconciliation producer and makes the CLI honest about why an answer
came back thin. When you scan a checkout that carries governed instructions, `mla` now uploads a
snapshot of them so the backend can reconcile what your working tree still assumes against what has
since been decided, closing the loop that surfaces drift and supersession back to you. And when
evidence is missing, the per-turn recap stops flattening every empty result into one shrug: it tells
a real evidence-backend outage apart from a legitimate no-match, separates a correct abstain from a
genuine should-have-matched miss, and treats a transient billing hold (a reserved or not-yet
provisioned balance) as retryable rather than a hard failure. You can finally tell "nothing to say"
from "something broke."

- `mla scan` uploads repo-instruction snapshots so the backend can reconcile drift (reconciliation producer)
- the per-turn recap distinguishes an evidence-backend outage from a merits-based no-match
- NO_OFFER is split into a correct abstain versus a should-have-matched miss
- intel evidence failures surface through a discriminated, leak-free classifier
- a FULLY_RESERVED / NOT_PROVISIONED 402 is treated as a transient billing hold, not a hard failure

## 0.2.26 (2026-07-23)

0.2.25 captured your Codex work; 0.2.26 puts governed reconciliation in front of the agent while it
works. When a decision has superseded or drifted from what your working tree still assumes, `mla` now
pulls the matching reconciliation findings, gates them by trust, and injects them inline from the hook
tail, so the agent meets the conflict at the moment it edits rather than after the rework has already
landed. `mla ask` surfaces the documentation impact of a change in the same pass. This release also
adds `mla decisions show`, a read-time export that assembles a decision's full governed record as
Markdown or JSON and names the evidence you are not entitled to read as private rather than linking to
it. And ingest no longer fails as a batch: a malformed or empty document is isolated and skipped, so
one bad file no longer sinks the rest.

- reconciliation findings are pulled, gated by trust, and rendered
- the reconciliation block is injected from the hook tail
- `mla decisions show`: read-time DecisionRecord export across CLI, MCP, and control
- documentation impact on `mla ask`, and the rehash gate is rooted at the scan root
- repair the three drift pins `mla decisions` broke
- escape the dedupe-key delimiter instead of embedding a raw NUL byte
- isolate ingest failures per document, skip empty files

## 0.2.25 (2026-07-22)

0.2.24 wired Codex up; this release makes the wiring actually carry your work. Codex sessions now
reach Console with their full lifecycle captured, not just their opening, and the decisions a human
makes inside a Codex session are captured and normalized alongside the ones from Claude Code. Hook
helpers stay version-aligned with the binary that installed them, and each hook runtime is isolated
so one agent's hooks cannot be answered by another's. On the ingest side, `mla kb add --mode corpus`
no longer demands a marker file before it will do anything, `--provenance` stops silently recording
something other than what you passed, and `kb summary` / `kb dump` accept the `--workspace` flag
every sibling command already took. Ingesting a large corpus is also no longer a coin flip: a
request that outran the edge used to come back as an opaque gateway timeout claiming nothing had
persisted while documents were in fact still landing, so the budget is now sized against the ceiling
that actually fires and a failed batch names the files it lost.

- Codex sessions surface in Console, with the full session lifecycle captured rather than only the start
- human decisions made inside a Codex session are captured and normalized
- Codex hook helpers stay aligned with the version of `mla` that installed them
- each Codex hook runtime is isolated, so concurrent agents cannot answer each other's hooks
- Codex gets equal billing with Claude Code across the site, docs, and install flow
- `mla kb add --mode corpus` works without a `.meetless-kb-corpus.json`; it synthesizes a permissive marker in memory and says so, and nothing is written into the folder you asked it to read
- an explicit corpus marker is still honoured, and the error for a malformed one now prints a paste-ready manifest with your workspaceId filled in
- `--provenance` no longer accepts a value in silence and records a different one; an unrecognized kind warns, names the server's kinds, and says the receipt may differ. The server still owns the immutable lineage label
- `mla kb summary` and `mla kb dump` accept `--workspace`, instead of silently reporting the activated workspace and printing "0 chunks" for a corpus that landed elsewhere
- large corpus ingests stop failing opaquely: documents ride in batches of 5, the client aborts before the edge severs the request, and a failed batch names every file it did not persist
- a retried ingest is safe and converges: documents that already landed come back unchanged rather than duplicating

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
