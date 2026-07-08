# Telemetry & privacy

`mla` is a local-first CLI. Its default posture is: **nothing about your
prompts, file paths, repo, or command arguments leaves your computer**. The one
exception is product-health analytics, which is **on by default** but carries
**only ids, counts, rates, enums, and one-way hashes** (never your prompts,
paths, argv, file contents, or error text), and is sent to **your configured
control** backend. You can turn it off with a single flag (see the kill switch
below).

There are three outbound planes:

| Plane | Default | What leaves |
| --- | --- | --- |
| Crash reporting (Sentry) | OFF (no DSN baked) | random run id, command name, exit code, platform, version |
| Run traces | OFF unless your server opts in | redacted argv, route names, timings (to your control only) |
| Product-health analytics | **ON** (opt-out) | ids/counts/rates/enums/hashes only (to your control, mirrored onward) |

## 1. Crash reporting (Sentry) — OFF by default

The CLI can report uncaught errors and non-zero exits to Sentry, but only when a
Sentry DSN is present:

- **Open-source builds bake no DSN**, so crash reporting is fully off: `initSentry`
  returns `false` and every capture call is a no-op.
- A DSN is read from (in order): the DSN baked into the binary at build time
  (CI sets `SENTRY_DSN`), or, for local dev builds only, the
  `MEETLESS_SENTRY_DSN` env var (legacy alias `MLA_SENTRY_DSN`).
- Even with a DSN, non-bootstrap captures are gated to dogfood workspaces; a
  normal workspace never sends them.

What a captured event contains, when enabled: a random per-run trace id, the
command name, the exit code, the platform string, and the `mla` version. Command
arguments are **redacted** (token-shaped values stripped) before they reach any
span attribute.

## 2. Run traces — sent only to YOUR backend, OFF unless your server enables it

When the CLI is pointed at a control backend and a folder is activated, it builds
a small per-run span batch (redacted argv, route names, timings, platform, `mla`
version) and POSTs it to **your configured control URL** (`controlUrl` in
`cli-config.json` / `MEETLESS_BACKEND_URL`). This is never sent to Meetless.

Your control server decides whether to keep it: by default it refuses
(`TRACING_NOT_ENABLED_FOR_WORKSPACE`) and the CLI stays silent. Traces are only
retained for workspaces your server explicitly opts in.

## 3. Product-health analytics — ids only, ON by default (opt-out)

To understand whether governed memory is actually helping (how often evidence is
injected, consulted, and acted on; where coverage gaps are; how reliable the
hooks are), the CLI records a small structured event per action to a local log
(`~/.meetless/events.jsonl`, also what `mla stats` reads) and forwards it to your
configured `control` backend, which dedupes, rolls it up, and mirrors an
aggregate to analytics server-side. The CLI itself never holds an analytics key.

Every forwarded field is an **id, a count, a rate, a closed enum, a boolean, a
duration, or a one-way hash** (the privacy boundary, `INV-POSTHOG-PII-1`,
enforced both in the CLI and again server-side). Concretely, what does **not**
leave the machine: your prompt text, file paths, command arguments, query
strings, error messages, document contents, and any content-derived identifier.
A blocked file path, for example, is reduced to a coarse surface enum
(`code` / `tests` / `docs` / ...), never the path itself.

This plane goes to **your configured control** (`controlUrl` /
`MEETLESS_BACKEND_URL`); if you point `mla` at Meetless-hosted control, the
ids-only aggregate is mirrored onward from there. Turn it off with the kill
switch below; local recording for `mla stats` keeps working regardless.

## Authentication credentials are not telemetry

`mla login` and `mla init` store auth material (a user access plus refresh token, or
a shared `control` key) in `~/.meetless/cli-config.json` on your machine. These are
**request credentials, not telemetry**: they are sent only to the `control` backend
the CLI is explicitly pointed at (`controlUrl` / `MEETLESS_BACKEND_URL`), and only as
the proof needed to authenticate that request. They never go to Meetless, are never
attached to a Sentry event (token-shaped values are redacted from argv before any
span attribute), and are never written to the trace batch. `mla whoami` and
`mla doctor` print your identity and token runway but never the token itself. The
browser-login exchange (the one-time authorization code and PKCE verifier) is POSTed
only to your Console / control backend, never to Meetless.

## The kill switch — turn everything off

To guarantee that **no** plane emits anything (crash reporting, run traces, and
product-health analytics alike), regardless of how a backend or build is
configured:

```bash
export MEETLESS_TELEMETRY=off        # accepts: off | 0 | false | no
# or
export MEETLESS_NO_TELEMETRY=1       # any truthy value
```

With the kill switch set, `initSentry` refuses to initialize, the trace plane
becomes a no-op (spans are still built in-process for local timing, but never
leave the machine), and the analytics forwarder skips on consent
(`remoteAnalyticsEnabled` returns false). Local recording for `mla stats`
(`MEETLESS_LOCAL_STATS`) is independent and stays on unless separately disabled.

`mla init` prints a one-line disclosure of this on first run.
