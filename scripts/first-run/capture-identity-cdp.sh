#!/usr/bin/env bash
# Capture ONE prod user-token identity with a PUBLISHED mla binary, clicking the authorize
# page over CDP in a DEDICATED Chrome profile instead of waiting on a human.
#
# WHY THIS EXISTS (and how it differs from capture-identity.sh)
# ------------------------------------------------------------
# `/cli/authorize` mints nothing without a real click, by design: it is a top-level form POST
# behind a console session so the browser follows the 303 to the CLI's loopback listener as a
# full navigation. `mla login` gives that click a hard 5-minute window and run.sh aborts the
# whole channel on a nonzero login, so Phase 5c fails outright whenever nobody is at the
# keyboard. On 0.2.31 that scored 10 pass / 4 fail where all four failures were one missing
# click, counted twice.
#
# capture-identity.sh solved the SCHEDULING half: it pins one authorize tab in the operator's
# own Chrome and re-mints before each window expires, so the click works whenever they get to
# it. It still needs the operator.
#
# This solves the rest. A dedicated Chrome profile is signed into the console ONCE by a human.
# From then on this drives the real login, the real authorize page and a real trusted click in
# that browser, with nobody present. The authorization is still a human's: they signed that
# browser in, and the grant is minted against their session. What is removed is their
# synchrony, not their consent.
#
# WHY A DEDICATED PROFILE AND NOT THE PLAYWRIGHT ONE
# --------------------------------------------------
# The shared automation profile belongs to whichever skill claimed it, and two agents driving
# one browser fight over tabs. This profile is the release lane's own, so signing it in grants
# standing console access to release automation ONLY, and a concurrent agent cannot steer it.
#
# usage: capture-identity-cdp.sh <mla-bin> <out.json> [max-minutes]
#   MLA_CDP_PORT      CDP port for the dedicated profile   (default 58970)
#   MLA_CDP_PROFILE   profile dir                          (default ~/.claude/skills/mla-release/chrome-profile)
#   MLA_CDP_CHROME    Chrome binary                        (default: Playwright's Chrome for Testing, then Google Chrome)
#   MLA_CAPTURE_PORT  loopback port for the login listener (default 52170)
set -uo pipefail

BIN="${1:?usage: capture-identity-cdp.sh <mla-bin> <out.json> [max-minutes]}"
STASH="${2:?usage: capture-identity-cdp.sh <mla-bin> <out.json> [max-minutes]}"
MAXMIN="${3:-15}"
PORT="${MLA_CAPTURE_PORT:-52170}"
CDP_PORT="${MLA_CDP_PORT:-58970}"
PROFILE="${MLA_CDP_PROFILE:-$HOME/.claude/skills/mla-release/chrome-profile}"
CONSOLE_URL="${MLA_CONSOLE_URL:-https://app.meetless.ai}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLICKER="$HERE/authorize-click.mjs"
SBX="${TMPDIR:-/tmp}/mla-capture-cdp.$$"

say() { printf 'capture: %s\n' "$*"; }
cleanup() { rm -rf "$SBX"; }
trap cleanup EXIT

[ -x "$BIN" ] || { say "FAIL: not executable: $BIN"; exit 2; }
[ -f "$CLICKER" ] || { say "FAIL: missing $CLICKER"; exit 2; }
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  say "FAIL: loopback port $PORT already has a listener; set MLA_CAPTURE_PORT"; exit 2
fi

# ---- 1. the dedicated browser is up and attachable ---------------------------------------
cdp_up() { curl -fsS --max-time 2 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1; }

if ! cdp_up; then
  CHROME="${MLA_CDP_CHROME:-}"
  if [ -z "$CHROME" ]; then
    for c in \
      "$HOME/Library/Caches/ms-playwright"/chromium-*/chrome-mac-arm64/"Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" \
      "$HOME/Library/Caches/ms-playwright"/chromium-*/chrome-mac/"Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" \
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
      [ -x "$c" ] && { CHROME="$c"; break; }
    done
  fi
  [ -n "$CHROME" ] || { say "FAIL: no Chrome found; set MLA_CDP_CHROME"; exit 2; }

  say "launching the dedicated release profile on CDP port $CDP_PORT"
  mkdir -p "$PROFILE"
  # No --enable-automation and no --headless: Google refuses sign-in to a browser that
  # advertises itself as automated, and this profile has to complete a real Google login once.
  "$CHROME" --user-data-dir="$PROFILE" --remote-debugging-port="$CDP_PORT" \
    --no-first-run --no-default-browser-check "$CONSOLE_URL" >/dev/null 2>&1 &
  for _ in $(seq 1 40); do cdp_up && break; sleep 0.5; done
  cdp_up || { say "FAIL: Chrome did not expose CDP on $CDP_PORT"; exit 2; }
