# Changelog

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
