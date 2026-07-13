import {
  renderCaptureAndWiringLines,
  wiringNeedsRestart,
  BootstrapResult,
} from "../../src/commands/activate";
import { WireResult, McpServerAction } from "../../src/lib/wire";

// `mla activate` ends by printing two independent facts: is capture running, and did the
// self-heal just install wiring that Claude Code only loads at session start. They used
// to be printed by two branches that could not see each other, which produced this, three
// lines apart, in one real run:
//
//     Capture is active NOW for this session (6bba7648); no restart needed.
//     Installed the Meetless wiring (...). Restart Claude Code once to load it into this session.
//
// Each line was true of a different thing. Together they are a flat self-negation, and the
// operator cannot act on them. These tests pin the PAIR, not either line alone.

function wired(opts: {
  hooksAdded?: string[];
  mcp?: McpServerAction;
}): WireResult {
  return {
    copied: ["capture.sh"],
    hooksAdded: opts.hooksAdded ?? [],
    settingsPath: "/home/u/.claude/settings.json",
    skillDir: "/home/u/.claude/skills/mla",
    onboardSkillDir: "/home/u/.claude/skills/mla-onboard",
    scoutAgents: ["meetless-doc-scout", "meetless-history-scout"],
    flock: { ok: true, detail: "flock present" },
    projectRules: null,
    mcp: { path: "/home/u/.claude.json", action: opts.mcp ?? "unchanged" },
  };
}

const CAPTURED: BootstrapResult = {
  ok: true,
  sessionId: "6bba7648-1ae6-4f2e",
  detail: "ok",
};
const NOT_CAPTURED: BootstrapResult = {
  ok: false,
  sessionId: "6bba7648-1ae6-4f2e",
  detail: "hooks not installed",
};
const NO_SESSION: BootstrapResult = {
  ok: false,
  detail: "not inside a Claude Code session (CLAUDE_CODE_SESSION_ID unset)",
};

describe("wiringNeedsRestart", () => {
  it("is false when nothing was wired at all", () => {
    expect(wiringNeedsRestart(null)).toBe(false);
  });

  it("is false for an idempotent re-wire of an already wired home", () => {
    expect(wiringNeedsRestart(wired({ mcp: "unchanged" }))).toBe(false);
    expect(wiringNeedsRestart(wired({ mcp: "skipped" }))).toBe(false);
  });

  it("is true when a hook event was newly added", () => {
    expect(wiringNeedsRestart(wired({ hooksAdded: ["PreToolUse"] }))).toBe(true);
  });

  it("is true when the MCP entry was freshly written", () => {
    expect(wiringNeedsRestart(wired({ mcp: "added" }))).toBe(true);
  });
});

describe("activate never promises 'no restart' and demands a restart in the same breath", () => {
  it("REGRESSION: capture live + fresh wiring must not print both claims", () => {
    const out = renderCaptureAndWiringLines({
      boot: CAPTURED,
      installedWiring: true,
      inSession: true,
    }).join("\n");

    // The exact pair that shipped. If both of these ever hold again, the operator is
    // being told to restart and told they do not need to, in one screenful.
    const promisesNoRestart = /no restart needed/.test(out);
    const demandsRestart = /restart once/i.test(out);
    expect(promisesNoRestart && demandsRestart).toBe(false);

    // The honest version: capture is stated without the false absolution, and the
    // restart names what it is for and what it does not disturb.
    expect(out).toContain("Capture is active NOW for this session (6bba7648).");
    expect(out).not.toContain("no restart needed");
    expect(out).toContain("restart once to pick up the tools and scout agents");
    expect(out).toContain(
      "Capture for this session is already running; the restart does not interrupt it.",
    );
  });

  it("keeps 'no restart needed' when nothing is about to ask for one", () => {
    const out = renderCaptureAndWiringLines({
      boot: CAPTURED,
      installedWiring: false,
      inSession: true,
    }).join("\n");

    expect(out).toContain(
      "Capture is active NOW for this session (6bba7648); no restart needed.",
    );
    expect(out).not.toMatch(/restart once/i);
    // No wiring was installed, so it must not be announced.
    expect(out).not.toContain("Installed the Meetless wiring");
  });

  it("capture dead + fresh wiring: one restart, no capture-is-fine reassurance", () => {
    const out = renderCaptureAndWiringLines({
      boot: NOT_CAPTURED,
      installedWiring: true,
      inSession: true,
    }).join("\n");

    expect(out).toContain(
      "Capture takes effect on the NEXT Claude Code session started from this folder.",
    );
    expect(out).toContain("(current session not bootstrapped: hooks not installed)");
    expect(out).toContain("restart once to pick up the tools and scout agents");
    // Capture is NOT running, so the "already running" reassurance would be a lie.
    expect(out).not.toContain("already running");
  });

  it("bare terminal (no session): promises an automatic load, never a restart", () => {
    const out = renderCaptureAndWiringLines({
      boot: NO_SESSION,
      installedWiring: true,
      inSession: false,
    }).join("\n");

    expect(out).toContain(
      "It loads automatically the next time you open Claude Code.",
    );
    expect(out).not.toMatch(/restart/i);
    // Nothing to explain: a plain terminal invocation was never in a session.
    expect(out).not.toContain("current session not bootstrapped");
  });

  it("writing-style guard: no em dash or double dash in any branch", () => {
    for (const boot of [CAPTURED, NOT_CAPTURED, NO_SESSION]) {
      for (const installedWiring of [true, false]) {
        const out = renderCaptureAndWiringLines({
          boot,
          installedWiring,
          inSession: !!boot.sessionId,
        }).join("\n");
        expect(out).not.toContain("—");
        expect(out).not.toMatch(/ -- /);
      }
    }
  });
});
