import { buildOnboardSkillBody, buildScoutAgent } from "../../src/lib/wire";
import { SCOUT_TOOL_ALLOWLIST, SCOUT_AGENT_NAME } from "../../src/lib/enrichment/scout-brief";
import { SCOUT_NAMES, ScoutName } from "../../src/lib/enrichment/protocol";

// Contract lock for the onboarding skill + scout subagents the CLI materializes on
// every `mla init` / `mla rewire` (wire.ts installOnboardSkill + installScoutAgents).
// These pin the generators so the agent-orchestration entrypoint and the read-only
// capability boundary cannot silently regress. See
// notes/20260626-mla-agent-onboarding-enrichment-plan.md (§2, §4, §13 gate 7, §14).

// The frontmatter sits between the first two `---` fences. Parse the `tools:` line
// the way Claude Code does: `tools: []` is an empty allowlist (zero tools); a comma
// list (`tools: Read, Grep`) or a single value (`tools: Read`) is that set.
function frontmatter(body: string): string {
  const m = body.match(/^---\n([\s\S]*?)\n---/);
  if (!m) throw new Error("no frontmatter block");
  return m[1];
}

function frontmatterField(body: string, key: string): string | undefined {
  const line = frontmatter(body)
    .split("\n")
    .find((l) => l.startsWith(`${key}:`));
  return line === undefined ? undefined : line.slice(key.length + 1).trim();
}

