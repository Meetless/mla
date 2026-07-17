#!/usr/bin/env bash
# Hermetic test suite for install.sh (the curl|sh installer).
#
# We never hit the network. The only seams stubbed are the primitives the
# installer shells out to for I/O it cannot do itself: `curl` (download),
# `uname` (target detection), and `ldd` (musl detection). Everything else
# (tar, mkdir, install, sha256, grep, the whole script logic) runs for real,
# so this exercises detect_target, resolve_url, checksum verification, the
# archive-root contract, env writing, and PATH mutation end to end.
#
# Run:  bash test/install.test.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
INSTALLER="$HERE/../install.sh"
SH="${TEST_SH:-sh}"   # run the installer under /bin/sh by default; CI may set dash

PASS=0
FAIL=0

note()  { printf '%s\n' "$*"; }
ok()    { PASS=$((PASS + 1)); printf '  PASS: %s\n' "$1"; }
bad()   { FAIL=$((FAIL + 1)); printf '  FAIL: %s :: %s\n' "$1" "$2"; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# --- per-test sandbox -------------------------------------------------------
# Lays out: $SBX/home (fake HOME), $SBX/fixtures (what stub curl serves),
# $SBX/bin (stubs prepended to PATH). Returns via globals SBX/HOME_DIR/FIX/STUB.
new_sandbox() {
  SBX="$(mktemp -d)"
  HOME_DIR="$SBX/home"; FIX="$SBX/fixtures"; STUB="$SBX/bin"
  mkdir -p "$HOME_DIR" "$FIX" "$STUB"

  # stub curl: ignore TLS/retry flags, map the URL basename to a fixture file.
  cat > "$STUB/curl" <<'EOF'
#!/bin/sh
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) shift; out="$1" ;;
    -*) : ;;            # ignore --proto / --tlsv1.2 / -fsSL / --retry value below
    *) url="$1" ;;
  esac
  shift
done
base="${url##*/}"
src="$FIXTURES_DIR/$base"
[ -f "$src" ] || exit 22       # mimic curl -f on a 404
if [ -n "$out" ]; then cp "$src" "$out"; else cat "$src"; fi
exit 0
EOF
  chmod +x "$STUB/curl"
}

# stub uname for a chosen target (call before run_installer when overriding)
stub_uname() {  # $1=os(-s) $2=machine(-m)
  cat > "$STUB/uname" <<EOF
#!/bin/sh
case "\$1" in
  -s) printf '%s\n' "$1" ;;
  -m) printf '%s\n' "$2" ;;
  *)  printf '%s\n' "$1" ;;
esac
EOF
  chmod +x "$STUB/uname"
}

# stub ldd to advertise musl (only the musl test wants this)
stub_ldd_musl() {
  cat > "$STUB/ldd" <<'EOF'
#!/bin/sh
echo "musl libc (x86_64)"
exit 0
EOF
  chmod +x "$STUB/ldd"
}

# build a fixture release archive (exec `mla` at root) + a valid .sha256
make_fixture() {  # $1=archive-name $2=binary-body
  local arch="$1" body="$2" bd="$SBX/build.$$.$RANDOM"
  mkdir -p "$bd"
  printf '#!/bin/sh\n%s\n' "$body" > "$bd/mla"
  chmod +x "$bd/mla"
  tar -czf "$FIX/$arch" -C "$bd" mla
  printf '%s  %s\n' "$(sha256_of "$FIX/$arch")" "$arch" > "$FIX/$arch.sha256"
  rm -rf "$bd"
}

# build a fixture archive whose root is NOT `mla` (release-layout bug)
make_fixture_no_binary() {  # $1=archive-name
  local arch="$1" bd="$SBX/build.$$.$RANDOM"
  mkdir -p "$bd"
  printf 'not the binary\n' > "$bd/notmla"
  tar -czf "$FIX/$arch" -C "$bd" notmla
  printf '%s  %s\n' "$(sha256_of "$FIX/$arch")" "$arch" > "$FIX/$arch.sha256"
  rm -rf "$bd"
}

