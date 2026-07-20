# Plugin runtime facts (pinned Phase 0 evidence)

Captured from Claude Code plugin/marketplace schema **v2.1.153**.

`plugin-list.observed.json` in this dir is REAL redacted output. It contains NO
`mla@meetless` row (this machine dogfoods via the `mla` binary, not the plugin).
Every `mla@meetless` ownership case in the classifier tests is a SYNTHETIC row
constructed inline in Task 6, NOT captured evidence.

## `claude plugin list --json`
Array of objects: `{ id, version, scope, enabled, installPath, installedAt, lastUpdated, mcpServers? }`.
- `id` shape: `<plugin>@<marketplace>`, e.g. `mla@meetless`.
- `scope` observed: `"user"` (also `"managed"`, `"project"`, `"local"`).
- `enabled`: boolean.
- The `version` reported here is an OPAQUE string the classifier never interprets; it is whatever the install source assigns (a semver, a commit SHA, `"unknown"`, etc.) and is independent of the manifest `version` string. Do not hardcode an expected value; record the observed one.
- Piped output truncates at 64KB (GH #36685): always redirect to a temp file, never read from a pipe.

## `claude plugin validate` (schema-verified against the official docs, do not re-derive)
- Plain `validate` tolerates warnings ("passed with warnings", exit 0).
- `--strict` treats warnings as errors. UNRECOGNIZED top-level fields are warnings (→ errors under `--strict`); a WRONG-TYPE field is always an error regardless of `--strict`.
- `--strict` also fails an incomplete manifest: missing `version`, missing `description`, or missing `author` each trip a warning.
- **plugin.json `author`** accepts `{name, email, url}`: all three are documented, valid subfields. `name` is the only one required when `author` is present. So `author.url` does NOT fail `--strict`; we simply prefer to carry the product URL in `homepage` (below), which is its documented home.
- **plugin.json `homepage`** (string) is a valid top-level field (documentation / product URL). This is where the Meetless product URL goes.
- A COMPLETE plugin manifest (`name` + `version` + `description` + `author {name}` + `homepage`, no unknown top-level fields) PASSES `--strict` (exit 0).
- `source: "."` is REJECTED (`plugins.0.source: Invalid input`); the plugin must live in a subdir referenced as `source: "./plugin"`.
- A single dir holding BOTH plugin.json and marketplace.json validates ONLY as a marketplace (marketplace precedence). Layout: marketplace root `X/.claude-plugin/marketplace.json` (with `source: "./plugin"`) + plugin at `X/plugin/.claude-plugin/plugin.json`.

## `marketplace.json` schema (schema-verified)
- REQUIRED top-level: `name` (string), `owner` (OBJECT), `plugins` (array).
- **`owner`** accepts ONLY `{name, email}` (`name` required, `email` optional). `owner.url` is NOT a documented subfield; it trips `--strict`. Use `owner = {name:"Meetless"}`.
- Optional top-level: `$schema`, `description`, `version`, `metadata.pluginRoot`, `allowCrossMarketplaceDependenciesOn`, `renames`. There is NO top-level marketplace `homepage`.
- Empirically the marketplace root wants a top-level `description` or `--strict` warns; keep one.
- A plugin ENTRY in `plugins[]` requires `name` + `source`; optional `description`, `version`, `author`, `homepage`, etc. We keep entries minimal: `{name, source, description}`.

## Layout the plugin tree uses
- Marketplace root: `meetless-cli/.claude-plugin/marketplace.json` (top-level `description`, `owner = {name:"Meetless"}`, one plugin entry `source: "./plugin"`).
- Plugin root: `meetless-cli/plugin/.claude-plugin/plugin.json` (name `mla`, real `version` from `meetless-cli/packages/cli/package.json` (the `@meetless/mla` release package), NOT the private workspace-root `meetless-cli/package.json`; description, `author = {name:"Meetless"}`, `homepage = "https://meetless.ai"`).
- Marketplace catalog `name` = `meetless`; marketplace entry `name` = `mla`; plugin manifest `name` = `mla`; qualified id = `mla@meetless`.
