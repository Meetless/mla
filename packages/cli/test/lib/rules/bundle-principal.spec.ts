import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  principalIndexPath,
  recordBundlePrincipal,
  resolveBundlePrincipal,
} from "../../../src/lib/rules/bundle-principal";
import type { CliConfig } from "../../../src/lib/config";

// The offline principal resolver must mirror control's server-side stamping EXACTLY, or
// the bundle cache's principal-binding guard rejects every fetched bundle. projectId is
// always null (no CLI project activation). Throw-free: a config error degrades to a null
// principal so the UserPromptSubmit scan never crashes.

function cfg(over: Partial<CliConfig> = {}): CliConfig {
  return {
    controlUrl: "https://control.test",
    controlToken: "tok",
    auth: { mode: "shared-key", accessToken: "tok" },
    ...over,
  } as CliConfig;
}

describe("resolveBundlePrincipal", () => {
  it("resolves the authenticated user's id under a user-token session", () => {
    const userToken = cfg({
      auth: {
        mode: "user-token",
        accessToken: "a",
        refreshToken: "r",
        accessExpiresAt: "2026-06-29T00:00:00.000Z",
        refreshExpiresAt: "2026-07-28T00:00:00.000Z",
        sessionId: "sess_1",
        user: { id: "user_1", displayName: "An", email: null, role: "admin" },
      },
    });
    expect(resolveBundlePrincipal("ws_1", () => userToken)).toEqual({
      workspaceId: "ws_1",
      principalUserId: "user_1",
      projectId: null,
    });
  });

  it("resolves a null principal under shared-key (headless), matching the _shared bundle", () => {
    expect(resolveBundlePrincipal("ws_1", () => cfg())).toEqual({
      workspaceId: "ws_1",
      principalUserId: null,
      projectId: null,
    });
  });

  it("resolves a null principal under the logged-out 'none' mode", () => {
    const none = cfg({ controlToken: "", auth: { mode: "none" } });
    expect(resolveBundlePrincipal("ws_1", () => none)).toEqual({
      workspaceId: "ws_1",
      principalUserId: null,
      projectId: null,
    });
  });

  it("degrades to a null principal (never throws) when the config read fails", () => {
    const throwing = () => {
      throw new Error("MEETLESS_CONTROL_TOKEN rejected under an on-disk user-token");
    };
    expect(resolveBundlePrincipal("ws_2", throwing)).toEqual({
      workspaceId: "ws_2",
      principalUserId: null,
      projectId: null,
    });
  });
});

// The foreign-workspace fix: for a `.meetless.json` marker bound to a NON-home workspace,
// control stamps bundle.principalUserId = the per-workspace WorkspaceUser id, which differs
// from the home auth.user.id. The offline readers cannot re-derive it, so the fetch vehicle
// records it and the resolver reads it back. These pin that learned mapping, hermetically:
// each test uses its own tmp $home via the injectable `opts.home` seam, so nothing touches
// the operator's real ~/.meetless.
describe("recordBundlePrincipal / resolveBundlePrincipal index round-trip", () => {
  let home: string;

  function userToken(homeUserId: string): () => CliConfig {
    return () =>
      cfg({
        auth: {
          mode: "user-token",
          accessToken: "a",
          refreshToken: "r",
          accessExpiresAt: "2026-06-29T00:00:00.000Z",
          refreshExpiresAt: "2026-07-28T00:00:00.000Z",
          sessionId: "sess_1",
          user: { id: homeUserId, displayName: "An", email: null, role: "admin" },
        },
      });
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "principal-index-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("resolves the control-stamped foreign-workspace principal once recorded", () => {
    const read = userToken("home_bob"); // Bob's HOME id
    // Before any sync, a foreign workspace falls back to the home id (honest, and the read
    // path will reject it as 'unavailable' since it mismatches the bundle's stamp).
    expect(resolveBundlePrincipal("ws_a", read, { home }).principalUserId).toBe("home_bob");
    // The fetch vehicle learns control's per-workspace id for ws_a.
    recordBundlePrincipal("ws_a", "wu_bob_in_ws_a", read, { home });
    expect(resolveBundlePrincipal("ws_a", read, { home })).toEqual({
      workspaceId: "ws_a",
      principalUserId: "wu_bob_in_ws_a",
      projectId: null,
    });
    // A DIFFERENT unsynced workspace still falls back to the home id (e.g. the home ws).
    expect(resolveBundlePrincipal("ws_home", read, { home }).principalUserId).toBe("home_bob");
  });

  it("keys the index by the home identity so a re-login as another human never leaks it", () => {
    recordBundlePrincipal("ws_a", "wu_bob_in_ws_a", userToken("home_bob"), { home });
    // A different human logs in on the SAME $home. They read under their own home id, find
    // no entry, and fall back to their own home id -- never Bob's recorded principal.
    expect(
      resolveBundlePrincipal("ws_a", userToken("home_carol"), { home }).principalUserId,
    ).toBe("home_carol");
  });

  it("is a no-op for a shared-key session (headless has no per-workspace human)", () => {
    recordBundlePrincipal("ws_a", "wu_x", () => cfg(), { home });
    expect(fs.existsSync(principalIndexPath(home))).toBe(false);
  });

  it("is a no-op when the stamped principal is null (a headless bundle)", () => {
    recordBundlePrincipal("ws_a", null, userToken("home_bob"), { home });
    expect(fs.existsSync(principalIndexPath(home))).toBe(false);
  });

  it("never throws when the index write fails, leaving the resolver on the home-id fallback", () => {
    // Make the rules/ path a FILE so mkdir/write under it fails; record must swallow it.
    fs.writeFileSync(path.join(home, "rules"), "not a dir");
    const read = userToken("home_bob");
    expect(() => recordBundlePrincipal("ws_a", "wu_bob_in_ws_a", read, { home })).not.toThrow();
    // The unreadable index degrades to empty, so the resolver falls back to the home id.
    expect(resolveBundlePrincipal("ws_a", read, { home }).principalUserId).toBe("home_bob");
  });

  it("stores the sidecar 0600 beside the bundle cache, never as a bundle-*.json file", () => {
    recordBundlePrincipal("ws_a", "wu_bob_in_ws_a", userToken("home_bob"), { home });
    const file = principalIndexPath(home);
    expect(file).toBe(path.join(home, "rules", "principal-index.json"));
    expect(path.basename(file).startsWith("bundle-")).toBe(false);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});
