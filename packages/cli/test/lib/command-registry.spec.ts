import * as fs from "fs";
import * as path from "path";

import { COMMANDS, dispatch } from "../../src/cli";
import {
  BEGIN_MARKER,
  END_MARKER,
  renderCommandIndex,
  spliceCommandIndex,
} from "../../src/lib/command-reference";
import {
  USAGE_HEADER,
  nearestCommands,
  renderCommandHelp,
  renderUsage,
  resolveCommand,
  wantsLeadingHelp,
} from "../../src/lib/command-registry";
import { DOCS_SUBCOMMANDS } from "../../src/commands/docs";

// T6 parity (proposal §6.3). The registry is not a manifest kept parallel to a
// dispatch switch: it IS the dispatch table (`resolveCommand(COMMANDS, cmd)`) and
// it IS the help screen (`renderUsage(COMMANDS)`). These tests assert exactly what
// that buys us and nothing more.
//
// Scope note (§6.3 correction 2): FLAGS are single-sourced only where help renders
// from the registry. Commands still parse their own flags ad hoc, so there is
// deliberately NO flag-parity assertion here. Asserting one would overclaim.

const HIDDEN = ["cases"];

describe("command registry: shape invariants", () => {
  it("every name and alias is unique across the whole registry", () => {
    const words = COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
    const dupes = words.filter((w, i) => words.indexOf(w) !== i);
    expect(dupes).toEqual([]);
  });

  it("no name or alias could be mistaken for a flag or be empty", () => {
    for (const c of COMMANDS) {
      for (const word of [c.name, ...(c.aliases ?? [])]) {
        expect(word).not.toBe("");
        // A leading `-` would be swallowed by dispatch's flag interception
        // (`--help`, `-h`, `--version`, `-v`) and become undispatchable.
        expect(word.startsWith("-")).toBe(false);
        expect(word).not.toMatch(/\s/);
      }
    }
  });

  it("only the intentional removed-command stubs are hidden", () => {
    // Hidden entries are dispatchable but never printed. Adding one silently
    // creates an undocumented command, so the set is pinned.
    expect(COMMANDS.filter((c) => c.hidden).map((c) => c.name)).toEqual(HIDDEN);
  });

  it("every usage block documents the command it is filed under", () => {
    for (const c of COMMANDS) {
      const first = c.usage.split("\n")[0];
      expect(first).toBe(`  mla ${c.name}${first.slice(`  mla ${c.name}`.length)}`);
    }
  });

  it("usage blocks carry no leading or trailing blank line", () => {
    // renderUsage joins blocks with a single "\n"; a stray blank line at a block
    // boundary would silently reflow the whole help screen.
    for (const c of COMMANDS) {
      expect(c.usage.startsWith("\n")).toBe(false);
      expect(c.usage.endsWith("\n")).toBe(false);
      expect(c.usage.trim()).not.toBe("");
    }
  });
});

describe("command registry: dispatch <-> help parity", () => {
  it("resolveCommand resolves every name and every alias", () => {
    for (const c of COMMANDS) {
      expect(resolveCommand(COMMANDS, c.name)).toBe(c);
      for (const alias of c.aliases ?? []) {
        expect(resolveCommand(COMMANDS, alias)).toBe(c);
      }
    }
  });

  it("resolveCommand returns undefined for a word that is not in the registry", () => {
    expect(resolveCommand(COMMANDS, "definitely-not-a-command")).toBeUndefined();
  });

  it("every VISIBLE command's usage block appears verbatim on the help screen", () => {
    const screen = renderUsage(COMMANDS);
    for (const c of COMMANDS.filter((c) => !c.hidden)) {
      expect(screen).toContain(c.usage);
    }
  });

  it("hidden commands are dispatchable but never printed", () => {
    const screen = renderUsage(COMMANDS);
    for (const name of HIDDEN) {
      expect(resolveCommand(COMMANDS, name)).toBeDefined();
      expect(screen).not.toContain(`  mla ${name}`);
    }
  });

  it("the help screen is exactly the header plus the visible blocks", () => {
    const visible = COMMANDS.filter((c) => !c.hidden);
    expect(renderUsage(COMMANDS)).toBe(
      `${USAGE_HEADER}\n${visible.map((c) => c.usage).join("\n")}\n`,
    );
  });

  it("renderCommandHelp narrows to one block, alias-aware", () => {
    expect(renderCommandHelp(COMMANDS, "graph")).toBe(renderCommandHelp(COMMANDS, "cg"));
    expect(renderCommandHelp(COMMANDS, "doctor")).toContain("  mla doctor");
    expect(renderCommandHelp(COMMANDS, "doctor")).not.toContain("  mla status");
    expect(renderCommandHelp(COMMANDS, "definitely-not-a-command")).toBeUndefined();
  });
});

