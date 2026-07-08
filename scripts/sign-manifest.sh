#!/usr/bin/env bash
# sign-manifest.sh: produce manifest.json.sig, a base64-encoded Ed25519 signature
# over the EXACT bytes of manifest.json. The mla client reads the .sig as base64,
# decodes it, and verifies with Node's crypto.verify(null, bytes, pubKey, sig)
# (the `null` algorithm == Ed25519 / PureEdDSA). See verifyManifestSignature() in
# src/lib/update-check.ts. The public key is baked into the binary at build time
# (MLA_UPDATE_PUBLIC_KEY -> gen-build-info.js); this script holds/uses the PRIVATE
# half.
#
# Two backends, selected by MLA_SIGN_BACKEND (default: local):
#
#   local  -- sign with an Ed25519 private key PEM on disk (eval + the CI-secret
#             fallback path of D1). Requires openssl. Key from MLA_SIGN_KEY
#             (path to the PEM).
#
#   kms    -- sign with Google Cloud KMS (D1, the locked production choice). The
#             private key never leaves KMS; CI calls asymmetric-sign. The KMS key
#             MUST be created with algorithm EC_SIGN_ED25519 (NOT the recommended
#             EC_SIGN_P256_SHA256) or the signature will not verify against the
#             Ed25519 client. Requires gcloud. Key from MLA_KMS_KEY (the full
#             resource name: projects/.../cryptoKeyVersions/N).
#
# Usage:
#   MLA_SIGN_BACKEND=local MLA_SIGN_KEY=keys/priv.pem scripts/sign-manifest.sh <manifest.json>
#   MLA_SIGN_BACKEND=kms   MLA_KMS_KEY=projects/.../cryptoKeyVersions/1 scripts/sign-manifest.sh <manifest.json>
#
# Output: <manifest.json>.sig  (i.e. manifest.json.sig), base64, no trailing newline.
set -euo pipefail

MANIFEST="${1:-}"
if [ -z "$MANIFEST" ]; then
  echo "sign-manifest: error: missing manifest path (e.g. release/manifest.json)" >&2
  exit 2
fi
[ -f "$MANIFEST" ] || { echo "sign-manifest: error: no such file: $MANIFEST" >&2; exit 1; }

BACKEND="${MLA_SIGN_BACKEND:-local}"
SIG="${MANIFEST}.sig"
RAW="$(mktemp)"
trap 'rm -f "$RAW"' EXIT

case "$BACKEND" in
  local)
    KEY="${MLA_SIGN_KEY:-}"
    [ -n "$KEY" ] || { echo "sign-manifest: error: MLA_SIGN_BACKEND=local needs MLA_SIGN_KEY=<priv.pem>" >&2; exit 2; }
    [ -f "$KEY" ] || { echo "sign-manifest: error: no such key file: $KEY" >&2; exit 1; }
    command -v openssl >/dev/null 2>&1 || { echo "sign-manifest: error: openssl not found" >&2; exit 1; }
    # Ed25519 is a one-shot (PureEdDSA) algorithm: no -digest, sign the file bytes.
    openssl pkeyutl -sign -rawin -inkey "$KEY" -in "$MANIFEST" -out "$RAW"
    ;;
  kms)
    KMS_KEY="${MLA_KMS_KEY:-}"
    [ -n "$KMS_KEY" ] || { echo "sign-manifest: error: MLA_SIGN_BACKEND=kms needs MLA_KMS_KEY=<resource>" >&2; exit 2; }
    command -v gcloud >/dev/null 2>&1 || { echo "sign-manifest: error: gcloud not found" >&2; exit 1; }
    # Ed25519 KMS keys sign the raw message directly (no client-side digest).
    gcloud kms asymmetric-sign \
      --version "$KMS_KEY" \
      --input-file "$MANIFEST" \
      --signature-file "$RAW" \
      ${MLA_KMS_EXTRA_ARGS:-}
    ;;
  *)
    echo "sign-manifest: error: unknown MLA_SIGN_BACKEND='$BACKEND' (want local|kms)" >&2
    exit 2 ;;
esac

# The client reads the .sig as base64 of the raw signature bytes. Emit a single
# line with no trailing newline so the decoded payload is exactly the signature.
if base64 --help 2>&1 | grep -q -- "-w"; then
  base64 -w0 < "$RAW" > "$SIG"   # GNU coreutils
else
  base64 < "$RAW" | tr -d '\n' > "$SIG"   # BSD/macOS
fi

echo "sign-manifest: wrote $SIG ($BACKEND, $(wc -c < "$SIG" | tr -d ' ') base64 bytes)"