# run install.sh inside the sandbox; captures rc + output to $OUT
run_installer() {  # extra KEY=VAL env passed as args
  OUT="$SBX/output.txt"
  env -i \
    HOME="$HOME_DIR" \
    PATH="$STUB:/usr/bin:/bin:/usr/sbin:/sbin" \
    FIXTURES_DIR="$FIX" \
    "$@" \
    "$SH" "$INSTALLER" > "$OUT" 2>&1
  RC=$?
}

cleanup() { [ -n "${SBX:-}" ] && rm -rf "$SBX"; }

# --- assertions -------------------------------------------------------------
have_file()    { [ -f "$1" ]; }
file_has()     { grep -Fq "$2" "$1" 2>/dev/null; }
count_lines()  { grep -Fc "$2" "$1" 2>/dev/null || echo 0; }

# ===========================================================================
note "install.sh test suite"
[ -f "$INSTALLER" ] || { printf 'FATAL: installer not found at %s\n' "$INSTALLER"; exit 1; }

# --- 1. fresh install -------------------------------------------------------
new_sandbox
stub_uname Darwin arm64
make_fixture "mla-aarch64-apple-darwin.tar.gz" 'echo v1'
: > "$HOME_DIR/.zshrc"
run_installer
if [ "$RC" -eq 0 ] && have_file "$HOME_DIR/.meetless/bin/mla" \
   && [ -x "$HOME_DIR/.meetless/bin/mla" ] \
   && have_file "$HOME_DIR/.meetless/bin/env" \
   && file_has "$HOME_DIR/.zshrc" '.meetless/bin/env'; then
  ok "fresh install places binary, env, and PATH line"
else
  bad "fresh install" "rc=$RC out=$(cat "$OUT")"
fi
cleanup

# --- 2. re-run is idempotent (no duplicate PATH line) -----------------------
new_sandbox
stub_uname Darwin arm64
make_fixture "mla-aarch64-apple-darwin.tar.gz" 'echo v1'
: > "$HOME_DIR/.zshrc"
run_installer
run_installer
c="$(count_lines "$HOME_DIR/.zshrc" '.meetless/bin/env')"
if [ "$RC" -eq 0 ] && [ "$c" = "1" ]; then
  ok "re-run is idempotent (PATH line appears once)"
else
  bad "idempotent re-run" "rc=$RC path-line-count=$c"
fi
cleanup

# --- 3. upgrade replaces the binary in place --------------------------------
new_sandbox
stub_uname Darwin arm64
make_fixture "mla-aarch64-apple-darwin.tar.gz" 'echo v1'
run_installer
make_fixture "mla-aarch64-apple-darwin.tar.gz" 'echo v2-upgraded'
run_installer
if [ "$RC" -eq 0 ] && file_has "$HOME_DIR/.meetless/bin/mla" 'v2-upgraded'; then
  ok "upgrade replaces the installed binary"
else
  bad "upgrade" "rc=$RC body=$(cat "$HOME_DIR/.meetless/bin/mla" 2>/dev/null)"
fi
cleanup

# --- 4. MLA_NO_MODIFY_PATH=1 writes env but not rc --------------------------
new_sandbox
stub_uname Darwin arm64
make_fixture "mla-aarch64-apple-darwin.tar.gz" 'echo v1'
: > "$HOME_DIR/.zshrc"
run_installer MLA_NO_MODIFY_PATH=1
if [ "$RC" -eq 0 ] && have_file "$HOME_DIR/.meetless/bin/env" \
   && ! file_has "$HOME_DIR/.zshrc" '.meetless/bin/env' \
   && ! have_file "$HOME_DIR/.zshenv" && ! have_file "$HOME_DIR/.profile"; then
  ok "MLA_NO_MODIFY_PATH=1 leaves rc files untouched and creates none"
else
  bad "no-modify-path" "rc=$RC zshrc=$(cat "$HOME_DIR/.zshrc")"
fi
cleanup

# --- 5. custom MLA_INSTALL_DIR ----------------------------------------------
new_sandbox
stub_uname Darwin arm64
make_fixture "mla-aarch64-apple-darwin.tar.gz" 'echo v1'
run_installer MLA_INSTALL_DIR="$HOME_DIR/custom/place"
if [ "$RC" -eq 0 ] && have_file "$HOME_DIR/custom/place/mla"; then
  ok "custom MLA_INSTALL_DIR is honored"
