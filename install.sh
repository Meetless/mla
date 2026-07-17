#!/bin/sh
# mla installer. Canonical: https://meetless.ai/install.sh
# Inspect before running:  curl -fsSL https://meetless.ai/install.sh | less
set -u

# ---- $HOME sanity, BEFORE anything derives a path from it ----------------------
# Every path this installer writes hangs off $HOME: the install dir, the `env` file,
# and the shell rc files. A quoted "$HOME/..." with $HOME empty or set to the literal
# string "~" is a RELATIVE path (the shell does NOT expand a quoted tilde), so the
# installer would quietly install mla into whatever directory the operator happened to
# be standing in, and write a .zshenv and a .profile in there too. That is not
# hypothetical: on 2026-07-13 a Claude Code session was launched with HOME='' and
# every child it spawned re-rooted its state under the repo it was started in.
#
# `eval "h=~$user"` expands through the PASSWORD DATABASE (getpwnam), not through
# $HOME, so it recovers the truth from a poisoned environment. If even that yields
# nothing absolute we ABORT: an installer with nowhere legitimate to install must
# stop, never guess, and never fall back to the current directory.
case "${HOME:-}" in
  /*) ;;
  *)
    # SET-but-empty and UNSET are different bugs and must not print the same way:
    # `${HOME:-<unset>}` would call the 2026-07-13 incident value ('') "unset" and send
    # the operator hunting for a variable nobody removed. `${HOME+x}` tests SET-ness.
    if [ -n "${HOME+x}" ]; then _ml_broken="'$HOME'"; else _ml_broken="<unset>"; fi
    _ml_user="$(id -un 2>/dev/null || true)"
    _ml_home=""
    case "$_ml_user" in
      ''|*[!A-Za-z0-9._-]*) ;;                                  # never eval a metacharacter
      *) eval "_ml_home=~$_ml_user" 2>/dev/null || _ml_home="" ;;
    esac
    case "$_ml_home" in /*) ;; *) _ml_home="" ;; esac           # ~nosuchuser stays literal
    if [ -z "$_ml_home" ]; then
      printf 'mla: error: $HOME is %s and no home directory could be recovered from the\n' "$_ml_broken" >&2
      printf '  password database. Refusing to install into the current directory. Set HOME\n' >&2
      printf '  to your home directory (or MLA_INSTALL_DIR to an absolute path) and retry.\n' >&2
      exit 1
    fi
    printf 'mla: warning: ignoring $HOME=%s (not an absolute path); using %s instead.\n' "$_ml_broken" "$_ml_home" >&2
    HOME="$_ml_home"
    export HOME
    ;;
esac

# ---- config (all overridable via env) ----
APP="mla"
INSTALL_DIR="${MLA_INSTALL_DIR:-$HOME/.meetless/bin}"
VERSION="${MLA_VERSION:-latest}"
VERSION="${VERSION#v}"                          # accept 0.4.2 or v0.4.2; normalize to bare
# Binaries are hosted on the public meetless-public GCS bucket, the canonical
# release host: the installer needs no GitHub auth or API, and the download host
# is stable regardless of where the source repo lives. The URL shape mirrors
# GitHub Releases (.../latest/download/... and .../download/v<ver>/...) so the
# release pipeline can publish either way unchanged.
DOWNLOAD_BASE="${MLA_DOWNLOAD_URL:-https://storage.googleapis.com/meetless-public/cli/releases}"
NO_MODIFY_PATH="${MLA_NO_MODIFY_PATH:-0}"
NO_WIRE="${MLA_NO_WIRE:-0}"                     # skip wiring mla into Claude Code (CI/headless/paranoid)
ALLOW_UNVERIFIED="${MLA_ALLOW_UNVERIFIED:-0}"   # dev/test ONLY; never documented on the install page

main() {
  err()      { printf 'mla: error: %s\n' "$1" >&2; exit 1; }
  say()      { printf '%s\n' "$1"; }
  need_cmd() { command -v "$1" >/dev/null 2>&1 || err "need '$1' (command not found)"; }

  need_cmd uname; need_cmd mkdir; need_cmd tar
  command -v mktemp >/dev/null 2>&1 || err "need 'mktemp'"

  target="$(detect_target)"
  url="$(resolve_url "$target")"

  tmp="$(mktemp -d)" || err "could not create a temp dir"
  trap 'rm -rf "$tmp"' EXIT

  say "Downloading $APP ($target)..."
  download "$url" "$tmp/pkg.tar.gz" || download_failed "$target" "$url"

  if [ "$ALLOW_UNVERIFIED" = "1" ]; then
    say "warning: MLA_ALLOW_UNVERIFIED=1 set; skipping checksum verification (dev only)"
  else
    download "$url.sha256" "$tmp/pkg.sha256" || err "checksum file missing: $url.sha256 (refusing to install unverified)"
    verify_checksum "$tmp/pkg.tar.gz" "$tmp/pkg.sha256"
  fi

  tar -xzf "$tmp/pkg.tar.gz" -C "$tmp" || err "could not unpack the archive"
  [ -f "$tmp/$APP" ] || err "archive did not contain '$APP' at its root (release-layout bug)"
  mkdir -p "$INSTALL_DIR" || err "could not create $INSTALL_DIR"
  install_bin "$tmp/$APP" "$INSTALL_DIR/$APP"
  strip_quarantine "$INSTALL_DIR/$APP"

  write_env "$INSTALL_DIR"        # always written, so the success message never lies
  configure_path "$INSTALL_DIR"   # rc mutation only; skipped under MLA_NO_MODIFY_PATH=1

  wire_claude_code "$INSTALL_DIR"

  say ""
  say "  mla is installed at $INSTALL_DIR/$APP"
  say "  Restart your shell, or run:  . \"$INSTALL_DIR/env\""
  say ""
  say "  One step left. Open Claude Code in the repo you want governed and run:"
  say "    /mla activate   signs you in (browser), binds this repo, and seeds its"
  say "                    governed memory from your docs + git history. That's it."
  say "  (Or run 'mla activate' here in the terminal to just sign in + bind now.)"
  say ""

  # WSL-under-Windows: mla runs natively here, but a coding agent on the Windows
  # side (Git Bash) mangles a leading-slash arg into C:/Program Files/... and
  # breaks. Show the known-good cross-boundary invocation. Windows is community-
  # supported; mla is tested on macOS and Linux.
  case "$(uname -r 2>/dev/null | tr '[:upper:]' '[:lower:]')" in
    *microsoft* | *wsl*)
      say "  WSL detected. If a coding agent drives mla from the Windows side, call it"
      say "  through WSL, single-quoted so the path survives:"
      say "    wsl -e bash -c '\$HOME/.meetless/bin/mla <args>'"
      say "  Windows is community-supported: https://github.com/Meetless/mla"
      say ""
      ;;
  esac
}

# Wire mla into Claude Code (hooks, /mla skill, MCP server) so capture is live the
# moment the user opens a session, instead of a wired-but-invisible binary. We run
# `mla init --no-project-rules`:
#   - init is idempotent AND upgrade-safe: a re-run preserves a live login, refreshes
#     the bundled hook scripts, and re-registers wiring, so this one command covers
#     both fresh installs and upgrades with no branch on "is this an upgrade".
#   - --no-project-rules is NON-NEGOTIABLE here: a bare `mla init` would stamp a
#     Meetless block into whatever CLAUDE.md the cwd happens to sit in (curl | sh runs
#     from the user's current directory, often ~/ or an unrelated repo). Project-rules
#     writing is onboarding hygiene that belongs to an explicit `mla init`/`mla
#     activate` the user runs inside a repo they chose, never a drive-by install.
# Exit-tolerant: init returns nonzero when `flock` is not ready (a non-fatal hook-
# pipeline warning), and flock auto-install can fail on a bare machine. A successful
# binary install must never abort over that, so we warn and carry on. Opt out entirely
# with MLA_NO_WIRE=1 (CI/headless), mirroring MLA_NO_MODIFY_PATH.
wire_claude_code() {
  _dir="$1"
  if [ "$NO_WIRE" = "1" ]; then
    say ""
    say "  Skipping Claude Code wiring (MLA_NO_WIRE=1). Run 'mla init' later to wire capture."
    return 0
  fi
  say ""
  say "Wiring mla into Claude Code..."
  "$_dir/$APP" init --no-project-rules \
    || say "  (wiring reported a warning; run 'mla doctor' later)"
}

detect_target() {
  os="$(uname -s)"; arch="$(uname -m)"
  case "$os" in
    Linux)
      # I1 ships glibc binaries only. Fail loud on musl instead of 404-ing silently.
      if command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then
        err "musl/Alpine is not supported yet; install via npm:  npm i -g @meetless/mla"
      fi
      os="unknown-linux-gnu" ;;
    Darwin) os="apple-darwin" ;;
    *) err "unsupported OS: $os (try the npm install or a manual download)" ;;
  esac
  case "$arch" in
    x86_64|amd64)  arch="x86_64" ;;
    aarch64|arm64) arch="aarch64" ;;
    *) err "unsupported CPU: $arch" ;;
  esac
  printf '%s-%s' "$arch" "$os"
}

resolve_url() {
  _t="$1"
  if [ "$VERSION" = "latest" ]; then
    printf '%s/latest/download/%s-%s.tar.gz' "$DOWNLOAD_BASE" "$APP" "$_t"
  else
    printf '%s/download/v%s/%s-%s.tar.gz' "$DOWNLOAD_BASE" "$VERSION" "$APP" "$_t"
  fi
}

# A failed binary download is most often "no prebuilt binary for this target yet"
# (the GCS release set is a subset of platforms -- e.g. Intel Mac / Linux ARM may
# lag a release), or a transient network error. Either way the npm package is the
# universal fallback: it ships the same CLI for every platform Node runs on. Point
# the user there instead of dead-ending on a bare failing URL.
download_failed() {
  _t="$1"; _u="$2"
  printf 'mla: error: could not download a prebuilt binary for %s\n' "$_t" >&2
  printf '  tried: %s\n' "$_u" >&2
  printf '  There may be no prebuilt binary for %s yet, or the download failed.\n' "$_t" >&2
  printf '  Install via npm instead (works on every platform Node 18+ supports):\n' >&2
  printf '    npm i -g @meetless/mla\n' >&2
  exit 1
}

download() {
  # download URL OUT ; returns nonzero on failure (caller decides if fatal)
  if command -v curl >/dev/null 2>&1; then
    curl --proto '=https' --tlsv1.2 -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget --https-only -qO "$2" "$1"
  else
    err "need 'curl' or 'wget' to download"
  fi
}

verify_checksum() {
  # contract: .sha256 holds "<hex>  <filename>" (sha256sum/shasum format); field 1 is the hash
  want="$(cut -d' ' -f1 < "$2")"
  [ -n "$want" ] || err "checksum file was empty: $2"
  if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$1" | cut -d' ' -f1)"
  elif command -v shasum >/dev/null 2>&1; then got="$(shasum -a 256 "$1" | cut -d' ' -f1)"
  elif command -v openssl >/dev/null 2>&1; then got="$(openssl dgst -sha256 "$1" | awk '{print $NF}')"
  else err "no sha256 tool found (need sha256sum, shasum, or openssl); cannot verify - aborting"; fi
  [ "$want" = "$got" ] || err "checksum mismatch (want $want, got $got) - aborting"
}

install_bin() {
  src="$1"; dst="$2"
  if command -v install >/dev/null 2>&1; then install -m 0755 "$src" "$dst" || err "install to $dst failed"
  else cp "$src" "$dst" && chmod 0755 "$dst" || err "install to $dst failed"; fi
}

# macOS Gatekeeper (BUG-1): a binary carrying com.apple.quarantine (set when a
# browser or Homebrew stages the download) can be SIGKILLed on first run. Clearing
# the attribute lets Gatekeeper's ONLINE notarization check admit the binary. This
# is belt-and-suspenders: a Terminal `curl` download is usually NOT quarantined, so
# the attr is often absent -- hence best-effort. Darwin-only; never fatal.
strip_quarantine() {
  [ "$(uname -s)" = "Darwin" ] || return 0
  command -v xattr >/dev/null 2>&1 || return 0
  xattr -d com.apple.quarantine "$1" >/dev/null 2>&1 || true
}

# env is sourced from more than one rc file (a zsh user gets both .zshenv and
# .zshrc) and again on every re-install, so it must be idempotent: prepend only
# when the dir is not already on PATH. An unconditional prepend would stack a
# duplicate entry on every shell start.
write_env() {
  _bindir="$1"
  cat > "$_bindir/env" <<EOF || err "could not write $_bindir/env"
# mla shell env. Sourced from your shell rc; safe to source more than once.
case ":\${PATH}:" in
  *:"$_bindir":*) ;;
  *) export PATH="$_bindir:\${PATH}" ;;
esac
EOF
}

# Put the install dir on PATH for every shell that will go looking for mla.
#
# Two rules here, and both exist because of a prod bug that hit exactly the person
# we can least afford to lose: a first-time user on a fresh Mac.
#
#   1. CREATE the rc file when it is absent, never skip it. A pristine macOS account
#      has no ~/.zshrc, ~/.bashrc or ~/.profile at all (Homebrew's installer writes
#      ~/.zprofile, not ~/.zshrc). The old loop only appended to files that already
#      existed, so on that machine it matched nothing, mutated nothing, and the
#      install still exited 0 saying "Restart your shell". mla was never on PATH.
#
#   2. Write .zshenv, not just .zshrc. zsh reads .zshrc ONLY for interactive shells;
#      .zshenv is read by every zsh, including the non-interactive `zsh -c` that
#      coding agents, hooks, and scripts spawn. That is the shell that kept reporting
#      "command not found: mla" from inside Claude Code.
#
# Writing several files is safe: each is inert to the shells that ignore it, and env
# is a no-op once the dir is already on PATH.
configure_path() {
  _bindir="$1"
  [ "$NO_MODIFY_PATH" = "1" ] && return 0
  RC_TOUCHED=""

  add_env_line "${ZDOTDIR:-$HOME}/.zshenv" "$_bindir" create   # zsh: login, interactive AND `zsh -c`
  add_env_line "$HOME/.profile"            "$_bindir" create   # sh/bash login shells
  # Only if the user already keeps one; we do not invent rc files we do not need.
  for rc in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.zshrc"; do
    add_env_line "$rc" "$_bindir" existing
  done

  # The success message must never lie. If nothing could be updated (exotic shell,
  # read-only home), say so with the exact line to add instead of "Restart your shell".
  [ -n "$RC_TOUCHED" ] || {
    say ""
    say "  warning: found no shell profile to update. Add this line to your shell's"
    say "  startup file yourself, or mla will not be on your PATH:"
    say "    . \"$_bindir/env\""
  }
}

# add_env_line RC BINDIR create|existing
#   create   -> write the file when absent (the shell we must guarantee)
#   existing -> only append to a file the user already keeps
add_env_line() {
  _rc="$1"; _d="$2"; _mode="$3"
  if [ ! -f "$_rc" ]; then
    [ "$_mode" = "create" ] || return 0
    : > "$_rc" 2>/dev/null || return 0        # unwritable home: fall through to the warning, never abort
  fi
  if ! grep -Fqs "$_d/env" "$_rc"; then       # -F: a path is a literal, not a regex
    printf '\n. "%s/env"\n' "$_d" >> "$_rc" || return 0
  fi
  RC_TOUCHED="$RC_TOUCHED $_rc"
}

main "$@"
