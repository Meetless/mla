# Meetless Homebrew tap

Homebrew tap for [Meetless](https://meetless.ai) tools.

```sh
brew install --cask meetless/tap/mla
```

That installs `mla`, the Meetless CLI: governed change-control and knowledge for
AI coding agents.

If Homebrew answers `Refusing to load cask ... from untrusted tap`, trust this tap
once and re-run:

```sh
brew trust meetless/tap
```

Homebrew is phasing in [mandatory trust](https://docs.brew.sh/Tap-Trust) for every
third-party tap. Most installs today only print a deprecation warning, but strict
setups and CI images (which set `HOMEBREW_REQUIRE_TAP_TRUST`) already refuse without
it.

## Upgrade

```sh
brew upgrade --cask mla
```

## What lives here

`Casks/mla.rb` is **generated**, never hand-edited. Each `mla` release runs a
renderer in the (private) Meetless monorepo and pushes the updated cask here, so
the cask's `sha256` always matches the published binaries. The binaries are
hosted on Meetless's public release bucket, the same assets the
`curl -fsSL https://meetless.ai/install.sh | sh` installer fetches.

If you opened this repo to change the cask by hand: don't. Edits are overwritten
on the next release. The renderer is the source of truth.

## Links

- Website: https://meetless.ai
- Report a bug: run `mla bug report`, or email hi@meetless.ai
