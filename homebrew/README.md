# Meetless Homebrew tap

Source-of-truth tooling for the `meetless/homebrew-tap` repository. The `mla`
cask itself is **generated**, never hand-edited: each release runs
[`render-cask.sh`](./render-cask.sh) and commits the result to
`meetless/homebrew-tap` at `Casks/mla.rb`.

> The published tap repo MUST be named `homebrew-tap` (the `homebrew-` prefix is
> mandatory), so users type the short `meetless/tap`.

## Install

```bash
brew install --cask meetless/tap/mla
```

Use the explicit `--cask` form. It is unambiguous and stays correct even if a
formula of the same name is ever added to the tap.

## Upgrade

```bash
brew upgrade --cask mla
```

## How the cask is produced

`render-cask.sh <version> <release-dir>` reads the macOS archives' `.sha256`
sidecars (the same `<hex>  <filename>` files `install.sh` verifies) and emits a
dual-arch cask:

- one `url` template interpolating the per-machine triple (`arch` stanza), and
- per-arch `sha256` in `on_arm` / `on_intel`.

The download URL pattern and the architecture triples are byte-identical to
`install.sh`'s `resolve_url`, so `brew install --cask` and `curl | sh` fetch the
exact same release assets. The release CI's channel-fan-out stage runs this
renderer and pushes the result to the tap.

```bash
# what CI runs, roughly:
homebrew/render-cask.sh "$VERSION" ./release > Casks/mla.rb
```

`MLA_TAP_REPO` overrides the GitHub repo the cask downloads from (default
`meetless/cli`); set it when the OSS repo lands under a different name.

## Signing note (honest caveat)

The macOS binaries are **ad-hoc signed** (`codesign -s -`), not Developer ID
notarized. Homebrew downloads via curl, which does not set the
`com.apple.quarantine` attribute, so the cask install path is unaffected by
Gatekeeper today. Full Developer ID signing + notarization is a deferred
follow-on (proposal §10, phase I6); if a future macOS makes Gatekeeper stricter
about ad-hoc binaries under a cask, that is the fix. The `curl | sh` install path
is independent of this.
