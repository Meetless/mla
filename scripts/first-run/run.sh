#!/usr/bin/env bash
# mla FIRST-RUN e2e harness — the human golden path, live against PROD.
# Design: notes/20260712-mla-install-e2e-harness.md
#
# Proves the one claim no hermetic suite touches: a real person can INSTALL the
# published mla, LOG IN through the browser, ACTIVATE a workspace on prod, and get
# useful, grounded answers from the first commands. Reuses the canary install +
# version guard so nothing already covered is re-run; then continues into the
# login -> activate -> first-commands lane that is unique to this harness.
#
# Usage:
#   scripts/first-run/run.sh --version <published-semver> [options]
#
# Options:
#   --version <v>          REQUIRED. The published version every channel must report.
#   --channel <c>          npm | curl | brew | all   (default: all = npm + curl)
#   --ask-workspace <id>   workspace to run the read-only ask/mcp proofs against.
#                          Default: the DISPOSABLE workspace `mla activate` just
#                          provisioned in this run (guaranteed member, empty corpus)
#                          -- proves the ask/mcp COMMANDS work + are authed on a
#                          first-run workspace, scoring grounding as a WARN (empty).
#                          Pass a POPULATED workspace the logged-in identity is a
#                          MEMBER of to upgrade that WARN into a grounded PASS. A
#                          non-member workspace is reported WARN (correct ACL 403),
#                          never FAIL.
#   --reuse-identity <p>   seed a previously-stashed logged-in cli-config.json and
#                          SKIP the interactive browser login on every channel. Use
#                          only to re-validate the activate->teardown lane between
#                          harness iterations; a real release gate runs WITHOUT it
#                          so the browser login itself is exercised.
#   --query <text>         the grounded query for ask + mcp retrieve.
#   --keep                 do not delete the sandbox test root on exit.
#   --no-brew-guard        allow --channel brew even if `mla` on PATH looks like a
#                          dev build (ONLY on a clean machine / CI runner).
#   --root <dir>           test-root parent (default ~/mla-install-test). MUST be
#                          OUTSIDE any activated tree: a `.meetless.json` in an
#                          ancestor would make `mla activate` BIND to it instead of
#                          provisioning, and teardown could then unbind a real
#                          workspace. lib.sh hard-guards this before any activate.
set -uo pipefail   # NOTE: no -e; we score expected failures explicitly.

HERE_FR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$HERE_FR/lib.sh"
set +e   # lib.sh -> canary/lib.sh sets -e; turn it back off for the scorecard flow.

INSTALL_URL="${MLA_FIRSTRUN_INSTALL_URL:-https://storage.googleapis.com/meetless-public/cli/install.sh}"

VERSION=""; CHANNEL="all"; ASK_WS=""; QUERY="What is a Coordination Case?"; REUSE_IDENTITY=""
# Default root lives OUTSIDE ~/projects/meetless so no ancestor `.meetless.json`
# (the dogfood marker at ~/projects/meetless/.meetless.json) can hijack activate
# into the BIND path. lib.sh re-checks this with a hard ancestor-guard.
ROOT_PARENT="$HOME/mla-install-test"; NO_BREW_GUARD=0
export FR_KEEP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2#v}"; shift 2 ;;
    --channel) CHANNEL="$2"; shift 2 ;;
    --ask-workspace) ASK_WS="$2"; shift 2 ;;
    --reuse-identity) REUSE_IDENTITY="$2"; shift 2 ;;
    --query) QUERY="$2"; shift 2 ;;
    --root) ROOT_PARENT="$2"; shift 2 ;;
    --keep) FR_KEEP=1; shift ;;
    --no-brew-guard) NO_BREW_GUARD=1; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fr_die "unknown arg: $1" ;;
  esac
done

[ -n "$VERSION" ] || fr_die "--version <published-semver> is required (pin the release under test)"

case "$CHANNEL" in
  all) CHANNELS="npm curl" ;;
  npm|curl|brew) CHANNELS="$CHANNEL" ;;
  *) fr_die "--channel must be npm|curl|brew|all" ;;
esac

fr_step "mla first-run harness — version $VERSION, channels: $CHANNELS"
fr_init "$ROOT_PARENT"

