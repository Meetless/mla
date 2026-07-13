#!/usr/bin/env bash
# Bundled-docs smoke (self-documenting-CLI proposal 20260711, §11 test 26).
#
# Proves the SHIPPED artifact executes its BUNDLED documentation corpus. Both
# release surfaces run this: the native archive (packaged.sh default set, against the
# binary extracted from the real .tar.gz) and the exact npm tarball (npm-tarball.sh,
# against the bin npm installed). Those are the two artifacts a user can actually get.
#
# WHY this gate exists. The corpus is a COMMITTED, VENDORED build artifact, compiled
# into the CLI as code (src/lib/docs-corpus.data.ts -> dist/lib/). Nothing at runtime
# regenerates it, and nothing else in the smoke set reads it. Compiling it in removes
# the worst packaging failure (a forgotten asset), but it does not remove them all: a
# `files` entry, a pkg.scripts glob or an esbuild bundling step can still drop or
# mangle dist/lib, producing a binary that BUILDS GREEN, PUBLISHES GREEN, and then
# answers every `mla docs` with nothing. The offline docs are the pre-auth surface: the
# one thing a user who has not signed in yet can use. It must not be possible to ship
# it empty.
#
# Everything here is offline by construction: smoke_init gives an isolated HOME, an
# isolated MEETLESS_HOME (so no cli-config, no session), and a NON-git throwaway cwd
# (so no repository marker, no workspace). Anything that renders under those
# conditions can only have come from inside the artifact.
#
# Assertions:
#   1. `mla docs` lists the bundled topics (>= 18; the corpus ships 19).
#   2. EVERY listed topic renders: exit 0, a `# ` title, AND a real body (a body
#      heading plus a body-line floor, see below). A truncated or half-copied asset
#      dies here, not in a user's terminal.
#   3. `mla docs search` with a hit prints the "N matches" header (exit 0).
#   4. `mla docs search` with NO hit is exit 0, not an error (§7.6): an empty result
#      is a normal outcome, and the CLI points at `mla docs ask` instead of failing.
#   5. An unknown topic is exit 1 and names the two recovery commands (`mla docs`,
#      `mla docs search`).
#   6. `mla docs ask` with NO credentials is exit 1 (§7.6 row 8), tells the user to
#      run `mla login`, points at the offline surfaces, and NEVER prints an answer.
#      The sandbox has no reachable Control at all, so a call that WAS attempted would
#      fail its fetch and degrade to the labeled offline fallback: asserting that the
#      fallback banner is absent is what proves the credential check fails closed
#      BEFORE any call.
#   7. `mla help` renders the command registry (exit 0).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$DIR/lib.sh"
smoke_init docs "${1:?usage: docs.sh <mla-bin>}"

# The corpus ships 19 pages. A floor of 10 would have let HALF of them vanish from a
# release with the gate still green, which is not a gate, it is a decoration. One page
# of slack, so deleting a doc is a deliberate edit here rather than a mystery red.
MIN_TOPICS=18

# The smallest real page in the corpus carries 25 non-empty body lines. See the body
# assertion below for why this is not simply "3".
MIN_BODY_LINES=10

# ── 1. the topic list ─────────────────────────────────────────────────────────
LIST="$SMOKE_ROOT/list.out"
set +e
"$SMOKE_BIN" docs >"$LIST" 2>"$SMOKE_ROOT/list.err"
CODE=$?
set -e
[ "$CODE" -eq 0 ] || { cat "$SMOKE_ROOT/list.err" >&2; smoke_die "\`mla docs\` exited $CODE, want 0"; }
grep -q "Documentation topics:" "$LIST" || { cat "$LIST" >&2; smoke_die "topic list has no header"; }

# A topic row is `  <slug>  <title>`: exactly two leading spaces, then the slug.
# Wrapped description lines are indented far deeper, so they cannot match.
# `|| true`: zero matching rows is the EXACT failure this gate exists to catch (an
# empty or truncated corpus), and grep exits 1 on no match. Under `set -e` + pipefail
# that aborts the script here, silently, before the COUNT check below can print the
# diagnostic that names the problem. Swallow it and let the assertion do the talking.
TOPICS="$(grep -E '^  [a-z0-9][a-z0-9/-]*  ' "$LIST" | awk '{print $1}' || true)"
COUNT="$(printf '%s\n' "$TOPICS" | grep -c . || true)"
[ "$COUNT" -ge "$MIN_TOPICS" ] \
  || { cat "$LIST" >&2; smoke_die "bundled corpus lists $COUNT topics, want >= $MIN_TOPICS (asset missing or truncated?)"; }