else
  bad "custom install dir" "rc=$RC"
fi
cleanup

# --- 6. checksum mismatch aborts --------------------------------------------
new_sandbox
stub_uname Darwin arm64
make_fixture "mla-aarch64-apple-darwin.tar.gz" 'echo v1'
printf '%s  %s\n' "0000000000000000000000000000000000000000000000000000000000000000" \
  "mla-aarch64-apple-darwin.tar.gz" > "$FIX/mla-aarch64-apple-darwin.tar.gz.sha256"
run_installer
if [ "$RC" -ne 0 ] && ! have_file "$HOME_DIR/.meetless/bin/mla" \
   && file_has "$OUT" 'checksum mismatch'; then
  ok "checksum mismatch aborts and installs nothing"
else
  bad "checksum mismatch" "rc=$RC out=$(cat "$OUT")"
fi
cleanup

# --- 7. missing checksum aborts (no silent skip) ----------------------------
new_sandbox
stub_uname Darwin arm64
make_fixture "mla-aarch64-apple-darwin.tar.gz" 'echo v1'
rm -f "$FIX/mla-aarch64-apple-darwin.tar.gz.sha256"
run_installer
if [ "$RC" -ne 0 ] && ! have_file "$HOME_DIR/.meetless/bin/mla" \
   && file_has "$OUT" 'checksum file missing'; then
  ok "missing checksum aborts (DIST-P0-3)"
else
  bad "missing checksum" "rc=$RC out=$(cat "$OUT")"
fi
cleanup

# --- 8. MLA_ALLOW_UNVERIFIED=1 escape hatch ---------------------------------
new_sandbox
stub_uname Darwin arm64
make_fixture "mla-aarch64-apple-darwin.tar.gz" 'echo v1'
rm -f "$FIX/mla-aarch64-apple-darwin.tar.gz.sha256"
run_installer MLA_ALLOW_UNVERIFIED=1
if [ "$RC" -eq 0 ] && have_file "$HOME_DIR/.meetless/bin/mla" \
   && file_has "$OUT" 'skipping checksum'; then
  ok "MLA_ALLOW_UNVERIFIED=1 installs without a checksum"
else
  bad "allow-unverified" "rc=$RC out=$(cat "$OUT")"
fi
cleanup

# --- 9. unsupported CPU -> clear error --------------------------------------
new_sandbox
stub_uname Linux ppc64
run_installer
if [ "$RC" -ne 0 ] && file_has "$OUT" 'unsupported CPU'; then
  ok "unsupported CPU fails with a clear message"
else
  bad "unsupported cpu" "rc=$RC out=$(cat "$OUT")"
fi
cleanup

# --- 10. unsupported OS -> clear error --------------------------------------
new_sandbox
stub_uname SunOS x86_64
run_installer
if [ "$RC" -ne 0 ] && file_has "$OUT" 'unsupported OS'; then
  ok "unsupported OS fails with a clear message"
else
  bad "unsupported os" "rc=$RC out=$(cat "$OUT")"
fi
cleanup

# --- 11. musl -> loud fail with npm fallback --------------------------------
new_sandbox
stub_uname Linux x86_64
stub_ldd_musl
run_installer
if [ "$RC" -ne 0 ] && file_has "$OUT" 'npm i -g @meetless/mla' \
   && ! have_file "$HOME_DIR/.meetless/bin/mla"; then
  ok "musl fails loud and points at the npm fallback (DIST-P0-6)"
else
  bad "musl fallback" "rc=$RC out=$(cat "$OUT")"
fi
cleanup

# --- 12. archive missing the binary -> clear error --------------------------
new_sandbox
stub_uname Darwin arm64
make_fixture_no_binary "mla-aarch64-apple-darwin.tar.gz"
run_installer
if [ "$RC" -ne 0 ] && file_has "$OUT" "archive did not contain" \
   && ! have_file "$HOME_DIR/.meetless/bin/mla"; then
  ok "archive without the binary fails the archive-root check (DIST-P0-2)"