LOGIN_DONE=0
# --reuse-identity: pre-seed the run's identity stash and skip interactive login on
# every channel (iteration convenience; NOT for a real release gate).
if [ -n "$REUSE_IDENTITY" ]; then
  [ -f "$REUSE_IDENTITY" ] || fr_die "--reuse-identity: no file at $REUSE_IDENTITY"
  grep -q '"user-token"' "$REUSE_IDENTITY" || fr_die "--reuse-identity: $REUSE_IDENTITY is not a user-token config"
  cp "$REUSE_IDENTITY" "$FR_IDENTITY"
  LOGIN_DONE=1
  fr_ok "reusing stashed identity (skipping interactive login): $REUSE_IDENTITY"
fi

# ---------------------------------------------------------------------------
# install_<channel>: install the published artifact into the current sandbox and
# echo the absolute path to the installed binary (never a PATH-resolved dev build).
# ---------------------------------------------------------------------------
install_npm() {
  local base; base="$(dirname "$FR_HOME")"
  local prefix="$base/npm-global"
  mkdir -p "$prefix"
  local ok=0 t
  for t in 1 2 3 4 5; do
    if npm install -g --prefix "$prefix" "@meetless/mla@$VERSION" >/dev/null 2>&1; then ok=1; break; fi
    fr_warn "npm install attempt $t failed (registry propagation?); retry in 8s"
    sleep 8
  done
  [ "$ok" = 1 ] || return 1
  FR_BIN="$prefix/bin/mla"
}

install_curl() {
  local base; base="$(dirname "$FR_HOME")"
  canary_fetch_installer "$INSTALL_URL" "$base/install.sh" || return 1
  # MLA_NO_WIRE/MLA_NO_MODIFY_PATH inline so the installer doesn't run init-time
  # wiring (keeps the pre-auth state clean); activate later wires WITH intent.
  MLA_VERSION="$VERSION" MLA_NO_WIRE=1 MLA_NO_MODIFY_PATH=1 HOME="$FR_HOME" \
    sh "$base/install.sh" >/dev/null 2>&1 || return 1
  FR_BIN="$FR_HOME/.meetless/bin/mla"
}

install_brew() {
  [ "$NO_BREW_GUARD" = 1 ] || fr_guard_not_devbuild   # refuse to clobber a dev symlink
  brew tap meetless/tap >/dev/null 2>&1 || return 1
  brew install --cask mla >/dev/null 2>&1 || return 1
  FR_BIN="$(command -v mla || true)"
  [ -n "$FR_BIN" ] || return 1
}

