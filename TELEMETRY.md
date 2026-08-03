# Telemetry & privacy

`mla` is a local-first CLI. Its default posture is: **nothing about your
prompts, your files' contents, or your command arguments leaves your computer**.
The one exception is product-health analytics, which is **on by default** and is
sent to **your configured control** backend. It carries **ids, counts, rates,
enums, and one-way hashes**, plus one deliberate, documented exception: when one
of *your own* governance rules blocks or warns on a write, the event carries
that rule's text and the repo-relative path it acted on, so that **your** review
queue can adjudicate the block (§3). You can turn the whole plane off with a
single flag (see the kill switch below).

There are three outbound planes:

| Plane | Default | What leaves |
| --- | --- | --- |
| Crash reporting (Sentry) | OFF (no DSN baked) | random run id, command name, exit code, platform, version, plus on a crash the error TYPE and our own stack frames (never the error message) |
| Run traces | OFF unless your server opts in | command + flag NAMES, rolled-up route names, timings, and on a failure the error TYPE plus our own stack frames (to your control; relayed onward if that control is Meetless-hosted) |
| Product-health analytics | **ON** (opt-out) | ids/counts/rates/enums/hashes, plus on a governance deny your own rule's text and the repo-relative path it acted on (to your control; only the ids-only subset is mirrored onward) |

## 1. Crash reporting (Sentry): OFF by default

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
command name, the exit code, the platform string, and the `mla` version. The
command name is the **reduced** one (see §2): a keyword from a fixed list, or
`unknown`. No argument value ever reaches a tag.

**A crash report is reduced exactly like a failing trace (§2), because it is the
same problem on a second wire.** The event carries the error **type** and the
**frames** of the stack (our function names and line numbers, file paths
redacted, plus a few source lines around each frame read from `mla`'s own
installed JavaScript, never from your files); the message itself is replaced
with `<message withheld: mla bug
report --trace-id>` on every link of an `error.cause` chain, not just the
outermost one. An error message is prose written by whichever line threw, and
`mla` interpolates your argv into its own error text in well over a hundred
places, so shipping the message would ship what you typed. This matters most for
the errors that happen before a workspace is known (a bad flag, an unreadable
config): those bypass the dogfood gate above by design, and they are precisely
the ones whose text is built out of your argv and your paths. Sentry groups
issues on type plus stack, so triage still works; the message moves behind your
consent, via `mla bug report --trace-id <id>`.

Two of the SDK's default collectors are switched **off**, because a CLI's normal
behavior would feed them your content: the console collector, which would turn
every line `mla` prints into a breadcrumb (`mla ask` prints the answer, `mla kb
show` prints the document), and the HTTP collector, which would attach every
outbound call's raw path and query string (`?q=<your question>`). The CLI runs a
fixed allowlist of integrations rather than filtering the defaults, so a future
SDK release that adds a new default collector cannot switch on a new source of
content silently. Local variable capture is never enabled: it would attach the
value of any local named `question` or `prompt` verbatim.

## 2. Run traces: sent only to YOUR backend, OFF unless your server enables it

When the CLI is pointed at a control backend and a folder is activated, it builds
a small per-run span batch and POSTs it to **your configured control URL**
(`controlUrl` in `cli-config.json` / `MEETLESS_BACKEND_URL`).

Argv is **reduced, not redacted**. The batch carries a command keyword from a
fixed list (or `unknown`), an optional subcommand keyword, and the **names** of
recognized flags. Every positional and every flag value is dropped before the
span exists, so a question, a path, a document id or a pasted secret cannot
reach the wire whatever it looks like. This is the same reduction the analytics
plane uses (§3), and it replaces an earlier design that passed argv through a
secret redactor: that stripped token-shaped values and left ordinary prose
alone, so `mla ask "<your question>"` put the question on the span. HTTP child
spans carry the same treatment one layer down: a rolled-up route name
(`coordination-cases.:id`), never the raw path or its query string.

**A failing run is reduced the same way.** An error message is prose written by
whichever line threw, and `mla` interpolates your argv into its own error text
in well over a hundred places, so the message is the argv problem again in a
different field. The span carries the error **type** (`TypeError`,
`ConfigError`), an HTTP status if there was one, and the **frames** of the
stack: our function names and line numbers, with file paths redacted. The
message and the stack's header line are dropped. That answers the only question
the trace plane needs to answer, which code path failed, without carrying what
you typed. The detail is not lost, it moves behind your consent: you still see
the full message on your own terminal, and `mla bug report --trace-id <id>` is
the explicit, opt-in channel that sends it.

Your control server decides whether to keep it: by default it refuses
(`TRACING_NOT_ENABLED_FOR_WORKSPACE`) and the CLI stays silent. Traces are only
retained for workspaces your server explicitly opts in.

Where it goes next is your server's decision, not the CLI's. Point `mla` at your
own control and the batch stops there. Point it at Meetless-hosted control with
tracing opted in, and that server relays the batch onward to its observability
provider (Langfuse Cloud), the same way §3's aggregate is mirrored onward.

## 3. Product-health analytics: ids only, ON by default (opt-out)

To understand whether governed memory is actually helping (how often evidence is
injected, consulted, and acted on; where coverage gaps are; how reliable the
hooks are), the CLI records a small structured event per action to a local log
(`~/.meetless/events.jsonl`, also what `mla stats` reads) and forwards it to your
configured `control` backend, which dedupes, rolls it up, and mirrors an
aggregate to analytics server-side. The CLI itself never holds an analytics key.

Every forwarded field is an **id, a count, a rate, a closed enum, a boolean, a
duration, or a one-way hash**, with exactly one documented exception (below).
Concretely, what does **not** leave the machine: your prompt text, command
arguments, query strings, error messages, document contents, and any
content-derived identifier.

### The one exception: deny-review evidence

When one of **your own** governance rules blocks or warns on a write, the
enforcement event carries two content-bearing fields to **your** control:

- `rule_text`: the deciding rule's statement, snapshotted at the moment it
  fired. This is prose **you** authored in your own rule bundle, not content
  read out of your repo.
- `blocked_path`: the path the rule acted on, **repo-relative by construction**.
  Both producers get it from a single classifier that yields a path only for a
  repo-relative target and `null` for anything else, so an absolute path (and
  with it your machine's directory layout) cannot reach this field.

They exist for one reason: a deny you cannot see the *what* of is a deny you
cannot adjudicate, and your Console review queue is where you mark a block
confirmed or a false positive. Both fields stop at **your** control. They are
not on the onward mirror's allowlist, so they are dropped before anything is
mirrored (`INV-POSTHOG-PII-1` is a fail-closed, server-side **key** allowlist:
a key that is not on it never crosses, whatever its value looks like). The
coarse surface enum (`code` / `tests` / `docs` / ...) rides *alongside* the path
on the way to your control, and *instead of* it on the way onward.

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
attached to a Sentry event (no argument value of any kind reaches a span
attribute; see §2), and are never written to the trace batch. `mla whoami` and
`mla doctor` print your identity and token runway but never the token itself. The
browser-login exchange (the one-time authorization code and PKCE verifier) is POSTed
only to your Console / control backend, never to Meetless.

## The kill switch: turn everything off

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