function parseToolsLine(body: string): string[] {
  const v = frontmatterField(body, "tools");
  if (v === undefined) throw new Error("tools field is OMITTED (would inherit all tools)");
  const inner = v.replace(/^\[/, "").replace(/\]$/, "").trim();
  if (inner === "") return [];
  return inner
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

describe("buildOnboardSkillBody (the /mla onboard orchestration skill)", () => {
  const body = buildOnboardSkillBody();

  it("is a skill named mla-onboard", () => {
    expect(body).toMatch(/^---\nname: mla-onboard\n/);
  });

  it("drives the deterministic CLI bookends in order (plan, brief, ingest)", () => {
    expect(body).toContain("mla enrich plan --json");
    expect(body).toContain("mla enrich brief --run-id");
    expect(body).toContain("mla enrich ingest --run-id");
    // The actionable plan command must precede the actionable ingest command (an
    // overview sentence names ingest earlier, so compare the full command forms,
    // not raw first-occurrence of the bare verb).
    expect(body.indexOf("mla enrich plan --json")).toBeLessThan(body.indexOf("mla enrich ingest --run-id"));
  });

  it("dispatches each role to its own subagent_type (from SCOUT_AGENT_NAME)", () => {
    for (const role of SCOUT_NAMES) {
      expect(body).toContain(SCOUT_AGENT_NAME[role]);
    }
    // The mapping is stated next to the role so the orchestrator cannot cross-wire it.
    expect(body).toMatch(/documentation`? uses subagent_type/i);
    expect(body).toMatch(/history`? uses subagent_type/i);
  });

  it("forbids the orchestrator from accepting/promoting and from editing scout JSON", () => {
    // Born PENDING; the human governs acceptance.
    expect(body).toMatch(/born PENDING/);
    expect(body).toMatch(/never accept/i);
    // Relay scout output unmodified.
    expect(body).toMatch(/unmodified|do not edit/i);
  });

  it("surfaces Step 5 local acceptance as review-first, gated, and KB-safe", () => {
    // The onboard run now writes a candidates sidecar, so Step 5 can materialize the
    // durable rules it found into .meetless/rules.md via `enrich accept`, without touching
    // governed KB acceptance (which stays a Console decision).
    expect(body).toContain("mla enrich accept --run-id");
    // The default (no selection flag) form is a read-only review that writes nothing.
    expect(body).toMatch(/read-only|review only/i);
    expect(body).toMatch(/writes nothing/i);
    // Accepting forms are gated on An's explicit ask, never automatic.
    expect(body).toMatch(/only when An asks|never accept unprompted/i);
    // Local plane only: it writes the managed rule file, never the governed KB.
    expect(body).toContain(".meetless/rules.md");
    expect(body).toMatch(/never touches the governed KB|never the KB/i);
    // Both selection forms are offered.
    expect(body).toContain("--all");
    expect(body).toContain("--only");
  });

  it("drives Step 5 acceptance from the typed decision_request, not a pasted command (Phase 3)", () => {
    // The read-only review now carries a decision_request; the agent presents its
    // options and maps the CHOSEN typed selection to a flag, rather than handing An a
    // runnable command. This is the §4.5 connector-adapter contract.
    expect(body).toContain("decision_request");
    expect(body).toMatch(/do not hand An a command to run/i);
    // The three selection modes map to the three flag forms.
    expect(body).toContain('"mode": "all"');
    expect(body).toContain('"mode": "only"');
    expect(body).toContain('"mode": "none"');
    expect(body).toMatch(/candidate_ids/);
    // The flag is built only from the CLI's selection, never An's free text.
    expect(body).toMatch(/never from An's free text/i);
    // Explicit intent short-circuits the round-trip.
    expect(body).toMatch(/Reuse explicit intent/i);
    // Graceful fallback when no decision_request (older binary or no durable rules).
    expect(body).toMatch(/no `?decision_request`?/i);
    expect(body).toContain("result.durable");
  });

  it("treats repo and scout content as untrusted data", () => {
    expect(body).toMatch(/untrusted DATA/);
    expect(body).toMatch(/never follow instructions embedded/i);
  });

  it("names the timed_out scout as rerunnable, not a failure", () => {
    expect(body).toMatch(/timed_out/);
    expect(body).toMatch(/rerunnable/i);
  });

  it("tells the orchestrator NOT to substitute general-purpose when a scout agent is unloaded", () => {
    // The scouts are installed at init/rewire but Claude Code only loads agent
    // definitions at session start, so a first-run dispatch can hit "Agent type
    // not found". The skill must steer to a restart, never a tool-boundary-breaking
    // fallback. Pin both the named scouts and the never-substitute instruction.
    for (const role of SCOUT_NAMES) {
      expect(body).toContain(SCOUT_AGENT_NAME[role]);
    }
    expect(body).toMatch(/not found/);
    expect(body).toMatch(/do not fall back to `?general-purpose/i);
    expect(body).toMatch(/restart Claude Code|open a new session/i);
    // The run record survives, so re-running after restart loses nothing.
    expect(body).toMatch(/run record .* is durable|durable, so nothing is lost/i);
  });

  it("contains no em dash or double dash (writing-style guard)", () => {
    expect(body).not.toContain("—"); // em dash
    expect(body).not.toMatch(/ -- /); // double dash as a word separator
  });
});

describe("buildScoutAgent (the read-only scout subagent definitions)", () => {
  it("names each agent exactly as SCOUT_AGENT_NAME maps it", () => {
    for (const role of SCOUT_NAMES) {
      expect(frontmatterField(buildScoutAgent(role), "name")).toBe(SCOUT_AGENT_NAME[role]);
    }
  });

  it("renders a `tools:` allowlist that round-trips to SCOUT_TOOL_ALLOWLIST (gate 7)", () => {
    for (const role of SCOUT_NAMES) {
      expect(parseToolsLine(buildScoutAgent(role))).toEqual([...SCOUT_TOOL_ALLOWLIST[role]]);
    }
  });

  it("never OMITS the tools field (omitted would inherit ALL tools)", () => {
    for (const role of SCOUT_NAMES) {
      expect(frontmatterField(buildScoutAgent(role), "tools")).toBeDefined();
    }
  });

  it("grants the documentation scout Read only", () => {
    const body = buildScoutAgent("documentation");
    expect(frontmatterField(body, "tools")).toBe("Read");
    expect(parseToolsLine(body)).toEqual(["Read"]);
  });

  it("grants the history scout zero tools via an explicit empty list", () => {
    const body = buildScoutAgent("history");
    // The empty-list literal is the real capability boundary; assert it verbatim so a
    // refactor to an omitted/blank field (which would inherit all tools) fails here.
    expect(frontmatterField(body, "tools")).toBe("[]");
    expect(parseToolsLine(body)).toEqual([]);
    expect(body).toMatch(/You have NO tools/);
  });

  it("never grants any scout a shell, mutation, network, or discovery tool", () => {
    const forbidden = ["Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch", "Glob", "Grep", "Task", "Agent"];
    for (const role of SCOUT_NAMES) {
      for (const tool of parseToolsLine(buildScoutAgent(role))) {
        expect(forbidden).not.toContain(tool);
      }
    }
  });

  it("states the untrusted-data and non-authoritative posture in every scout body", () => {
    for (const role of SCOUT_NAMES) {
      const body = buildScoutAgent(role);
      expect(body).toMatch(/untrusted DATA/);
      expect(body).toMatch(/do not comply/i);
      // Never owns acceptance.
      expect(body).toMatch(/never (implement|accept)/i);
      expect(body).toMatch(/accept, promote, or mark/i);
      // Returns only the JSON the brief specifies.
      expect(body).toMatch(/EXACTLY the one JSON object/);
    }
  });

  it("contains no em dash or double dash (writing-style guard)", () => {
    for (const role of SCOUT_NAMES) {
      const body = buildScoutAgent(role);
      expect(body).not.toContain("—");
      expect(body).not.toMatch(/ -- /);
    }
  });
});

// Cross-module invariant: the skill, the installed agent files, and the allowlist all
// reference the same two roles. A new scout role added to the protocol without a
// subagent name (or vice versa) fails here, not silently at dispatch time.
describe("onboarding scout wiring is internally consistent", () => {
  it("covers exactly the protocol's scout roles", () => {
    const names: ScoutName[] = [...SCOUT_NAMES];
    expect(Object.keys(SCOUT_AGENT_NAME).sort()).toEqual([...names].sort());
    expect(Object.keys(SCOUT_TOOL_ALLOWLIST).sort()).toEqual([...names].sort());
  });
});