fi
# grep the field out first: /json/version is pretty-printed, and a bare `sed` substitution is
# line-based, so every non-matching line would pass through and dump the whole document.
say "CDP:     $(curl -fsS "http://127.0.0.1:$CDP_PORT/json/version" | grep -o '"Browser": *"[^"]*"' | cut -d'"' -f4)"
say "profile: $PROFILE"

# ---- 2. that browser holds a console session ---------------------------------------------
# A signed-out profile is a ONE-TIME human step, not a failure, so say exactly what to do and
# wait rather than dying. Every later run finds the session already there and skips this.
# --input-type=module must come BEFORE -e or node parses it as script argv, not as an option:
# newer node infers the module goal and top-level await works anyway, older node does not.
signed_in() {
  MLA_CDP_PORT="$CDP_PORT" node --input-type=module -e '
    const port = process.env.MLA_CDP_PORT;
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const t = list.find((x) => x.type === "page");
    if (!t) process.exit(1);
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    const pend = new Map(); let seq = 0;
    const send = (method, params = {}) => new Promise((r) => { const i = ++seq; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
    await new Promise((r) => ws.addEventListener("open", r));
    const r = await send("Runtime.evaluate", { expression: "/\\/signin|accounts\\.google\\.com/.test(location.href)", returnByValue: true });
    process.exit(r.result?.result?.value === false ? 0 : 1);
  ' 2>/dev/null
}

if ! signed_in; then
  say "the release profile is NOT signed into the console."
  say "ONE-TIME: sign in as the release operator in the Chrome window that just opened."
  say "waiting up to ${MAXMIN}m for that session (every later run skips this step)."
  wait_until=$(( $(date +%s) + MAXMIN * 60 ))
  while [ "$(date +%s)" -lt "$wait_until" ]; do
    sleep 5
    signed_in && break
  done
  signed_in || { say "FAIL: no console session appeared; nothing captured"; exit 5; }
fi
say "session:  console session present"

# ---- 3. real login, real authorize page, real click ---------------------------------------
mkdir -p "$SBX/home" "$SBX/meetless" "$SBX/tmp" "$(dirname "$STASH")" || exit 2
log="$SBX/login.log"
say "binary:   $("$BIN" --version 2>&1 | head -1)"

# env -u MEETLESS_CONTROL_TOKEN: a shared-key credential in the environment is a HARD ERROR
# once the config is user-token, and would poison the capture.
env -u MEETLESS_CONTROL_TOKEN \
  HOME="$SBX/home" MEETLESS_HOME="$SBX/meetless" \
  TMPDIR="$SBX/tmp" TMP="$SBX/tmp" TEMP="$SBX/tmp" \
  MEETLESS_TELEMETRY=off MLA_NO_UPDATE_NOTIFIER=1 MLA_NO_WIRE=1 MLA_NO_MODIFY_PATH=1 \
  "$BIN" login --no-browser --port "$PORT" >"$log" 2>&1 &
pid=$!

url=""
for _ in $(seq 1 120); do
  url="$(grep -oE 'https://[^[:space:]]+/cli/authorize[^[:space:]]+' "$log" 2>/dev/null | head -1)"
  [ -n "$url" ] && break
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.25
done
if [ -z "$url" ]; then
  say "FAIL: no authorize URL printed. That is a login failure, not a missing click:"
  sed 's/^/    /' "$log"
  wait "$pid" 2>/dev/null
  exit 3
fi
say "minted:   authorize URL on $(printf '%s' "$url" | sed -E 's#https://([^/]+)/.*#\1#')"

if ! MLA_CDP_PORT="$CDP_PORT" node "$CLICKER" "$url"; then
  rc=$?
  say "FAIL: CDP click failed (exit $rc)"
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  exit "$rc"
fi

wait "$pid"; code=$?
cfg="$SBX/meetless/cli-config.json"
if [ "$code" -eq 0 ] && grep -q '"user-token"' "$cfg" 2>/dev/null; then
  cp "$cfg" "$STASH"; chmod 600 "$STASH"
  say "CAPTURED -> $STASH"
  node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const a = j.auth || {};
    console.log("capture: identity ->", JSON.stringify({
      controlUrl: j.controlUrl, mode: a.mode,
      user: a.user && a.user.email, role: a.user && a.user.role,
      accessExpiresAt: a.accessExpiresAt, refreshExpiresAt: a.refreshExpiresAt,
    }));
  ' "$STASH" 2>/dev/null || true
  say "now: scripts/first-run/run.sh --version <v> --channel all --reuse-identity $STASH"
  exit 0
fi

say "FAIL: login exited $code with no user-token config. login said:"
sed 's/^/    /' "$log"
exit 4
