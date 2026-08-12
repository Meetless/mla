import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

/**
 * The injected context must carry exactly one authoritative clock.
 *
 * 2026-08-05: the floor block carried a rule whose TEXT ends "...do not repeatedly
 * retry. Verified 2026-08-04." An agent reading that block has no independent clock,
 * took the provenance date as the current date, and shipped it into two note
 * filenames (silently breaking the `YYYYMMDD-` floor rule while appearing to obey
 * it), two note bodies, three commit messages, a tool docstring, a memory file, and
 * one FALSE ordering claim in a draft email to a customer: it said a user's first
 * servable document arrived after all 338 of his questions when it precedes 7 of
 * them. Corrected in notes 87154689.
 *
 * The date cannot be baked into the rendered floor block: `scan.ts` caches
 * `floorRulesXml` and the hot-path hook reads it back with jq, so a date rendered at
 * scan time would be served on later days as a CONFIDENTLY WRONG clock, which is
 * strictly worse than the original defect. It belongs in `build_layer1`, which the
 * shell rebuilds from scratch every turn.
 */
describe("user-prompt-submit injects the real current date (D1)", () => {
  /** The hook prints a JSON envelope; the injected text is the escaped string inside it. */
  function contextOf(stdout: string): string {
    return JSON.parse(stdout).hookSpecificOutput.additionalContext as string;
  }

  /**
   * LOCAL, not UTC. `toISOString()` disagrees with the hook for the whole evening in
   * a negative offset (this test first failed at 22:55 EDT, expecting 08-06 against an
   * emitted 08-05). Local is the correct clock: the floor rule that this incident broke
   * is about naming a note `YYYYMMDD-`, which means the human's day, not Greenwich's.
   */
  function localToday(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function runHook(): string {
    const home = mkdtempSync(join(tmpdir(), "mlhome-"));
    const repo = mkdtempSync(join(tmpdir(), "repo-"));
    writeFileSync(join(repo, ".meetless.json"), JSON.stringify({ workspaceId: "ws_1" }));
    mkdirSync(join(home, "logs"), { recursive: true });
    writeFileSync(
      join(home, "cli-config.json"),
      JSON.stringify({ workspaceId: "ws_1", actorUserId: "user_a", intelUrl: "http://127.0.0.1:8100" }),
    );
    const hook = join(__dirname, "../../src/hooks-template/user-prompt-submit.sh");
    const r = spawnSync("bash", [hook], {
      input: JSON.stringify({ session_id: "sess_date", prompt: "what changed today", cwd: repo }),
      encoding: "utf8",
      cwd: repo,
      env: { ...process.env, MEETLESS_HOME: home, HOME: home },
      timeout: 15000,
    });
    expect(r.status).toBe(0);
    return r.stdout ?? "";
  }

  it("emits today's REAL date, not a date borrowed from any rule text", () => {
    const ctx = contextOf(runHook());
    expect(ctx).toContain(`today: ${localToday()}`);
  });

  it("labels the clock as local with its zone, so it is not silently read as UTC", () => {
    const ctx = contextOf(runHook());
    expect(ctx).toMatch(/today: \d{4}-\d{2}-\d{2} local \(\S+\)/);
  });

  it("puts the clock in the per-turn static block, never in the cached floor block", () => {
    const ctx = contextOf(runHook());

    const staticStart = ctx.indexOf('<meetless-context kind="static"');
    // Non-vacuous: the earlier draft of this test sliced the RAW JSON, where the
    // quotes are escaped, so indexOf returned -1 and the floor assertion below
    // passed against an empty string.
    expect(staticStart).toBeGreaterThanOrEqual(0);
    const staticBlock = ctx.slice(staticStart, ctx.indexOf("</meetless-context>", staticStart));
    expect(staticBlock).toContain("today: ");

    // The floor block is pre-rendered at scan time and cached in `floorRulesXml`. A
    // date rendered in there is served on later days as a confidently wrong clock,
    // which is strictly worse than carrying none.
    const floorStart = ctx.indexOf('<meetless-context kind="floor-rules"');
    if (floorStart >= 0) {
      const floorBlock = ctx.slice(floorStart, ctx.indexOf("</meetless-context>", floorStart));
      expect(floorBlock).not.toContain("today: ");
    }
  });

  it("tells the reader that dates inside rules and evidence are provenance, not now", () => {
    const ctx = contextOf(runHook());
    // Without this the agent still holds two date-shaped strings and no rule for
    // ranking them, which is the exact ambiguity that caused the incident.
    expect(ctx).toMatch(/provenance/i);
    expect(ctx).toMatch(/NOT (the current date|today)/i);
  });
});
