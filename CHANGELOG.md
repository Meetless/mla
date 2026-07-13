# Changelog

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