describe("dispatch: the registry is the dispatch table", () => {
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

  it("a word that is not in the registry is the ONE unknown-command error, and it does NOT dump the catalog", async () => {
    const code = await dispatch(["definitely-not-a-command"]);
    expect(code).toBe(2);
    const text = err.join("\n");
    expect(text).toContain("Unknown command: definitely-not-a-command");
    // Proposal §3 bug 1: the error path must NOT be a command emitter. It points
    // at `mla help` for the full catalog instead of pasting it back.
    expect(text).toContain("Run 'mla help' for the full command list.");
    expect(text).not.toContain(USAGE_HEADER);
  });

  it("a near-miss command name gets a concise 'did you mean', not the catalog", async () => {
    // `doctorr` is one insertion from the real `doctor`.
    const code = await dispatch(["doctorr"]);
    expect(code).toBe(2);
    const text = err.join("\n");
    expect(text).toContain("Unknown command: doctorr");
    expect(text).toContain("Did you mean:");
    expect(text).toContain("doctor");
    expect(text).not.toContain(USAGE_HEADER);
  });

  it("`onboard` is named as a skill, not treated as a typo or dumped as a catalog", async () => {
    const code = await dispatch(["onboard"]);
    expect(code).toBe(2);
    const text = err.join("\n");
    // Proposal §3 bug 2: exactly one line, naming the skill. No 'did you mean',
    // no catalog. `onboard` is deliberately NOT registered in COMMANDS.
    expect(text).toBe(
      "onboard is an agent skill, not a CLI command; in your coding agent, run /mla onboard",
    );
    expect(resolveCommand(COMMANDS, "onboard")).toBeUndefined();
  });

  it("`mla help <command>` narrows; an unknown command falls back to the full screen", async () => {
    expect(await dispatch(["help", "doctor"])).toBe(0);
    expect(out.join("\n")).toContain("  mla doctor");
    expect(out.join("\n")).not.toContain("  mla status");

    out.length = 0;
    // `help` must never error, even on a bogus argument.
    expect(await dispatch(["help", "definitely-not-a-command"])).toBe(0);
    expect(out.join("\n")).toBe(renderUsage(COMMANDS));
  });

  it("bare `mla`, `mla help`, `mla --help` and `mla -h` all print the SAME screen", async () => {
    const screens: string[] = [];
    for (const argv of [[], ["help"], ["--help"], ["-h"]]) {
      out.length = 0;
      expect(await dispatch(argv)).toBe(0);
      screens.push(out.join("\n"));
    }
    expect(new Set(screens).size).toBe(1);
    expect(screens[0]).toBe(renderUsage(COMMANDS));
  });

  it("`mla docs --help` and `mla docs ask --help` print the registry's docs block", async () => {
    // `docs` owns its help (it takes free text), so it answers these itself. The
    // screen must still be the registry block, byte for byte: a second, hand-written
    // help view for one command is exactly the drift this registry exists to kill.
    for (const argv of [
      ["docs", "--help"],
      ["docs", "-h"],
      ["docs", "ask", "--help"],
      ["docs", "search", "-h"],
    ]) {
      out.length = 0;
      expect(await dispatch(argv)).toBe(0);
      expect(out.join("\n")).toBe(renderCommandHelp(COMMANDS, "docs"));
    }
  });
});

describe("wantsLeadingHelp: a help flag inside free text is not a plea for help", () => {
  // The bug this closes: the dispatcher's generic scan matched `--help`/`-h`
  // ANYWHERE in the args, so `mla docs ask what does -h do` printed the help screen
  // instead of answering the question. On a documentation surface, "what does this
  // flag do" is not an edge case; it is the point.
  const subs = [...DOCS_SUBCOMMANDS];

  it("is help while the free text has not started", () => {
    expect(wantsLeadingHelp(["--help"], subs)).toBe(true);
    expect(wantsLeadingHelp(["-h"], subs)).toBe(true);
    expect(wantsLeadingHelp(["ask", "--help"], subs)).toBe(true);
    expect(wantsLeadingHelp(["search", "-h"], subs)).toBe(true);
  });

  it("is NOT help once the free text has started", () => {
    expect(wantsLeadingHelp(["ask", "what", "does", "-h", "do"], subs)).toBe(false);
    expect(wantsLeadingHelp(["ask", "what does -h do"], subs)).toBe(false);
    expect(wantsLeadingHelp(["search", "--help", "flag"], subs)).toBe(true); // leading, still help
    expect(wantsLeadingHelp(["search", "the", "--help", "flag"], subs)).toBe(false);
  });

  it("lets POSIX `--` escape a question that IS a help flag", () => {
    // `mla docs ask -h` is help: same tokens either way, and help is the likelier
    // intent. The way out is `--`, which is neither a help flag nor a subcommand, so
    // the scan stops there and never sees the flag behind it. (runDocs then drops the
    // leading `--`, so the question reads `-h`, not `-- -h`.)
    expect(wantsLeadingHelp(["ask", "-h"], subs)).toBe(true);
    expect(wantsLeadingHelp(["ask", "--", "-h"], subs)).toBe(false);
  });

  it("leaves a bare command and a topic read alone", () => {
    expect(wantsLeadingHelp([], subs)).toBe(false);
    expect(wantsLeadingHelp(["onboarding"], subs)).toBe(false);
    expect(wantsLeadingHelp(["concepts/enforcement"], subs)).toBe(false);
  });

  it("a command with no subcommands treats its very first token as free text", () => {
    expect(wantsLeadingHelp(["--help"], [])).toBe(true);
    expect(wantsLeadingHelp(["a question", "--help"], [])).toBe(false);
  });
});