else
  bad "archive missing binary" "rc=$RC out=$(cat "$OUT")"
fi
cleanup

# --- 13. linux glibc fresh install (deterministic via ldd-glibc default) -----
new_sandbox
stub_uname Linux x86_64
make_fixture "mla-x86_64-unknown-linux-gnu.tar.gz" 'echo linux'
: > "$HOME_DIR/.bashrc"
run_installer
if [ "$RC" -eq 0 ] && have_file "$HOME_DIR/.meetless/bin/mla" \
   && file_has "$HOME_DIR/.bashrc" '.meetless/bin/env'; then
  ok "linux glibc fresh install resolves the gnu triple"
else
  bad "linux glibc install" "rc=$RC out=$(cat "$OUT")"
fi
cleanup

# --- 14. pristine account (NO rc files) still gets PATH ---------------------
# The prod bug: a first-time macOS account has no ~/.zshrc, ~/.bashrc or ~/.profile
# (Homebrew writes ~/.zprofile, not ~/.zshrc). configure_path skipped every rc file
# that did not exist, so it mutated nothing -- while the installer still exited 0 and
# said "Restart your shell". mla was never on PATH. We must CREATE the rc file.
new_sandbox
stub_uname Darwin arm64
make_fixture "mla-aarch64-apple-darwin.tar.gz" 'echo v1'
run_installer                       # note: no rc file pre-created
if [ "$RC" -eq 0 ] && file_has "$HOME_DIR/.zshenv" '.meetless/bin/env' \
   && file_has "$HOME_DIR/.profile" '.meetless/bin/env'; then
  ok "pristine HOME with no rc files still gets PATH configured"
else
  bad "pristine HOME" "rc=$RC home=$(ls -A "$HOME_DIR")"
fi

# 14b. the assertion that matters: a real shell resolves `mla` afterwards. zsh -c is
# what a coding agent, hook, or script spawns -- and it reads .zshenv ONLY, never
# .zshrc, which is why "command not found: mla" persisted inside Claude Code.
if command -v zsh >/dev/null 2>&1; then
  got="$(env -i HOME="$HOME_DIR" zsh -c 'command -v mla' 2>/dev/null)"
  if [ "$got" = "$HOME_DIR/.meetless/bin/mla" ]; then
    ok "non-interactive 'zsh -c' resolves mla (the coding-agent shell)"
  else
    bad "zsh -c resolves mla" "got='$got' want='$HOME_DIR/.meetless/bin/mla'"
  fi
else
  note "  SKIP: zsh not installed; cannot assert the coding-agent shell"
fi

# 14c. same for a bash login shell, which reads .profile.
if command -v bash >/dev/null 2>&1; then
  got="$(env -i HOME="$HOME_DIR" bash -lc 'command -v mla' 2>/dev/null)"
  if [ "$got" = "$HOME_DIR/.meetless/bin/mla" ]; then
    ok "bash login shell resolves mla"
  else
    bad "bash -lc resolves mla" "got='$got' want='$HOME_DIR/.meetless/bin/mla'"
  fi
fi
cleanup

# --- 15. env is idempotent: sourcing it twice must not duplicate PATH -------
# env is now referenced from several rc files (.zshenv AND .zshrc for a zsh user), so
# a naive unconditional prepend would stack a duplicate entry on every shell start.
new_sandbox
stub_uname Darwin arm64
make_fixture "mla-aarch64-apple-darwin.tar.gz" 'echo v1'
run_installer
n="$(env -i HOME="$HOME_DIR" PATH="/usr/bin:/bin" sh -c \
      '. "$HOME/.meetless/bin/env"; . "$HOME/.meetless/bin/env"; echo "$PATH"' \
      | tr ':' '\n' | grep -Fc '.meetless/bin')"
if [ "$RC" -eq 0 ] && [ "$n" = "1" ]; then
  ok "env is idempotent (double-source leaves one PATH entry)"
else
  bad "env idempotency" "rc=$RC entries=$n"
fi
cleanup

# ===========================================================================
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