smoke_ok "topic list: $COUNT topics"

# ── 2. every listed topic actually renders ────────────────────────────────────
# The list could be populated while the page bodies are empty (a partial asset).
# Reading all of them is the only honest proof, and it is cheap.
for slug in $TOPICS; do
  PAGE="$SMOKE_ROOT/page.out"
  set +e
  "$SMOKE_BIN" docs "$slug" >"$PAGE" 2>"$SMOKE_ROOT/page.err"
  CODE=$?
  set -e
  [ "$CODE" -eq 0 ] \
    || { cat "$SMOKE_ROOT/page.err" >&2; smoke_die "\`mla docs $slug\` exited $CODE, want 0"; }
  grep -q '^# ' "$PAGE" || { cat "$PAGE" >&2; smoke_die "\`mla docs $slug\` rendered no '# ' title"; }

  # A page whose BODY is empty is not empty output: `renderTopic` still emits the
  # `# <title>`, the wrapped description, and the `(docs/<slug> | <url>)` link, all of
  # which come from the doc's metadata rather than from a single passage. That is three
  # or so non-empty lines, so a ">= 3 lines" floor sat exactly ON the boilerplate and
  # would have passed the precise artifact this gate exists to catch: a binary whose
  # corpus carries the doc index but not the prose.
  #
  # Two independent proofs of a real body, because each catches what the other misses:
  #   a. A `## ` (or deeper) heading can only have come from a passage. Neither the head
  #      nor the footer can produce one, and every page in the corpus has at least one.
  #   b. A line floor over the body, which catches passages that are PRESENT but
  #      truncated (a heading with nothing under it). Strip the title and the footer
  #      link; what is left is the description plus the body. The smallest real page
  #      carries 25 body lines, and a description alone is one to three.
  grep -qE '^#{2,} ' "$PAGE" \
    || { cat "$PAGE" >&2; smoke_die "\`mla docs $slug\` rendered no body heading (corpus has the index but not the prose?)"; }
  LINES="$(grep -vE '^# |^\(docs/' "$PAGE" | grep -c . || true)"
  [ "$LINES" -ge "$MIN_BODY_LINES" ] \
    || { cat "$PAGE" >&2; smoke_die "\`mla docs $slug\` rendered only $LINES body lines, want >= $MIN_BODY_LINES (truncated page?)"; }
done
smoke_ok "all $COUNT topics render from the bundled corpus"

# ── 3. search, with a hit ─────────────────────────────────────────────────────
# "login" is a term the install + config pages both cover; a corpus that cannot
# match it is not the corpus we shipped.
HIT="$SMOKE_ROOT/hit.out"
set +e
"$SMOKE_BIN" docs search "login" >"$HIT" 2>"$SMOKE_ROOT/hit.err"
CODE=$?
set -e
[ "$CODE" -eq 0 ] || { cat "$SMOKE_ROOT/hit.err" >&2; smoke_die "\`mla docs search login\` exited $CODE, want 0"; }
grep -qE '^[0-9]+ matches? for "login":' "$HIT" \
  || { cat "$HIT" >&2; smoke_die "offline search found nothing for 'login' (corpus not searchable?)"; }
smoke_ok "search: $(head -1 "$HIT")"

# ── 4. search, with no hit: a normal outcome, NOT an error (§7.6) ─────────────
MISS="$SMOKE_ROOT/miss.out"
set +e
"$SMOKE_BIN" docs search "zzzznomatchzzzz" >"$MISS" 2>&1
CODE=$?
set -e
[ "$CODE" -eq 0 ] || { cat "$MISS" >&2; smoke_die "an empty search exited $CODE, want 0 (an empty result is not a failure)"; }
grep -q "No documentation matches" "$MISS" || { cat "$MISS" >&2; smoke_die "empty search printed no 'No documentation matches' line"; }