describe("nearestCommands: a concise 'did you mean', never the catalog", () => {
  // Proposal §3 bug 1: an unknown word should cost the operator (or a piped agent)
  // a short suggestion, not a re-emission of the whole command surface.
  it("surfaces a real command for a one-edit typo, closest first", () => {
    expect(nearestCommands(COMMANDS, "doctorr")).toContain("doctor");
    expect(nearestCommands(COMMANDS, "activ8")[0]).toBe("activate");
  });

  it("caps the list at the requested limit", () => {
    expect(nearestCommands(COMMANDS, "revie", 2).length).toBeLessThanOrEqual(2);
    expect(nearestCommands(COMMANDS, "x", 1).length).toBeLessThanOrEqual(1);
  });

  it("returns nothing for genuine gibberish, so the caller falls back to `mla help`", () => {
    expect(nearestCommands(COMMANDS, "zzzzzzzzzzq")).toEqual([]);
  });

  it("never suggests a hidden removed-command stub", () => {
    // `cases` is hidden; a near-miss must not resurface it as a suggestion.
    for (const hidden of HIDDEN) {
      expect(nearestCommands(COMMANDS, hidden)).not.toContain(hidden);
    }
  });
});

describe("machine-owned command-reference region", () => {
  // The website lives at the MONOREPO root, OUTSIDE meetless-cli/, so the published
  // standalone mirror (github.com/Meetless/mla, which is meetless-cli/ and nothing
  // else) ships this suite with no `docs/` tree to read. Skip the three page-reading
  // tests there rather than ENOENT a public contributor's first `pnpm test`.
  //
  // The key is the monorepo root itself, not the page: inside the monorepo the root
  // is always there, so a deleted or renamed commands.md still hard-fails here
  // instead of quietly skipping the freshness gate. `pnpm-workspace.yaml` is the
  // marker because `docs/` alone is not one; it is a workspace package, so a pnpm
  // run in another terminal recreates it as an empty node_modules shell the moment
  // it goes missing, and an existence check on it can read true with no content.
  const MONOREPO = path.resolve(__dirname, "../../../../..");
  const DOCS_PAGE = path.join(MONOREPO, "docs/src/content/docs/reference/commands.md");
  const itInMonorepo = fs.existsSync(path.join(MONOREPO, "pnpm-workspace.yaml")) ? it : it.skip;

  itInMonorepo("the website's command index is fresh (regenerate: pnpm gen:command-reference)", () => {
    const page = fs.readFileSync(DOCS_PAGE, "utf8");
    expect(page).toBe(spliceCommandIndex(page, renderCommandIndex(COMMANDS)));
  });

  it("every VISIBLE command has a summary and appears in the index", () => {
    const index = renderCommandIndex(COMMANDS);
    for (const c of COMMANDS.filter((c) => !c.hidden)) {
      expect(c.summary).toBeTruthy();
      expect(index).toContain(`\`mla ${c.name}\``);
    }
  });

  it("hidden commands stay out of the index", () => {
    const index = renderCommandIndex(COMMANDS);
    for (const name of HIDDEN) {
      expect(index).not.toContain(`\`mla ${name}\``);
    }
  });

  itInMonorepo("splicing only ever rewrites the bytes between the markers", () => {
    const page = fs.readFileSync(DOCS_PAGE, "utf8");
    const mangled = spliceCommandIndex(page, "| Command | What it does |\n| --- | --- |");
    const head = page.slice(0, page.indexOf(BEGIN_MARKER));
    const tail = page.slice(page.indexOf(END_MARKER));
    expect(mangled.startsWith(head)).toBe(true);
    expect(mangled.endsWith(tail)).toBe(true);
    // ...and the curated prose above the region survives untouched.
    expect(mangled).toContain("## Setup and identity");
  });

  it("refuses to splice a page whose markers are missing", () => {
    expect(() => spliceCommandIndex("# no markers here\n", "x")).toThrow(/markers not found/);
  });

  itInMonorepo("every command named in the curated prose is really in the registry", () => {
    // The curated tables are hand-written and stay that way, but they must not
    // advertise a command that does not exist (this caught `mla cases`, removed).
    const page = fs.readFileSync(DOCS_PAGE, "utf8");
    const curated = page.slice(0, page.indexOf("## Every command"));
    const named = new Set(
      [...curated.matchAll(/`mla ([a-z][a-z-]*)/g)].map((m) => m[1]).filter((w) => w !== "help"),
    );
    const phantom = [...named].filter((w) => !resolveCommand(COMMANDS, w));
    expect(phantom).toEqual([]);
  });
});
