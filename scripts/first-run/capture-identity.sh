#!/usr/bin/env bash
# Capture ONE prod user-token identity with a PUBLISHED mla binary, and stash it
# for `run.sh --reuse-identity`.
#
# WHY THIS EXISTS
# ---------------
# `/cli/authorize` mints nothing without a real human click. That is deliberate:
# the page is a top-level form POST behind a console session, so the browser can
# follow the 303 to the CLI's loopback listener as a full navigation. No fetch,
# no headless shortcut, no server-side synthesis. See apps/console/app/cli/authorize.
#
# `mla login` gives that human a hard 5-minute window, and run.sh aborts the whole
# channel on a nonzero login. Together those mean Phase 5c fails outright whenever
# the operator is not sitting at the keyboard in the right 5 minutes. On 0.2.31 it
# did exactly that: 10 of 14 checks passed and the 4 failures were all one missing
# click, twice.
#
# This decouples the two. It runs the real login with a FIXED loopback port, places
# the URL in ONE pinned tab of the operator's own session-bearing Chrome, and
# re-mints before each window expires. The port never changes, so the tab stays
# valid; only `state` and `code_challenge` rotate. The operator clicks whenever they
# get back, and it works.
#
# The identity it stashes is reusable, so the click is ONE TIME rather than per run:
#   scripts/first-run/capture-identity.sh <mla-bin> <out.json>
#   scripts/first-run/run.sh --version <v> --channel all --reuse-identity <out.json>
#
# A release gate should still exercise the browser login itself at least once (that
# is what this script does, with the shipped binary, against prod). What it removes
# is re-doing it for every iteration of the activate to teardown lane.
#
# macOS + Chrome only. Everywhere else it degrades to printing the URL each attempt.
set -uo pipefail

BIN="${1:?usage: capture-identity.sh <mla-bin> <out-cli-config.json> [max-minutes]}"
STASH="${2:?usage: capture-identity.sh <mla-bin> <out-cli-config.json> [max-minutes]}"
MAXMIN="${3:-30}"
PORT="${MLA_CAPTURE_PORT:-52170}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIN="$HERE/pin-authorize-tab.applescript"
SBX="${MLA_CAPTURE_SBX:-${TMPDIR:-/tmp}/mla-capture-identity.$$}"

say() { printf 'capture: %s\n' "$*"; }

[ -x "$BIN" ] || { say "FAIL: not executable: $BIN"; exit 2; }
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  say "FAIL: port $PORT already has a listener; set MLA_CAPTURE_PORT to a free one"
  exit 2
fi

mkdir -p "$SBX" "$(dirname "$STASH")" || exit 2
say "binary:   $BIN"
say "version:  $("$BIN" --version 2>&1 | head -1)"
say "port:     $PORT (fixed, so one pinned tab stays valid across attempts)"
say "deadline: ${MAXMIN}m"

deadline=$(( $(date +%s) + MAXMIN * 60 ))
attempt=0

while [ "$(date +%s)" -lt "$deadline" ]; do
  attempt=$((attempt + 1))
  RUN="$SBX/attempt-$attempt"
  rm -rf "$RUN"
  mkdir -p "$RUN/home" "$RUN/meetless" "$RUN/tmp"
  log="$RUN/login.log"

  # env -u MEETLESS_CONTROL_TOKEN: a shared-key credential in the environment is a
  # HARD ERROR once the config is user-token, and would poison the capture.
  env -u MEETLESS_CONTROL_TOKEN \
    HOME="$RUN/home" MEETLESS_HOME="$RUN/meetless" \
    TMPDIR="$RUN/tmp" TMP="$RUN/tmp" TEMP="$RUN/tmp" \
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
    say "attempt $attempt: no authorize URL was printed; login said:"
    sed 's/^/    /' "$log"
    wait "$pid" 2>/dev/null
    say "giving up: this is a login failure, not a missing click"
    exit 3
  fi

  # Chrome can be mid-something and refuse a single Apple event; retry before
  # declaring the browser undrivable, and never swallow the reason.
  pinned=0
  if [ "$(uname -s)" = "Darwin" ] && [ -f "$PIN" ]; then
    for try in 1 2 3; do
      if [ "$attempt" -eq 1 ] && [ "$try" -eq 1 ]; then
        osascript "$PIN" "$url" activate >/dev/null 2>"$RUN/osascript.err"
      else
        osascript "$PIN" "$url" >/dev/null 2>"$RUN/osascript.err"
      fi
      if [ $? -eq 0 ]; then pinned=1; break; fi
      say "attempt $attempt: pin try $try failed: $(tr -d '\n' < "$RUN/osascript.err")"
      sleep 1
    done
  fi
  if [ "$pinned" -eq 1 ]; then
    say "attempt $attempt: pinned ONE authorize tab in Chrome; click Authorize any time"
  else
    say "attempt $attempt: open this and click Authorize any time: $url"
  fi

  wait "$pid"
  code=$?

  cfg="$RUN/meetless/cli-config.json"
  if [ "$code" -eq 0 ] && grep -q '"user-token"' "$cfg" 2>/dev/null; then
    cp "$cfg" "$STASH"
    chmod 600 "$STASH"
    say "CAPTURED on attempt $attempt -> $STASH"
    node -e '
      const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const a = j.auth || {};
      console.log("capture: identity ->", JSON.stringify({
        controlUrl: j.controlUrl, consoleUrl: j.consoleUrl, mode: a.mode,
        user: a.user && a.user.email, role: a.user && a.user.role,
        accessExpiresAt: a.accessExpiresAt, refreshExpiresAt: a.refreshExpiresAt,
      }));
    ' "$STASH" 2>/dev/null || true
    say "now: scripts/first-run/run.sh --version <v> --channel all --reuse-identity $STASH"
    exit 0
  fi

  say "attempt $attempt: window expired unclicked (exit $code); re-minting"
done

say "deadline reached with no click; nothing captured"
exit 1
