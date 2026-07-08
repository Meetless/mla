#!/usr/bin/env bash
# Hermetic test for scripts/build-release.sh.
#
# We stub the two things that need a real toolchain or a real Mach-O binary:
#   pkg      -> writes a fake executable to --output (no node base download)
#   codesign -> records that ad-hoc signing happened (a shell stub is not Mach-O)
# Everything else (target mapping, archive layout, the archive-root gate, the
# per-asset sha256 in the exact format install.sh consumes) runs for real.
#
# Run:  bash test/build-release.test.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/../scripts/build-release.sh"

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  PASS: %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL: %s :: %s\n' "$1" "$2"; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

new_sandbox() {
  SBX="$(mktemp -d)"
  CLI="$SBX/packages/cli"; REL="$SBX/release"; STUB="$SBX/stub"
  mkdir -p "$CLI/dist" "$STUB"
  printf '#!/usr/bin/env node\nconsole.log("hi");\n' > "$CLI/dist/cli.js"
  printf '{"name":"@meetless/mla","version":"9.9.9","bin":{"mla":"dist/cli.js"}}\n' > "$CLI/package.json"

  # stub pkg: find --output, write a runnable fake binary there
  cat > "$STUB/pkg" <<'EOF'
#!/bin/sh
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --output) shift; out="$1" ;;
    --output=*) out="${1#--output=}" ;;
  esac
  shift
done
[ -n "$out" ] || { echo "stub pkg: no --output" >&2; exit 3; }
printf '#!/bin/sh\necho "mla 9.9.9 (stub)"\n' > "$out"
chmod +x "$out"
EOF
  chmod +x "$STUB/pkg"

  # stub codesign: -dv reports adhoc; signing run drops a marker
  cat > "$STUB/codesign" <<EOF
#!/bin/sh
if [ "\$1" = "-dv" ]; then echo "Signature=adhoc" >&2; exit 0; fi
echo "signed" >> "$SBX/codesign.calls"
exit 0
EOF
  chmod +x "$STUB/codesign"
}

run_build() {  # $1=platform-key ; extra env via remaining args
  key="$1"; shift
  OUT="$SBX/out.txt"
  env \
    MLA_CLI_DIR="$CLI" \
    MLA_RELEASE_DIR="$REL" \
    MLA_SKIP_BUILD=1 \
    MLA_PKG_BIN="$STUB/pkg" \
    MLA_CODESIGN="$STUB/codesign" \
    "$@" \
    bash "$SCRIPT" "$key" > "$OUT" 2>&1
  RC=$?
}

cleanup() { [ -n "${SBX:-}" ] && rm -rf "$SBX"; }

# checksum file matches install.sh contract: field 1 == real sha, name == archive
checksum_valid() {  # $1=archive-path
  local arch="$1" sumfile="$1.sha256"
  [ -f "$sumfile" ] || return 1
  local want got
  want="$(cut -d' ' -f1 < "$sumfile")"
  got="$(sha256_of "$arch")"
  [ "$want" = "$got" ]
}

printf 'build-release.sh test suite\n'
[ -f "$SCRIPT" ] || { printf 'FATAL: %s not found\n' "$SCRIPT"; exit 1; }

# --- macos-arm64: signs, names aarch64-apple-darwin -------------------------
new_sandbox
run_build macos-arm64
A="$REL/mla-aarch64-apple-darwin.tar.gz"
if [ "$RC" -eq 0 ] && [ -f "$A" ] && checksum_valid "$A" \
   && tar -tzf "$A" | grep -qx 'mla' \
   && [ -f "$SBX/codesign.calls" ]; then
  ok "macos-arm64 builds, ad-hoc signs, archives exec-at-root + valid sha256"
else
  bad "macos-arm64" "rc=$RC out=$(cat "$OUT")"
fi
cleanup

# --- macos-x64: signs, names x86_64-apple-darwin ----------------------------
new_sandbox
run_build macos-x64
A="$REL/mla-x86_64-apple-darwin.tar.gz"
if [ "$RC" -eq 0 ] && [ -f "$A" ] && checksum_valid "$A" \
   && tar -tzf "$A" | grep -qx 'mla' && [ -f "$SBX/codesign.calls" ]; then
  ok "macos-x64 maps to x86_64-apple-darwin and signs"
else
  bad "macos-x64" "rc=$RC out=$(cat "$OUT")"
fi
cleanup

# --- linux-x64: NO signing, names x86_64-unknown-linux-gnu ------------------
new_sandbox
run_build linux-x64
A="$REL/mla-x86_64-unknown-linux-gnu.tar.gz"
if [ "$RC" -eq 0 ] && [ -f "$A" ] && checksum_valid "$A" \
   && tar -tzf "$A" | grep -qx 'mla' && [ ! -f "$SBX/codesign.calls" ]; then
  ok "linux-x64 maps to gnu triple and does NOT sign"
else
  bad "linux-x64" "rc=$RC out=$(cat "$OUT") signed=$([ -f "$SBX/codesign.calls" ] && echo yes || echo no)"
fi
cleanup

# --- unknown platform key -> clear error ------------------------------------
new_sandbox
run_build win-x64
if [ "$RC" -ne 0 ] && grep -Fq 'unknown platform' "$OUT"; then
  ok "unknown/Windows platform key is rejected (Windows not ratified)"
else
  bad "unknown platform" "rc=$RC out=$(cat "$OUT")"
fi
cleanup

# --- archive contains exactly one entry, the executable ---------------------
new_sandbox
run_build linux-x64
A="$REL/mla-x86_64-unknown-linux-gnu.tar.gz"
entries="$(tar -tzf "$A" | grep -c .)"
if [ "$RC" -eq 0 ] && [ "$entries" = "1" ]; then
  ok "archive root holds exactly the executable, no nested dir (DIST-P0-2)"
else
  bad "single-entry archive" "rc=$RC entries=$entries"
fi
cleanup

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
