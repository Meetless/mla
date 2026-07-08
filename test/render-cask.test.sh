#!/usr/bin/env bash
# Hermetic test for homebrew/render-cask.sh. No network, no brew, no real release.
# We seed a fake release dir with .sha256 sidecars (in install.sh's exact
# "<hex>  <filename>" format) and assert the rendered cask Ruby is correct.
#
# Run:  bash test/render-cask.test.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/../homebrew/render-cask.sh"

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  PASS: %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL: %s :: %s\n' "$1" "$2"; }

# 64-char hex shas, distinct per arch so we can prove each lands in the right block
ARM="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
INTEL="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

new_release_dir() {  # populate $REL with valid sidecars
  REL="$(mktemp -d)"
  printf '%s  mla-aarch64-apple-darwin.tar.gz\n' "$ARM"   > "$REL/mla-aarch64-apple-darwin.tar.gz.sha256"
  printf '%s  mla-x86_64-apple-darwin.tar.gz\n'  "$INTEL" > "$REL/mla-x86_64-apple-darwin.tar.gz.sha256"
}
cleanup() { [ -n "${REL:-}" ] && rm -rf "$REL"; }

printf 'render-cask.sh test suite\n'
[ -f "$SCRIPT" ] || { printf 'FATAL: %s not found\n' "$SCRIPT"; exit 1; }

# --- happy path: version normalized, both shas placed, url pattern correct -----
new_release_dir
OUT="$(bash "$SCRIPT" v0.4.2 "$REL" 2>/tmp/rc.err)"; RC=$?
if [ "$RC" -eq 0 ] \
   && printf '%s' "$OUT" | grep -Eq '^  version "0\.4\.2"$' \
   && printf '%s' "$OUT" | grep -q "sha256 \"$ARM\"" \
   && printf '%s' "$OUT" | grep -q "sha256 \"$INTEL\"" \
   && printf '%s' "$OUT" | grep -Fq 'arch arm: "aarch64-apple-darwin", intel: "x86_64-apple-darwin"' \
   && printf '%s' "$OUT" | grep -Fq 'url "https://storage.googleapis.com/meetless-public/cli/releases/download/v#{version}/mla-#{arch}.tar.gz"' \
   && printf '%s' "$OUT" | grep -Fq 'binary "mla"' \
   && printf '%s' "$OUT" | grep -Fq 'cask "mla" do'; then
  ok "renders dual-arch cask: bare version, per-arch shas, install.sh-identical url"
else
  bad "happy path" "rc=$RC err=$(cat /tmp/rc.err) out=$OUT"
fi
cleanup

# --- each sha lands under the right on_<arch> block (no cross-wiring) ----------
new_release_dir
OUT="$(bash "$SCRIPT" 0.4.2 "$REL" 2>/dev/null)"
arm_block="$(printf '%s' "$OUT" | awk '/on_arm do/{f=1} f{print} /end/{if(f)exit}')"
intel_block="$(printf '%s' "$OUT" | awk '/on_intel do/{f=1} f{print} /end/{if(f)exit}')"
if printf '%s' "$arm_block" | grep -q "$ARM" \
   && ! printf '%s' "$arm_block" | grep -q "$INTEL" \
   && printf '%s' "$intel_block" | grep -q "$INTEL" \
   && ! printf '%s' "$intel_block" | grep -q "$ARM"; then
  ok "arm sha is in on_arm, intel sha is in on_intel (no swap)"
else
  bad "arch block wiring" "arm_block=$arm_block intel_block=$intel_block"
fi
cleanup

# --- download-base override flows into the url (and stays lockstep w/ install.sh)
new_release_dir
OUT="$(MLA_DOWNLOAD_URL="https://dl.meetless.ai/cli/releases" bash "$SCRIPT" 1.0.0 "$REL" 2>/dev/null)"
if printf '%s' "$OUT" | grep -Fq 'url "https://dl.meetless.ai/cli/releases/download/v#{version}/mla-#{arch}.tar.gz"'; then
  ok "MLA_DOWNLOAD_URL overrides the download base in the url"
else
  bad "download-base override" "out=$OUT"
fi
cleanup

# --- missing INTEL sidecar degrades to an arm-only cask (matrix dropped x64) ---
# The release matrix currently ships only macos-arm64, so the Intel sidecar is
# legitimately absent. The renderer must emit a valid arm-only cask (not abort
# the whole release) that matches what install.sh can actually resolve.
REL="$(mktemp -d)"
printf '%s  mla-aarch64-apple-darwin.tar.gz\n' "$ARM" > "$REL/mla-aarch64-apple-darwin.tar.gz.sha256"
# intentionally omit the intel sidecar
OUT="$(bash "$SCRIPT" 0.4.2 "$REL" 2>/tmp/rc.err)"; RC=$?
if [ "$RC" -eq 0 ] \
   && printf '%s' "$OUT" | grep -q "sha256 \"$ARM\"" \
   && printf '%s' "$OUT" | grep -Fq 'depends_on arch: :arm64' \
   && printf '%s' "$OUT" | grep -Fq 'url "https://storage.googleapis.com/meetless-public/cli/releases/download/v#{version}/mla-aarch64-apple-darwin.tar.gz"' \
   && ! printf '%s' "$OUT" | grep -q 'on_intel' \
   && ! printf '%s' "$OUT" | grep -Fq 'arch arm:'; then
  ok "missing Intel sidecar renders an arm-only cask (no on_intel, no arch stanza)"
else
  bad "intel-absent arm-only cask" "rc=$RC err=$(cat /tmp/rc.err) out=$OUT"
fi
cleanup

# --- missing ARM sidecar is STILL fatal (arm is the shipped arch) -------------
REL="$(mktemp -d)"
printf '%s  mla-x86_64-apple-darwin.tar.gz\n' "$INTEL" > "$REL/mla-x86_64-apple-darwin.tar.gz.sha256"
# intentionally omit the arm sidecar
OUT="$(bash "$SCRIPT" 0.4.2 "$REL" 2>/tmp/rc.err)"; RC=$?
if [ "$RC" -ne 0 ] && grep -Fq 'missing checksum' /tmp/rc.err; then
  ok "missing arm checksum aborts the render (the shipped arch is required)"
else
  bad "missing arm sidecar" "rc=$RC err=$(cat /tmp/rc.err)"
fi
cleanup

# --- malformed sha (not 64 hex) is rejected ----------------------------------
REL="$(mktemp -d)"
printf 'not-a-real-sha  mla-aarch64-apple-darwin.tar.gz\n' > "$REL/mla-aarch64-apple-darwin.tar.gz.sha256"
printf '%s  mla-x86_64-apple-darwin.tar.gz\n' "$INTEL"     > "$REL/mla-x86_64-apple-darwin.tar.gz.sha256"
OUT="$(bash "$SCRIPT" 0.4.2 "$REL" 2>/tmp/rc.err)"; RC=$?
if [ "$RC" -ne 0 ] && grep -Fq '64-char sha256' /tmp/rc.err; then
  ok "malformed sha256 sidecar is rejected, not passed through to the cask"
else
  bad "malformed sha" "rc=$RC err=$(cat /tmp/rc.err)"
fi
cleanup

# --- missing args -> usage error ---------------------------------------------
OUT="$(bash "$SCRIPT" 2>/tmp/rc.err)"; RC=$?
if [ "$RC" -ne 0 ] && grep -Fq 'usage' /tmp/rc.err; then
  ok "no args prints usage and exits non-zero"
else
  bad "usage" "rc=$RC err=$(cat /tmp/rc.err)"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
