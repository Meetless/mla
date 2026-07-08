import * as crypto from "crypto";

import {
  DEFAULT_MANIFEST_URL,
  currentTriple,
  isBelowMinVersion,
  parseManifest,
  parseState,
  planUpgrade,
  resolveAutoApply,
  selectArtifact,
  serializeState,
  verifyManifestSignature,
  type Manifest,
} from "../../src/lib/update-check";

// Pure-core coverage for the signed-manifest upgrade path (proposal
// 20260615-mla-version-detection-and-upgrade). Everything here is deterministic
// and side-effect free: manifest shape validation, Ed25519 signature checking,
// triple mapping, the downgrade guard, the env opt-out precedence, and the
// extended cache schema. The IO layer (swap, lock, stage, promote) is pinned
// separately in upgrade-apply.spec.ts. The DEFAULT_MANIFEST_URL import doubles
// as a drift guard so the eval host stays in sync with the resolver.

const HEX = "a".repeat(64);

function manifest(over: Partial<Manifest> = {}): Manifest {
  return {
    schemaVersion: 1,
    channel: "stable",
    version: "0.5.0",
    minVersion: "0.3.0",
    releasedAt: "2026-06-20T00:00:00Z",
    artifacts: {
      "aarch64-apple-darwin": { url: "https://cdn.example/a.tar.gz", sha256: HEX },
      "x86_64-apple-darwin": { url: "https://cdn.example/m.tar.gz", sha256: HEX },
      "x86_64-unknown-linux-gnu": { url: "https://cdn.example/l.tar.gz", sha256: HEX },
    },
    ...over,
  };
}

describe("parseManifest", () => {
  it("accepts a well-formed manifest and keeps every field", () => {
    const m = parseManifest(JSON.stringify(manifest({ notes: "hi" })));
    expect(m).not.toBeNull();
    expect(m!.version).toBe("0.5.0");
    expect(m!.minVersion).toBe("0.3.0");
    expect(m!.channel).toBe("stable");
    expect(m!.notes).toBe("hi");
    expect(m!.artifacts["aarch64-apple-darwin"].sha256).toBe(HEX);
  });

  it("allows an http loopback artifact url (local eval), https everywhere else", () => {
    const loop = manifest({
      artifacts: { "aarch64-apple-darwin": { url: "http://127.0.0.1:8799/a.tar.gz", sha256: HEX } },
    });
    expect(parseManifest(JSON.stringify(loop))).not.toBeNull();
  });

  it("rejects a non-loopback http artifact url (no transport downgrade in prod)", () => {
    const bad = manifest({
      artifacts: { "aarch64-apple-darwin": { url: "http://cdn.example/a.tar.gz", sha256: HEX } },
    });
    expect(parseManifest(JSON.stringify(bad))).toBeNull();
  });

  it("rejects a wrong schemaVersion", () => {
    expect(parseManifest(JSON.stringify(manifest({ schemaVersion: 2 as 1 })))).toBeNull();
  });

  it("rejects a non-semver version", () => {
    expect(parseManifest(JSON.stringify(manifest({ version: "latest" })))).toBeNull();
  });

  it("rejects a non-semver minVersion", () => {
    expect(parseManifest(JSON.stringify(manifest({ minVersion: "" })))).toBeNull();
  });

  it("rejects a sha256 that is not 64 lowercase hex", () => {
    const short = manifest({
      artifacts: { "aarch64-apple-darwin": { url: "https://cdn.example/a.tar.gz", sha256: "abc" } },
    });
    expect(parseManifest(JSON.stringify(short))).toBeNull();
    const upper = manifest({
      artifacts: {
        "aarch64-apple-darwin": { url: "https://cdn.example/a.tar.gz", sha256: "A".repeat(64) },
      },
    });
    expect(parseManifest(JSON.stringify(upper))).toBeNull();
  });

  it("rejects an empty artifact set", () => {
    expect(parseManifest(JSON.stringify(manifest({ artifacts: {} })))).toBeNull();
  });

  it("rejects malformed json, null, and empty input", () => {
    expect(parseManifest("{not json")).toBeNull();
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest("")).toBeNull();
  });
});

describe("verifyManifestSignature (Ed25519)", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const other = crypto.generateKeyPairSync("ed25519");
  const otherPem = other.publicKey.export({ type: "spki", format: "pem" }).toString();

  const bytes = Buffer.from(JSON.stringify(manifest()));
  const sig = crypto.sign(null, bytes, privateKey).toString("base64");

  it("verifies a real signature over the exact bytes", () => {
    expect(verifyManifestSignature(bytes, sig, [pubPem])).toBe(true);
  });

  it("rejects tampered bytes", () => {
    const tampered = Buffer.from(bytes);
    tampered[0] ^= 0xff;
    expect(verifyManifestSignature(tampered, sig, [pubPem])).toBe(false);
  });

  it("rejects the wrong key", () => {
    expect(verifyManifestSignature(bytes, sig, [otherPem])).toBe(false);
  });

  it("accepts when any key in the trust list verifies (rotation)", () => {
    expect(verifyManifestSignature(bytes, sig, [otherPem, pubPem])).toBe(true);
  });

  it("skips a malformed key in the list instead of throwing", () => {
    expect(verifyManifestSignature(bytes, sig, ["not a key", pubPem])).toBe(true);
    expect(verifyManifestSignature(bytes, sig, ["not a key"])).toBe(false);
  });

  it("rejects an empty signature or an empty trust list", () => {
    expect(verifyManifestSignature(bytes, "", [pubPem])).toBe(false);
    expect(verifyManifestSignature(bytes, sig, [])).toBe(false);
  });
});