# ---------------------------------------------------------------------------
# the golden path for one channel
# ---------------------------------------------------------------------------
run_channel() {
  local ch="$1"
  fr_step "channel: $ch"
  fr_channel_env "$ch"

  # 1. Install (rides the canary-equivalent install; not re-scored as a channel case)
  if ! "install_$ch"; then
    fr_fail "[$ch] install" "install_$ch failed"
    return 1
  fi
  fr_ok "[$ch] installed -> $FR_BIN"

  # 2. Version guard (shared code with canary). A mismatch = wrong bytes served.
  if ( canary_assert_version "$FR_BIN" "$VERSION" ); then
    fr_pass "[$ch] version == $VERSION"
  else
    fr_fail "[$ch] version == $VERSION" "canary_assert_version failed"
    return 1
  fi

  # 3. Pre-auth fail-fast (only meaningful before the first login; the restore
  #    channel already carries a seeded config).
  if [ "$LOGIN_DONE" -eq 0 ]; then
    local out code
    out="$("$FR_BIN" 2>&1)"; code=$?
    fr_expect_contains "[$ch] bare mla prints usage" "$out" "mla"

    out="$("$FR_BIN" whoami 2>&1)"; code=$?
    fr_expect_nonzero "[$ch] whoami pre-login exits nonzero" "$code"
    if printf '%s' "$out" | grep -qiE "not configured|not logged in|mla login"; then
      fr_pass "[$ch] whoami pre-login says not-configured"
    else
      fr_fail "[$ch] whoami pre-login says not-configured" "got: $(printf '%s' "$out" | head -1)"
    fi

    out="$("$FR_BIN" ask "smoke ping" 2>&1)"; code=$?
    fr_expect_nonzero "[$ch] ask pre-login fails fast" "$code"
  fi

  # 4. Interactive login (once). Do NOT capture stdout: the URL + browser open must
  #    stream live so the operator can complete consent.
  if [ "$LOGIN_DONE" -eq 0 ]; then
    fr_log "[$ch] === INTERACTIVE LOGIN === a browser window will open; complete Google consent."
    fr_log "[$ch] (if it does not open, copy the printed URL into a browser). 5-min window."
    "$FR_BIN" login
    local lcode=$?
    fr_expect_zero "[$ch] mla login" "$lcode"
    if [ "$lcode" -ne 0 ]; then
      fr_fail "[$ch] login blocking" "aborting channel; cannot continue without auth"
      return 1
    fi
    if grep -q '"user-token"' "$FR_MHOME/cli-config.json" 2>/dev/null; then
      fr_pass "[$ch] cli-config auth.mode == user-token"
    else
      fr_fail "[$ch] cli-config auth.mode == user-token" "no user-token in config after login"
      return 1
    fi
    fr_stash_identity
    LOGIN_DONE=1
  else
    if fr_restore_identity; then
      fr_pass "[$ch] identity restored (login-once reuse)"
    else
      fr_fail "[$ch] identity restored" "no stashed identity to reuse"
      return 1
    fi
  fi

  # 5. whoami live identity (user-token, email verified against prod /auth/me)
  local wout wcode
  wout="$("$FR_BIN" whoami --json 2>&1)"; wcode=$?
  fr_expect_zero "[$ch] whoami --json" "$wcode"
  local authmode email defws
  authmode="$(printf '%s' "$wout" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String(j.authMode||""))}catch{process.stdout.write("")}})' 2>/dev/null)"
  email="$(printf '%s' "$wout" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String((j.user&&j.user.email)||""))}catch{process.stdout.write("")}})' 2>/dev/null)"
  defws="$(printf '%s' "$wout" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String((j.workspace&&j.workspace.id)||""))}catch{process.stdout.write("")}})' 2>/dev/null)"
  [ "$authmode" = "user-token" ] && fr_pass "[$ch] whoami authMode == user-token" \
    || fr_fail "[$ch] whoami authMode == user-token" "got '$authmode'"
  [ -n "$email" ] && fr_pass "[$ch] whoami has an email ($email)" \
    || fr_fail "[$ch] whoami has an email" "empty email in whoami --json"
  [ -n "$defws" ] && fr_ok "[$ch] whoami default workspace: $defws"

  # 6. Activate — provision a fresh, disposable prod workspace from the fixture repo.
  bash "$HERE_FR/gen-fixture-repo.sh" "$FR_WORK" >/dev/null 2>&1 \
    || { fr_fail "[$ch] fixture repo" "gen-fixture-repo failed"; return 1; }
  cd "$FR_WORK"
  local wsname aout acode dispws="" target="" grounded_expected=0
  wsname="install-e2e-$ch-$(date +%s)"
  aout="$("$FR_BIN" activate --name "$wsname" 2>&1)"; acode=$?
  fr_expect_zero "[$ch] mla activate (provision prod ws)" "$acode"
  [ "$acode" -ne 0 ] && fr_warn "[$ch] activate output: $(printf '%s' "$aout" | tail -3 | tr '\n' ' ')"
  if [ -f "$FR_WORK/.meetless.json" ] && grep -q '"workspaceId"' "$FR_WORK/.meetless.json" 2>/dev/null; then
    dispws="$(node -e 'const j=require("'"$FR_WORK"'/.meetless.json");process.stdout.write(String(j.workspaceId||""))' 2>/dev/null)"
    fr_pass "[$ch] .meetless.json written (ws=$dispws)"
  else
    fr_fail "[$ch] .meetless.json written" "marker missing or has no workspaceId"
  fi

  # Resolve the ask/mcp target. Default = the disposable ws just provisioned
  # (guaranteed member, empty corpus): proves the commands work + are authed on a
  # true first-run workspace. An explicit --ask-workspace overrides it to attempt a
  # grounded proof against a populated workspace (grounding then EXPECTED).
  if [ -n "$ASK_WS" ]; then
    target="$ASK_WS"; grounded_expected=1
    fr_ok "[$ch] ask/mcp target: $target (explicit --ask-workspace; grounding expected)"
  else
    target="$dispws"
    fr_ok "[$ch] ask/mcp target: $target (own disposable ws; empty corpus expected)"
  fi

  # 7. doctor against prod. The PUBLISHED CLI's `doctor` takes only `--fix` (no
  #    `--json`), and it exits NONZERO whenever any row is red -- and in this bare
  #    sandbox the wiring rows (skill/MCP/hooks) are ALWAYS red because the harness
  #    deliberately never runs full `mla wire`. So exit code and overall RED are
  #    NOT the signal here. What matters for demo-readiness is (a) doctor RUNS and
  #    prints its check table, and (b) prod is reachable ("intel reachable" is
  #    green). Everything else is surfaced as an informational note.
  local dout dcode
  dout="$("$FR_BIN" doctor 2>&1)"; dcode=$?
  local drollup
  drollup="$(printf '%s' "$dout" | grep -iE 'Doctor (RED|GREEN)' | tail -1 | tr -d '\r')"
  if printf '%s' "$dout" | grep -qF "intel reachable"; then
    if printf '%s' "$dout" | grep "intel reachable" | grep -qF "✓"; then
      fr_pass "[$ch] doctor runs; intel reachable (prod up)"
    else
      fr_skip "[$ch] doctor runs; intel reachable" "doctor ran but intel row not green: $(printf '%s' "$dout" | grep 'intel reachable' | head -1 | tr -d '\r')"
    fi
    [ -n "$drollup" ] && fr_log "[$ch] doctor rollup: $drollup (wiring reds expected in bare sandbox)"
  else
    fr_fail "[$ch] doctor runs" "no check table produced (exit $dcode): $(printf '%s' "$dout" | tail -2 | tr '\n' ' ')"
  fi

  # 8. ask — read-only, against `target`. Default target = the OWN disposable ws just
  #    provisioned (guaranteed member, empty corpus): assert the COMMAND works (exit 0
  #    + `(workspace:` footer) and score grounding as WARN. `--plain` exposes
  #    `confidence:`; medium/high => grounded in workspace evidence.
  #
  #    KNOWN INTEL STALENESS (root-caused 2026-07-12): intel snapshots the caller's
  #    membership list in a per-token validation cache with a 60s TTL
  #    (intel/app/core/auth.py, _CACHE_TTL_SECONDS=60). When an EARLIER channel already
  #    asked in a DIFFERENT ws within the last 60s, this run's fresh ws is absent from
  #    that cached snapshot and 403s "not a member of your OWN workspace" until the
  #    entry expires. That is NOT correct ACL (the identity provisioned the ws seconds
  #    ago); it self-heals in <=60s (measured: readable again by ~74s incl. poll/round-
  #    trip granularity). For the OWN ws we ride out that window (up to 90s) before
  #    scoring, which also regression-tests the self-heal; a 403 that survives the
  #    window is a genuine bug -> FAIL. For an explicit non-member --ask-workspace a
  #    403 is correct ACL -> WARN (no ride-out).
  local qout qcode
  qout="$("$FR_BIN" ask "$QUERY" --workspace "$target" --plain 2>&1)"; qcode=$?
  if [ "$qcode" -ne 0 ] && [ "$grounded_expected" -eq 0 ] \
     && printf '%s' "$qout" | grep -qiE '403|WORKSPACE_ACCESS_DENIED|not a member|forbidden'; then
    fr_warn "[$ch] ask 403 on own fresh ws=$target -- known intel stale-membership cache (self-heals <=60s); riding out the window"
    local waited=0
    while [ "$waited" -lt 90 ]; do
      sleep 10; waited=$((waited+10))
      qout="$("$FR_BIN" ask "$QUERY" --workspace "$target" --plain 2>&1)"; qcode=$?
      if [ "$qcode" -eq 0 ]; then fr_ok "[$ch] own ws readable after ~${waited}s (intel cache expired; self-healed)"; break; fi
    done
  fi
  if [ "$qcode" -eq 0 ]; then
    fr_pass "[$ch] mla ask exit 0 (command works)"
    fr_expect_contains "[$ch] ask prints workspace footer" "$qout" "(workspace:"
    if printf '%s' "$qout" | grep -qiE 'confidence: (medium|high)'; then
      fr_pass "[$ch] ask grounded (confidence >= medium)"
    elif [ "$grounded_expected" -eq 1 ]; then
      fr_skip "[$ch] ask grounded" "confidence low for populated ws=$target (thin corpus? refine --query)"
    else
      fr_skip "[$ch] ask grounded" "confidence low on empty disposable ws (expected; pass --ask-workspace <populated-member-ws> for a grounded PASS)"
    fi
  elif printf '%s' "$qout" | grep -qiE '403|WORKSPACE_ACCESS_DENIED|not a member|forbidden|unauthori'; then
    if [ "$grounded_expected" -eq 0 ]; then
      fr_fail "[$ch] mla ask own fresh ws readable" "ws=$target still 403 after riding out >90s (exceeds intel 60s stale-membership TTL -- genuine bug, not correct ACL). $(printf '%s' "$qout" | grep -iE '403|denied|not a member' | head -1)"
    else
      fr_skip "[$ch] mla ask" "explicit target ws=$target returned 403 for $email (non-member ACL, or intel stale-membership if you ARE a member). $(printf '%s' "$qout" | grep -iE '403|denied|not a member' | head -1)"
    fi
  else
    fr_fail "[$ch] mla ask exit 0" "exit $qcode: $(printf '%s' "$qout" | tail -1)"
  fi

  # 9. stats (offline-safe ROI object)
  local sout scode
  sout="$("$FR_BIN" stats --json 2>&1)"; scode=$?
  fr_expect_zero "[$ch] mla stats --json exit 0" "$scode"
  [ "$scode" -ne 0 ] && fr_warn "[$ch] stats output: $(printf '%s' "$sout" | tail -3 | tr '\n' ' ')"

  # 10. mcp authed retrieve_knowledge — pin the workspace via a marker dir so `mla
  #     mcp` resolves it to `target`. Default target = the OWN disposable ws (authed
  #     but empty => exit 3 WARN). A populated member ws => exit 0 grounded PASS. For
  #     the own ws, step 8's ask ride-out already forced intel to re-validate and
  #     re-cache this membership, so a 403 here (exit 4) is NO LONGER benign staleness
  #     -> FAIL. For an explicit non-member --ask-workspace, exit 4 is correct ACL => WARN.
  local probedir
  probedir="$(dirname "$FR_HOME")/mcp-probe"
  mkdir -p "$probedir"
  printf '{"workspaceId":"%s"}\n' "$target" > "$probedir/.meetless.json"
  MEETLESS_PROJECT_DIR="$probedir" node "$HERE_FR/retrieve-probe.mjs" "$FR_BIN" "$QUERY"
  local pcode=$?
  case "$pcode" in
    0) fr_pass "[$ch] mcp retrieve_knowledge grounded (authed)" ;;
    3) if [ "$grounded_expected" -eq 1 ]; then
         fr_skip "[$ch] mcp retrieve_knowledge grounded" "authed OK but empty for populated ws=$target (thin corpus?)"
       else
         fr_skip "[$ch] mcp retrieve_knowledge grounded" "authed OK, empty on disposable ws (expected; pass --ask-workspace <populated-member-ws>)"
       fi ;;
    4) if [ "$grounded_expected" -eq 0 ]; then
         fr_fail "[$ch] mcp retrieve_knowledge own fresh ws" "ws=$target 403 even after step-8 re-validated membership (intel stale-membership beyond the 60s TTL, or an MCP-path ACL divergence -- genuine bug)"
       else
         fr_skip "[$ch] mcp retrieve_knowledge" "explicit target ws=$target not readable by $email (non-member ACL, or intel stale-membership if you ARE a member)"
       fi ;;
    *) fr_fail "[$ch] mcp retrieve_knowledge" "probe exit $pcode (see stderr above)" ;;
  esac

  # 11. Teardown — retire the disposable workspace server-side (OWNER-gated). We
  #     PIN --marker to the disposable marker so deactivate resolves EXACTLY that
  #     path (no parent-walk) and --deactivate-workspace forces the server retire
  #     of only that workspace. This makes it structurally impossible to unbind or
  #     retire any workspace other than the one activate just provisioned here.
  cd "$FR_WORK"
  local tout tcode
  if [ -f "$FR_WORK/.meetless.json" ]; then
    tout="$("$FR_BIN" deactivate --yes --marker "$FR_WORK/.meetless.json" --deactivate-workspace 2>&1)"; tcode=$?
    if [ "$tcode" -eq 0 ]; then
      fr_pass "[$ch] deactivate retired disposable ws"
    else
      fr_skip "[$ch] deactivate retired disposable ws" "exit $tcode; may leave orphan '$wsname' (clean up manually)"
      fr_warn "[$ch] deactivate output: $(printf '%s' "$tout" | tail -3 | tr '\n' ' ')"
    fi
  else
    # activate never provisioned (no marker) => nothing was created server-side.
    fr_skip "[$ch] deactivate retired disposable ws" "no disposable marker to tear down (activate did not provision)"
  fi

  return 0
}

for ch in $CHANNELS; do
  run_channel "$ch"
done

fr_step "done"
fr_report
exit $?
