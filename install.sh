#!/bin/sh
# mla installer. Canonical: https://meetless.ai/install.sh
# Inspect before running:  curl -fsSL https://meetless.ai/install.sh | less
set -u

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
  download "$url" "$tmp/pkg.tar.gz" || err "download failed: $url"

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
  say "  Next, two steps:"
  say "    mla login       sign in (opens your browser)"
  say "    mla activate    bind a repo to a workspace (run inside the repo)"
  say ""
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

write_env() {
  _dir="$1"
  printf 'export PATH="%s:$PATH"\n' "$_dir" > "$_dir/env" || err "could not write $_dir/env"
}

configure_path() {
  _dir="$1"
  [ "$NO_MODIFY_PATH" = "1" ] && return 0
  for rc in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
    [ -f "$rc" ] || continue
    grep -Fqs "$_dir/env" "$rc" && continue   # -F: a path is a literal, not a regex
    printf '\n. "%s/env"\n' "$_dir" >> "$rc"
  done
}

main "$@"
