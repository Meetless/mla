import { buildInitConfig } from "../../src/commands/init";
import type { CliConfig } from "../../src/lib/config";

// Behavioral lock for `mla init` config assembly (folder = workspace, T3.1,
// notes/20260604-folder-equals-workspace-binding-design.md).
//
// The folder-equals-workspace cutover means the machine-global cli-config no
// longer carries a workspace binding: the workspaceId is resolved per-folder
// from the nearest `.meetless.json` marker. So `mla init` must STOP writing a
// workspaceId into cli-config.json (it used to default it to `ws_an_local`).
//
// buildInitConfig is the pure assembly seam used by runInit; pinning it here
// proves the written config never carries a workspaceId, including the case
// where a stale pre-cutover config on disk still has one (it must be dropped,
// not inherited).

describe("buildInitConfig (mla init, T3.1: no workspaceId)", () => {
  it("writes no workspaceId on a fresh config", () => {
    const cfg = buildInitConfig({ controlToken: "T" }, null);
    expect(cfg.controlToken).toBe("T");
    expect("workspaceId" in cfg).toBe(false);
  });

  it("applies the hosted prod defaults for control/intel urls", () => {
    // Decision (2026-06-20): a fresh `mla init` points at the prod backend with
    // zero flags; staging/local is an explicit opt-in via flags or env vars.
    const cfg = buildInitConfig({ controlToken: "T" }, null);
    expect(cfg.controlUrl).toBe("https://control.meetless.ai");
    expect(cfg.intelUrl).toBe("https://intel.meetless.ai");
    expect(cfg.mlaPath).toBeTruthy();
  });

  it("does NOT inherit a stale workspaceId from a pre-cutover prior config", () => {
    // An old cli-config.json (written before T3.1) still carries a
    // workspaceId. A re-run of `mla init` must NOT carry it forward; the
    // field is dropped so the marker is the only workspace source.
    const prior = {
      controlUrl: "http://example:3006",
      controlToken: "OLD",
      intelUrl: "http://example:8100",
      mlaPath: "/old/mla",
      workspaceId: "ws_stale",
    } as CliConfig;

    const cfg = buildInitConfig({ controlToken: "NEW" }, prior);

    expect("workspaceId" in cfg).toBe(false);
    // Token override still works (rotate-on-rerun); other fields inherit.
    expect(cfg.controlToken).toBe("NEW");
    expect(cfg.controlUrl).toBe("http://example:3006");
    expect(cfg.intelUrl).toBe("http://example:8100");
  });

  it("defaults to auth.mode 'none' on a fresh, tokenless init (§6.4)", () => {
    // The interactive path is `mla init` (machine wired, logged OUT) then
    // `mla login`. A tokenless first run must assemble the 'none' auth, not
    // demand --control-token. The derived shared-key projection is "".
    const cfg = buildInitConfig({}, null);
    expect(cfg.auth).toEqual({ mode: "none" });
    expect(cfg.controlToken).toBe("");
  });

  it("opts in to shared-key only when --control-token is passed", () => {
    const cfg = buildInitConfig({ controlToken: "T" }, null);
    expect(cfg.auth).toEqual({ mode: "shared-key", accessToken: "T" });
    expect(cfg.controlToken).toBe("T");
  });

  it("preserves a live user-token on a tokenless re-run (no downgrade to none)", () => {
    // The critical safety property: re-running `mla init` over a browser login
    // must NOT log the operator out. buildInitConfig inherits prior.auth verbatim.
    const prior = {
      controlUrl: "http://x:3006",
      controlToken: "at_1",
      intelUrl: "http://x:8100",
      mlaPath: "/m/mla",
      auth: {
        mode: "user-token",
        accessToken: "at_1",
        refreshToken: "rt_1",
        accessExpiresAt: "2030-01-01T00:00:00.000Z",
        refreshExpiresAt: "2030-02-01T00:00:00.000Z",
        sessionId: "s_1",
        user: { id: "u_1", displayName: "An", email: null, role: "OWNER" },
      },
    } as unknown as CliConfig;

    const cfg = buildInitConfig({}, prior);

    expect(cfg.auth.mode).toBe("user-token");
    expect(cfg.controlToken).toBe("at_1");
  });

  it("inherits controlUrl, intelUrl, and actorUserId from prior when flags omit them", () => {
    const prior = {
      controlUrl: "http://inherited:3006",
      controlToken: "KEEP",
      intelUrl: "http://inherited:8100",
      mlaPath: "/x/mla",
      actorUserId: "user_42",
    } as CliConfig;

    const cfg = buildInitConfig({}, prior);

    expect(cfg.controlUrl).toBe("http://inherited:3006");
    expect(cfg.controlToken).toBe("KEEP");
    expect(cfg.intelUrl).toBe("http://inherited:8100");
    expect(cfg.actorUserId).toBe("user_42");
    expect("workspaceId" in cfg).toBe(false);
  });
});
