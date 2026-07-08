import { resolveBundlePrincipal } from "../../../src/lib/rules/bundle-principal";
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