# ── 5. an unknown topic fails, and says how to recover ────────────────────────
UNK="$SMOKE_ROOT/unknown.out"
set +e
"$SMOKE_BIN" docs no-such-topic-here >"$UNK" 2>&1
CODE=$?
set -e
[ "$CODE" -eq 1 ] || { cat "$UNK" >&2; smoke_die "an unknown topic exited $CODE, want 1"; }
grep -q "No documentation topic named" "$UNK" || { cat "$UNK" >&2; smoke_die "unknown topic printed no explanation"; }
# "Says how to recover" is the whole point of the miss path, so assert the recovery
# commands are actually there rather than trusting the headline to imply them.
grep -qE '^List every topic: +mla docs$' "$UNK" \
  || { cat "$UNK" >&2; smoke_die "unknown topic does not offer \`mla docs\` (the topic list)"; }
grep -qE '^Search the docs: +mla docs search ' "$UNK" \
  || { cat "$UNK" >&2; smoke_die "unknown topic does not offer \`mla docs search\`"; }
smoke_ok "unknown topic: exit 1, names both recovery commands"

# ── 6. `docs ask` with no credentials: exit 1, no answer, no network ──────────
# §7.6 row 8. The sandbox has no cli-config.json at all, so this is the real
# never-signed-in state, not a simulated one.
ASK="$SMOKE_ROOT/ask.out"
set +e
"$SMOKE_BIN" docs ask "how do I sign in?" >"$ASK" 2>&1
CODE=$?
set -e
[ "$CODE" -eq 1 ] || { cat "$ASK" >&2; smoke_die "\`mla docs ask\` with no credentials exited $CODE, want 1"; }
grep -q "mla login" "$ASK" || { cat "$ASK" >&2; smoke_die "no-credentials path never tells the user to run \`mla login\`"; }
grep -q "mla docs search" "$ASK" \
  || { cat "$ASK" >&2; smoke_die "no-credentials path does not point at the offline surface"; }

# ...and it fails CLOSED, before the call. This sandbox has no reachable Control, so a
# request that WAS attempted could only end one way: the fetch fails, the command
# degrades, and the labeled fallback banner appears. Its absence (with exit 1, and no
# citation footer) is the proof that the credential gate ran first and nothing left the
# machine. A signed-out user must never be told the service is down; that is the wrong
# diagnosis and it hides the one thing they can fix.
#
# `if !` rather than `grep ... && smoke_die`: an AND-list whose first command fails is
# exempt from `set -e`, but the list's own status is that failure, and a NEGATIVE
# assertion is passing exactly when its grep exits 1. Writing it as an AND-list makes
# the pass path the one that returns non-zero, which is a coin flip with `set -e`.
if grep -qi "Showing bundled offline documentation" "$ASK"; then
  cat "$ASK" >&2
  smoke_die "no-credentials path DEGRADED, so it attempted a call BEFORE checking credentials"
fi
# Anchored on the string the renderer ACTUALLY emits (`Citations (2):`, from
# renderPlain in src/lib/ask-render.ts), not on a plausible-sounding one. A negative
# assertion against a string the program cannot produce is worse than no assertion: it
# is green forever, including on the day a signed-out user gets a full cited answer.
if grep -qiE "^Citations \(" "$ASK"; then
  cat "$ASK" >&2
  smoke_die "no-credentials path printed an answer"
fi
smoke_ok "docs ask without credentials: exit 1, no call attempted, points at \`mla login\` + offline docs"

# ── 7. `mla help` renders ─────────────────────────────────────────────────────
HELP="$SMOKE_ROOT/help.out"
set +e
"$SMOKE_BIN" help >"$HELP" 2>"$SMOKE_ROOT/help.err"
CODE=$?
set -e
[ "$CODE" -eq 0 ] || { cat "$SMOKE_ROOT/help.err" >&2; smoke_die "\`mla help\` exited $CODE, want 0"; }
grep -q "^usage:" "$HELP" || { cat "$HELP" >&2; smoke_die "\`mla help\` printed no usage block"; }

smoke_ok "OK: the shipped artifact serves $COUNT bundled topics offline, with no login and no workspace"
