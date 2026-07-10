# Changelog

## 0.2.11 (2026-07-10)

- fix(mla): mla login self-heals on a contended session probe instead of suppressing the browser
- refactor(cli): update login completion message and auto-close behavior
- feat(cli): add workspace member management commands
- feat(cli): add `enrich accept` to materialize a run's durable rules from the sidecar
- feat(cli): onboard skill Step 5 surfaces durable rules for local acceptance
- test(cli): cover `enrich accept` and the candidates sidecar IO