describe("currentTriple", () => {
  it("maps the three published targets", () => {
    expect(currentTriple("darwin", "arm64")).toBe("aarch64-apple-darwin");
    expect(currentTriple("darwin", "x64")).toBe("x86_64-apple-darwin");
    expect(currentTriple("linux", "x64")).toBe("x86_64-unknown-linux-gnu");
  });

  it("returns null for targets we do not publish", () => {
    expect(currentTriple("linux", "arm64")).toBeNull();
    expect(currentTriple("darwin", "ppc")).toBeNull();
    expect(currentTriple("win32", "x64")).toBeNull();
  });
});

describe("selectArtifact", () => {
  it("returns the artifact for a present triple", () => {
    expect(selectArtifact(manifest(), "aarch64-apple-darwin")).toEqual({
      url: "https://cdn.example/a.tar.gz",
      sha256: HEX,
    });
  });

  it("returns null for a missing triple or a null triple", () => {
    expect(selectArtifact(manifest({ artifacts: { "x86_64-apple-darwin": { url: "https://x/m.tar.gz", sha256: HEX } } }), "aarch64-apple-darwin")).toBeNull();
    expect(selectArtifact(manifest(), null)).toBeNull();
  });
});

describe("isBelowMinVersion", () => {
  it("is true only when strictly below the floor", () => {
    expect(isBelowMinVersion("0.2.9", "0.3.0")).toBe(true);
    expect(isBelowMinVersion("0.3.0", "0.3.0")).toBe(false);
    expect(isBelowMinVersion("0.4.0", "0.3.0")).toBe(false);
  });

  it("never flags an unparseable current or a null floor", () => {
    expect(isBelowMinVersion("devsha-dirty", "0.3.0")).toBe(false);
    expect(isBelowMinVersion("0.1.0", null)).toBe(false);
  });
});

describe("planUpgrade (the downgrade guard)", () => {
  const triple = "aarch64-apple-darwin";

  it("plans an upgrade when a strictly newer version is published", () => {
    const p = planUpgrade({ current: "0.4.0", manifest: manifest(), triple, force: false });
    expect(p.action).toBe("upgrade");
    expect(p.to).toBe("0.5.0");
  });

  it("is up-to-date on the same version", () => {
    expect(planUpgrade({ current: "0.5.0", manifest: manifest(), triple, force: false }).action).toBe("up-to-date");
  });

  it("blocks a downgrade unless forced", () => {
    expect(planUpgrade({ current: "0.6.0", manifest: manifest(), triple, force: false }).action).toBe("downgrade-blocked");
    expect(planUpgrade({ current: "0.6.0", manifest: manifest(), triple, force: true }).action).toBe("upgrade");
  });

  it("reports no-artifact for a missing or null triple", () => {
    expect(planUpgrade({ current: "0.4.0", manifest: manifest(), triple: "win-triple", force: false }).action).toBe("no-artifact");
    expect(planUpgrade({ current: "0.4.0", manifest: manifest(), triple: null, force: false }).action).toBe("no-artifact");
  });

  it("refuses to overwrite an unparseable dev build unless forced", () => {
    expect(planUpgrade({ current: "b6a81f7-dirty", manifest: manifest(), triple, force: false }).action).toBe("unparseable-current");
    expect(planUpgrade({ current: "b6a81f7-dirty", manifest: manifest(), triple, force: true }).action).toBe("upgrade");
  });
});

describe("resolveAutoApply (env opt-out precedence)", () => {
  const env = (o: Record<string, string> = {}): NodeJS.ProcessEnv => o as NodeJS.ProcessEnv;

  it("auto-applies only when config opts in and no env overrides it", () => {
    expect(resolveAutoApply({ env: env(), configAutoApply: true })).toBe(true);
    expect(resolveAutoApply({ env: env(), configAutoApply: false })).toBe(false);
    expect(resolveAutoApply({ env: env(), configAutoApply: undefined })).toBe(false);
  });

  it("honors the precedence ladder over a config opt-in", () => {
    expect(resolveAutoApply({ env: env({ MLA_DISABLE_UPGRADE: "1" }), configAutoApply: true })).toBe(false);
    expect(resolveAutoApply({ env: env({ MLA_DISABLE_AUTO_UPGRADE: "1" }), configAutoApply: true })).toBe(false);
    expect(resolveAutoApply({ env: env({ MLA_NO_UPDATE_NOTIFIER: "1" }), configAutoApply: true })).toBe(false);
  });
});

describe("parseState / serializeState (extended cache schema)", () => {
  it("round-trips minVersion and a staged pointer", () => {
    const state = {
      lastCheckedAt: 123,
      latestVersion: "0.5.0",
      minVersion: "0.3.0",
      staged: {
        version: "0.5.0",
        triple: "aarch64-apple-darwin",
        sha256: HEX,
        path: "/tmp/staged/mla",
        stagedAt: 456,
      },
    };
    expect(parseState(serializeState(state))).toEqual(state);
  });

  it("keeps the base shape and drops a corrupt staged record", () => {
    const raw = JSON.stringify({
      lastCheckedAt: 1,
      latestVersion: "0.5.0",
      staged: { version: "0.5.0" }, // missing required fields
    });
    expect(parseState(raw)).toEqual({ lastCheckedAt: 1, latestVersion: "0.5.0" });
  });

  it("still parses a pre-manifest cache to exactly the two original fields", () => {
    expect(parseState(JSON.stringify({ lastCheckedAt: 9, latestVersion: "0.4.0" }))).toEqual({
      lastCheckedAt: 9,
      latestVersion: "0.4.0",
    });
  });
});

describe("DEFAULT_MANIFEST_URL", () => {
  it("points at the public release bucket (eval-host drift guard)", () => {
    expect(DEFAULT_MANIFEST_URL).toBe(
      "https://storage.googleapis.com/meetless-public/cli/releases/latest/manifest.json",
    );
  });
});
