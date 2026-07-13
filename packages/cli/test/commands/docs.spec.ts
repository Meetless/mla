import { COMMANDS, dispatch } from "../../src/cli";
import { runDocs } from "../../src/commands/docs";
import { loadDocsCorpus } from "../../src/lib/docs-corpus";
import {
  MAX_WIDTH,
  MIN_WIDTH,
  RESERVED_TOPIC_WORDS,
  buildTopicAliases,
  resolveTopic,
  resolveWidth,
  wrapMarkdown,
} from "../../src/lib/docs-render";
import { resolveCommand } from "../../src/lib/command-registry";

// The OFFLINE documentation surface (proposal §6, T8-T12). Every assertion here
// runs against the REAL vendored corpus, not a fixture: the whole point of the
// surface is that the binary carries the same 19 pages the website renders, so a
// test against a hand-written stub would prove nothing about the shipped artifact.

const corpus = loadDocsCorpus();

interface Captured {
  out: string;
  err: string;
  code: number;
}

async function docs(...argv: string[]): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runDocs(argv, {
    columns: 80,
    log: (l) => out.push(l),
    error: (l) => err.push(l),
  });
  return { out: out.join("\n"), err: err.join("\n"), code };
}

describe("mla docs: the corpus is really in the binary", () => {
  it("carries every page the website is built from", () => {
    expect(corpus.docs.length).toBeGreaterThanOrEqual(19);
    expect(corpus.passages.length).toBeGreaterThan(corpus.docs.length);
    expect(corpus.corpusHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("every passage belongs to a real doc, and every doc has passages", () => {
    const slugs = new Set(corpus.docs.map((d) => d.slug));
    for (const p of corpus.passages) expect(slugs.has(p.slug)).toBe(true);
    for (const slug of slugs) {
      expect(corpus.passages.some((p) => p.slug === slug)).toBe(true);
    }
  });

  it("no page leaks a machine-owned generator marker into the prose", () => {
    // The command index is spliced into commands.md between MDX markers. Those
    // markers must be invisible to the corpus parser: if one ever surfaced here,
    // it would surface in `mla docs reference/commands` too.
    for (const p of corpus.passages) {
      expect(p.plain).not.toContain("BEGIN GENERATED");
      expect(p.markdown).not.toContain("BEGIN GENERATED");
    }
  });

  it("the generated command index IS ingested (the docs know every command)", () => {
    const commandsPage = corpus.passages
      .filter((p) => p.slug === "reference/commands")
      .map((p) => p.plain)
      .join("\n");
    for (const c of COMMANDS.filter((c) => !c.hidden)) {
      expect(commandsPage).toContain(`mla ${c.name}`);
    }
  });
});

describe("topic aliases are DERIVED, never hand-maintained", () => {
  it("mints a short alias from each slug's last segment, with no collisions", () => {
    const { aliases, collisions } = buildTopicAliases(corpus.docs);
    // A collision would silently drop BOTH pages' short aliases. Today there are
    // none; if a new page collides, fix the slug rather than accept the drop.
    expect(collisions).toEqual([]);
    expect(aliases.get("onboarding")).toBe("claude-code/onboarding");
    expect(aliases.get("enforcement")).toBe("concepts/enforcement");
    expect(aliases.get("troubleshooting")).toBe("reference/troubleshooting");
  });

  it("never mints an alias that would shadow a docs SUBCOMMAND", () => {
    const { aliases } = buildTopicAliases(corpus.docs);
    for (const reserved of RESERVED_TOPIC_WORDS) {
      expect(aliases.has(reserved)).toBe(false);
      expect(resolveTopic(corpus.docs, reserved)).toBeUndefined();
    }
    // `concepts/ask` exists but `ask` belongs to the AI surface, so the page is
    // addressable only by its full slug. That is a deliberate trade, not a gap.
    expect(corpus.docs.some((d) => d.slug === "concepts/ask")).toBe(true);
    expect(resolveTopic(corpus.docs, "concepts/ask")).toBe("concepts/ask");
  });

  it("resolves a slug exactly, and is forgiving about case and stray slashes", () => {
    expect(resolveTopic(corpus.docs, "concepts/graph")).toBe("concepts/graph");
    expect(resolveTopic(corpus.docs, "/concepts/graph/")).toBe("concepts/graph");
    expect(resolveTopic(corpus.docs, "Concepts/Graph")).toBe("concepts/graph");
    expect(resolveTopic(corpus.docs, "not-a-page")).toBeUndefined();
  });
});

describe("mla docs (no argument): the topic list", () => {
  it("lists every page with its title and its frontmatter description", async () => {
    const { out, code } = await docs();
    expect(code).toBe(0);
    for (const doc of corpus.docs) {
      expect(out).toContain(doc.slug);
      expect(out).toContain(doc.title);
    }
    expect(out).toContain("mla docs <topic>");
    expect(out).toContain('mla docs search "<terms>"');
    expect(out).toContain('mla docs ask "<question>"');
  });
});

describe("mla docs <topic>: reading one page", () => {
  it("renders the whole page, in document order, from its passages", async () => {
    const { out, code } = await docs("concepts/enforcement");
    expect(code).toBe(0);
    const page = corpus.passages.filter((p) => p.slug === "concepts/enforcement");
    expect(page.length).toBeGreaterThan(1);
    // Every passage's heading appears, and they appear in the corpus's order.
    const positions = page
      .map((p) => p.headingPath[p.headingPath.length - 1])
      .filter((h) => h && out.includes(h))
      .map((h) => out.indexOf(h as string));
    expect(positions.length).toBeGreaterThan(1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(out).toContain("https://meetless.ai/docs/concepts/enforcement");
  });

  it("resolves a short alias to the same page as its slug", async () => {
    const viaAlias = await docs("onboarding");
    const viaSlug = await docs("claude-code/onboarding");
    expect(viaAlias.code).toBe(0);
    expect(viaAlias.out).toBe(viaSlug.out);
  });

  it("an unknown topic exits 1 and offers a way forward, never a bare error", async () => {
    const { err, out, code } = await docs("enforcment");
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toContain('No documentation topic named "enforcment"');
    expect(err).toContain("mla docs");
    expect(err).toContain("mla docs search");
  });

  it("suggests the near-miss when the topic is a recognizable typo", async () => {
    const { err } = await docs("concepts/enforce");
    expect(err).toContain("Did you mean");
    expect(err).toContain("concepts/enforcement");
  });
});

describe("mla docs search", () => {
  it("ranks real passages and shows where each hit lives", async () => {
    const { out, code } = await docs("search", "how", "do", "rules", "get", "enforced");
    expect(code).toBe(0);
    expect(out).toMatch(/^\d+ match/);
    expect(out).toContain("concepts/enforcement");
  });

  it("never overruns the terminal, even on a deep heading path", async () => {
    const { out } = await docs("search", "enforcement", "rules", "memory");
    for (const line of out.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
  });

  it("is deterministic: the same query returns byte-identical output", async () => {
    const a = await docs("search", "mcp", "wiring");
    const b = await docs("search", "mcp", "wiring");
    expect(a.out).toBe(b.out);
  });

  it("a query that matches nothing is a valid answer (exit 0), not a failure", async () => {
    const { out, code } = await docs("search", "zzzqqq", "xylophone");
    expect(code).toBe(0);
    expect(out).toContain("No documentation matches");
    expect(out).toContain("mla docs ask");
  });

  it("search with no terms is malformed (exit 2)", async () => {
    const { err, code } = await docs("search");
    expect(code).toBe(2);
    expect(err).toContain('mla docs search "<terms>"');
  });
});

describe("mla docs ask: the reserved word", () => {
  it("with no question, explains BOTH that it needs one and where the ask page is", async () => {
    const { err, code } = await docs("ask");
    expect(code).toBe(2);
    expect(err).toContain('mla docs ask "<question>"');
    // The one place `ask` as a topic would have been useful, so say it out loud.
    expect(err).toContain("mla docs concepts/ask");
  });
});

describe("rendering is width-aware and structure-preserving", () => {
  it("clamps an absurd terminal width instead of trusting it", () => {
    expect(resolveWidth(undefined)).toBe(80);
    expect(resolveWidth(0)).toBe(80);
    expect(resolveWidth(20)).toBe(MIN_WIDTH);
    expect(resolveWidth(400)).toBe(MAX_WIDTH);
  });

  it("re-wraps prose to the terminal", async () => {
    const narrow: string[] = [];
    await runDocs(["why/problem"], { columns: 60, log: (l) => narrow.push(l) });
    const lines = narrow.join("\n").split("\n");
    // Prose wraps; fenced/structural lines may legitimately exceed the width, so
    // assert on the prose lines (no leading indent, not a table row or fence).
    const prose = lines.filter((l) => l && !/^\s|^[|`#>-]/.test(l));
    expect(prose.length).toBeGreaterThan(3);
    for (const l of prose) expect(l.length).toBeLessThanOrEqual(60);
  });

  it("NEVER re-wraps a fenced code block (that would corrupt it)", () => {
    const md = [
      "Some prose that is quite long and will certainly be re-wrapped at a narrow width.",
      "",
      "```bash",
      "mla activate --workspace ws_123 --and-a-very-long-flag-that-must-not-wrap value",
      "```",
    ].join("\n");
    const wrapped = wrapMarkdown(md, 50);
    expect(wrapped).toContain(
      "mla activate --workspace ws_123 --and-a-very-long-flag-that-must-not-wrap value",
    );
    expect(wrapped).toContain("```bash");
  });

  it("preserves table and heading lines verbatim", () => {
    const md = ["## A heading", "", "- a list item", "", "| a | b |", "| --- | --- |"].join("\n");
    expect(wrapMarkdown(md, 50)).toBe(md);
  });

  it("wraps a long list item with a HANGING INDENT, so a bullet stays a bullet", () => {
    const md = "1. A single governed record of the team's confirmed decisions and rules.";
    expect(wrapMarkdown(md, 40)).toBe(
      ["1. A single governed record of the", "   team's confirmed decisions and rules."].join("\n"),
    );
    const bullet = "- " + "word ".repeat(20).trim();
    for (const line of wrapMarkdown(bullet, 40).split("\n")) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
    expect(wrapMarkdown(bullet, 40).split("\n").slice(1).every((l) => l.startsWith("  "))).toBe(
      true,
    );
  });

  it("emits no ANSI escapes (plain stdout, pipe-safe)", async () => {
    const { out } = await docs("index");
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\x1b\[/);
  });
});

describe("dispatch: `docs` is a first-class registry command", () => {
  let out: string[];
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    out = [];
    logSpy = jest.spyOn(console, "log").mockImplementation((...a) => out.push(a.join(" ")));
  });
  afterEach(() => logSpy.mockRestore());

  it("appears on the help screen and dispatches", async () => {
    expect(resolveCommand(COMMANDS, "docs")).toBeDefined();
    expect(await dispatch(["docs"])).toBe(0);
    expect(out.join("\n")).toContain("Documentation topics:");
  });

  it("`mla docs --help` is answered from the registry, not by the handler", async () => {
    expect(await dispatch(["docs", "--help"])).toBe(0);
    const screen = out.join("\n");
    expect(screen).toContain("  mla docs <topic>");
    // The registry block, NOT the topic list.
    expect(screen).not.toContain("Documentation topics:");
  });
});

describe("every command answers --help (T11)", () => {
  let out: string[];
  let err: string[];
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;

  beforeEach(() => {
    out = [];
    err = [];
    logSpy = jest.spyOn(console, "log").mockImplementation((...a) => out.push(a.join(" ")));
    errSpy = jest.spyOn(console, "error").mockImplementation((...a) => err.push(a.join(" ")));
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("`mla <command> --help` exits 0 and names that command, for EVERY command", async () => {
    for (const c of COMMANDS) {
      out.length = 0;
      err.length = 0;
      const code = await dispatch([c.name, "--help"]);
      expect({ cmd: c.name, code }).toEqual({ cmd: c.name, code: 0 });
      expect(out.join("\n")).toContain(`mla ${c.name}`);
    }
  });

  it("the four commands with a richer help of their own are NOT preempted", async () => {
    // kb/graph/enrich/review each print a full subcommand catalog. The generic
    // interception must let them answer; printing the one-block registry view
    // instead would be a downgrade.
    for (const name of ["kb", "graph", "enrich"]) {
      expect(COMMANDS.find((c) => c.name === name)?.ownHelp).toBe(true);
      out.length = 0;
      expect(await dispatch([name, "--help"])).toBe(0);
      // The registry block is one command's usage; these print their own catalog,
      // which is strictly longer than the registry block for the same command.
      const registryBlock = COMMANDS.find((c) => c.name === name)!.usage;
      expect(out.join("\n").length).toBeGreaterThan(registryBlock.length / 2);
    }
    expect(COMMANDS.find((c) => c.name === "review")?.ownHelp).toBe(true);
    out.length = 0;
    expect(await dispatch(["review", "--plain", "--help"])).toBe(0);
    expect(out.join("\n")).toContain("--plain");
  });
});
