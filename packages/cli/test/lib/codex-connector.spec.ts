// Phase-1 GATE for the Codex connector (§8: "all six Phase-1 required tests
// green"). These map 1:1 to the six §7 acceptance tests:
//
//   1. User hooks in $CODEX_HOME/hooks.json are preserved across install.
//   2. Repeated install produces no duplicate managed entries (idempotent).
//   3. Uninstall removes only MLA entries, leaving user hooks intact.
//   4. A malformed $CODEX_HOME/hooks.json is NOT overwritten (fails visibly).
//   5. An unbound repository is a no-op for BOTH hooks (§6.5 contract).
//   6. Removing the Claude connector does not break Codex grounding (the shared
//      ~/.meetless/hooks/*.sh survive; the Codex hooks.json is untouched).
//
// The suite drives the real merge engine (lib/hook-reconcile via
// connectors/codex/wire), the real command layer (commands/codex), the real
// UserPromptSubmit wrapper (commands/internal-codex-hook), and the real
// PreToolUse observer (commands/internal-pretool-observe). Only the two
// genuinely non-deterministic / external seams are faked: the pretool
// principal/bundle readers (test 5) and the grounding-script child process
// (test 5c). HOOKS_DIR is redirected per-file to a throwaway MEETLESS_HOME by
// test/jest.setup-home.js, so ensureHookScripts() provisions into an isolated
// dir and nothing touches the operator's real ~/.meetless.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  ensureCodexHooks,
  removeCodexHooks,
  codexHooksInstalled,
} from "../../src/connectors/codex/wire";
import { codexManagedEventOf } from "../../src/connectors/codex/hook-contract";
import { runCodexInstall } from "../../src/commands/codex";
import { runInternalCodexHook } from "../../src/commands/internal-codex-hook";
import {
  adaptPretoolResponseForCodex,
  renderPreToolUseAsk,
  runInternalPretoolObserve,
} from "../../src/commands/internal-pretool-observe";
import { ensureHookScripts, MANAGED_HOOK_SCRIPTS } from "../../src/lib/wire";
import { removeMeetlessHooks } from "../../src/lib/unwire";
import { HOOKS_DIR } from "../../src/lib/config";

const MLA = "/opt/mla/bin/mla";

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function hooksFileIn(dir: string): string {
  return path.join(dir, "hooks.json");
}
function readJson(p: string): any {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function writeJson(p: string, obj: unknown): void {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}
function commandsFor(doc: any, event: string): string[] {
  const list = Array.isArray(doc?.hooks?.[event]) ? doc.hooks[event] : [];
  return list.flatMap((entry: any) =>
    (Array.isArray(entry?.hooks) ? entry.hooks : []).map(
      (h: any) => h?.command,
    ),
  );
}
// How many hook ENTRIES in `event` are a Meetless-managed command for that event.
function managedEntryCount(doc: any, event: string): number {
  return commandsFor(doc, event).filter(
    (c: string) => codexManagedEventOf(c) === event,
  ).length;
}
function cleanup(...dirs: string[]): void {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

describe("Codex connector: Phase-1 gate (§7)", () => {
  // ── Test 1 ────────────────────────────────────────────────────────────────
  it("1. preserves pre-existing user hooks across install", () => {
    const dir = mkTmp("mla-codex-1-");
    const hooks = hooksFileIn(dir);
    // The operator already hand-registered their own hooks, INCLUDING ones on
    // the same events we manage. None of these must be lost.
    writeJson(hooks, {
      hooks: {
        PreToolUse: [
          {
            matcher: "^Bash$",
            hooks: [{ type: "command", command: "/usr/local/bin/my-linter" }],
          },
        ],
        UserPromptSubmit: [
          {
            matcher: "",
            hooks: [{ type: "command", command: "/usr/local/bin/my-logger" }],
          },
        ],
        Notification: [
          {
            matcher: "",
            hooks: [{ type: "command", command: "/usr/local/bin/notify" }],
          },
        ],
      },
    });

    const res = ensureCodexHooks({ hooksPathOverride: hooks, mlaPath: MLA });
    expect(res.changed).toBe(true);
    expect(res.added.sort()).toEqual(["PreToolUse", "UserPromptSubmit"]);

    const doc = readJson(hooks);
    // Every user hook survives untouched, on every event.
    expect(commandsFor(doc, "PreToolUse")).toContain("/usr/local/bin/my-linter");
    expect(commandsFor(doc, "UserPromptSubmit")).toContain(
      "/usr/local/bin/my-logger",
    );
    expect(commandsFor(doc, "Notification")).toEqual(["/usr/local/bin/notify"]);
    // And our managed hooks are now registered alongside them.
    expect(managedEntryCount(doc, "PreToolUse")).toBe(1);
    expect(managedEntryCount(doc, "UserPromptSubmit")).toBe(1);
    expect(commandsFor(doc, "PreToolUse")).toEqual(
      expect.arrayContaining([
        expect.stringContaining("_internal pretool-observe --codex"),
      ]),
    );

    cleanup(dir);
  });

  it("maps MLA's unsupported ASK result to a Codex-supported deny", () => {
    const adapted = adaptPretoolResponseForCodex(
      renderPreToolUseAsk("Confirm this governed write."),
    );
    expect(adapted.exitCode).toBe(0);
    const parsed = JSON.parse(adapted.stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toMatch(
      /Codex cannot prompt from PreToolUse yet/,
    );
  });

  // ── Test 2 ────────────────────────────────────────────────────────────────
  it("2. is idempotent: repeated install adds no duplicate managed entries", () => {
    const dir = mkTmp("mla-codex-2-");
    const hooks = hooksFileIn(dir);

    const first = ensureCodexHooks({ hooksPathOverride: hooks, mlaPath: MLA });
    expect(first.changed).toBe(true);
    expect(first.added.sort()).toEqual(["PreToolUse", "UserPromptSubmit"]);

    const second = ensureCodexHooks({ hooksPathOverride: hooks, mlaPath: MLA });
    expect(second.changed).toBe(false);
    expect(second.added).toEqual([]);

    let doc = readJson(hooks);
    expect(managedEntryCount(doc, "PreToolUse")).toBe(1);
    expect(managedEntryCount(doc, "UserPromptSubmit")).toBe(1);

    // Managed identity is the subcommand token run, NOT the exact path. A CLI
    // that has since moved (e.g. reinstalled to a new prefix) must reconcile the
    // existing entry IN PLACE, not stack a second copy.
    const relocated = ensureCodexHooks({
      hooksPathOverride: hooks,
      mlaPath: "/somewhere/else/bin/mla",
    });
    expect(relocated.changed).toBe(true); // command string changed (new path)
    expect(relocated.added).toEqual([]); // but no new EVENT was added
    doc = readJson(hooks);
    expect(managedEntryCount(doc, "PreToolUse")).toBe(1);
    expect(managedEntryCount(doc, "UserPromptSubmit")).toBe(1);

    cleanup(dir);
  });

  it("upgrades the legacy pretool command in place without duplication", () => {
    const dir = mkTmp("mla-codex-legacy-");
    const hooks = hooksFileIn(dir);
    writeJson(hooks, {
      hooks: {
        PreToolUse: [
          {
            matcher: "^(Write|Edit|apply_patch|Bash)$",
            hooks: [
              {
                type: "command",
                command: `"${MLA}" _internal pretool-observe`,
              },
            ],
          },
        ],
      },
    });

    ensureCodexHooks({ hooksPathOverride: hooks, mlaPath: MLA });
    const doc = readJson(hooks);
    expect(managedEntryCount(doc, "PreToolUse")).toBe(1);
    expect(commandsFor(doc, "PreToolUse")).toEqual([
      expect.stringContaining("_internal pretool-observe --codex"),
    ]);
    cleanup(dir);
  });

  it("does not report a partial Codex hook install as healthy", () => {
    const dir = mkTmp("mla-codex-partial-");
    const hooks = hooksFileIn(dir);
    writeJson(hooks, {
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: "command",
                command: `"${MLA}" _internal pretool-observe --codex`,
              },
            ],
          },
        ],
      },
    });
    expect(codexHooksInstalled({ hooksPathOverride: hooks })).toBe(false);
    cleanup(dir);
  });

  // ── Test 3 ────────────────────────────────────────────────────────────────
  it("3. uninstall strips only MLA entries, leaving user hooks intact", () => {
    const dir = mkTmp("mla-codex-3-");
    const hooks = hooksFileIn(dir);
    writeJson(hooks, {
      hooks: {
        PreToolUse: [
          {
            matcher: "^Bash$",
            hooks: [{ type: "command", command: "/usr/local/bin/my-linter" }],
          },
        ],
      },
    });

    ensureCodexHooks({ hooksPathOverride: hooks, mlaPath: MLA });
    expect(codexHooksInstalled({ hooksPathOverride: hooks })).toBe(true);

    const rm = removeCodexHooks({ hooksPathOverride: hooks });
    expect(rm.changed).toBe(true);
    expect(codexHooksInstalled({ hooksPathOverride: hooks })).toBe(false);

    const doc = readJson(hooks);
    // The user's linter (which shared the PreToolUse event) survives.
    expect(commandsFor(doc, "PreToolUse")).toContain("/usr/local/bin/my-linter");
    expect(managedEntryCount(doc, "PreToolUse")).toBe(0);
    // The UserPromptSubmit event, which held only our hook, is gone entirely.
    expect(doc.hooks.UserPromptSubmit).toBeUndefined();

    cleanup(dir);
  });

  // ── Test 4 ────────────────────────────────────────────────────────────────
  it("4. refuses to overwrite a malformed hooks.json (fails visibly, §6.4)", async () => {
    const dir = mkTmp("mla-codex-4-");
    const hooks = hooksFileIn(dir);

    // (a) unparseable JSON: the merge engine throws, the file is untouched.
    const garbage = "{ this is not valid json ,,, ";
    fs.writeFileSync(hooks, garbage, "utf8");
    expect(() =>
      ensureCodexHooks({ hooksPathOverride: hooks, mlaPath: MLA }),
    ).toThrow(/not valid JSON/i);
    expect(fs.readFileSync(hooks, "utf8")).toBe(garbage);

    // (b) the command layer surfaces it: exit 1, names the file, no clobber.
    const logs: string[] = [];
    const errs: string[] = [];
    const code = await runCodexInstall([], {
      hooksPathOverride: hooks,
      log: (m) => logs.push(m),
      errlog: (m) => errs.push(m),
      ensureScripts: () => [], // don't provision real scripts for this path
    });
    expect(code).toBe(1);
    const errText = errs.join("\n");
    expect(errText).toContain(hooks);
    expect(errText).toMatch(/not valid JSON/i);
    expect(fs.readFileSync(hooks, "utf8")).toBe(garbage); // STILL untouched

    // (c) valid JSON but a non-object top level (bare array) is just as unsafe.
    fs.writeFileSync(hooks, "[]", "utf8");
    expect(() =>
      ensureCodexHooks({ hooksPathOverride: hooks, mlaPath: MLA }),
    ).toThrow(/not an object/i);
    expect(fs.readFileSync(hooks, "utf8")).toBe("[]");

    cleanup(dir);
  });

  // ── Test 5 ────────────────────────────────────────────────────────────────
  describe("5. an unbound repository is a no-op for both hooks (§6.5)", () => {
    it("PreToolUse: no principal → pass-through, and NO backend bundle read", async () => {
      const out: string[] = [];
      let bundleReads = 0;
      const payload = JSON.stringify({
        session_id: "s-unbound",
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: "notes/whatever.md", content: "x" },
      });

      const code = await runInternalPretoolObserve([], {
        readStdin: async () => payload,
        writeOut: (s) => out.push(s),
        // Unbound repo: no resolvable principal → the observer short-circuits to
        // the conflict-warning path BEFORE any bundle read.
        resolvePrincipal: () => null,
        readConflicts: () => [], // no cross-session conflicts either
        // Must never be reached; if it is, the "no network when unbound"
        // contract is broken.
        readBundle: (() => {
          bundleReads++;
          throw new Error("bundle must not be read for an unbound repo");
        }) as any,
      });

      expect(code).toBe(0);
      expect(bundleReads).toBe(0);
      const body = out.join("");
      // Empty pass-through body = the tool is permitted with no governance verdict.
      const parsed = body.trim() === "" ? {} : JSON.parse(body);
      expect(parsed?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    });

    it("UserPromptSubmit wrapper: no-op on an unknown event", async () => {
      const out: string[] = [];
      const code = await runInternalCodexHook(["NotARealEvent"], {
        readStdin: async () => "{}",
        writeOut: (s) => out.push(s),
      });
      expect(code).toBe(0);
      expect(out).toEqual([]);
    });

    it("UserPromptSubmit wrapper: no-op when the grounding script is not provisioned", async () => {
      const empty = mkTmp("mla-codex-5b-");
      const out: string[] = [];
      const code = await runInternalCodexHook(["user-prompt-submit"], {
        readStdin: async () => "{}",
        writeOut: (s) => out.push(s),
        hooksDir: empty,
      });
      expect(code).toBe(0);
      expect(out).toEqual([]);
      cleanup(empty);
    });

    it("UserPromptSubmit wrapper: emits nothing when the grounding script no-ops (unbound repo)", async () => {
      // Provision a real script so the existsSync check passes; model the
      // grounding script's unbound behavior (it prints nothing) via runScript.
      const scriptDir = mkTmp("mla-codex-5c-");
      fs.writeFileSync(
        path.join(scriptDir, "user-prompt-submit.sh"),
        "#!/bin/bash\n",
        "utf8",
      );
      const out: string[] = [];
      let ran = 0;
      const code = await runInternalCodexHook(["user-prompt-submit"], {
        readStdin: async () => JSON.stringify({ prompt: "hello" }),
        writeOut: (s) => out.push(s),
        hooksDir: scriptDir,
        runScript: (_scriptPath: string, _input: string) => {
          ran++;
          return ""; // unbound repo: script emits no grounding envelope
        },
      });
      expect(code).toBe(0);
      expect(ran).toBe(1);
      expect(out).toEqual([]);
      cleanup(scriptDir);
    });
  });

  // ── Test 6 ────────────────────────────────────────────────────────────────
  it("6. removing the Claude connector does not break Codex grounding (§13)", () => {
    // 1. Provision the shared hook scripts both connectors shell into.
    ensureHookScripts();
    const sharedScript = path.join(HOOKS_DIR, "user-prompt-submit.sh");
    expect(fs.existsSync(sharedScript)).toBe(true);

    // 2. Codex is installed: hooks.json references the wrapper subcommands.
    const codexDir = mkTmp("mla-codex-6-");
    const codexHooks = hooksFileIn(codexDir);
    ensureCodexHooks({ hooksPathOverride: codexHooks, mlaPath: MLA });
    expect(codexHooksInstalled({ hooksPathOverride: codexHooks })).toBe(true);

    // 3. Claude is ALSO installed: build a settings.json wired to the same
    //    shared scripts, using the real MANAGED_HOOK_SCRIPTS contract.
    const claudeDir = mkTmp("mla-claude-6-");
    const settings = path.join(claudeDir, "settings.json");
    const claudeHooks: Record<string, any[]> = {};
    for (const spec of MANAGED_HOOK_SCRIPTS) {
      const hook: any = {
        type: "command",
        command: path.join(HOOKS_DIR, spec.script),
      };
      if (spec.timeout) hook.timeout = spec.timeout;
      const entry: any = { hooks: [hook] };
      if (spec.matcher !== undefined) entry.matcher = spec.matcher;
      (claudeHooks[spec.event] ||= []).push(entry);
    }
    writeJson(settings, { hooks: claudeHooks });

    // 4. Remove ONLY the Claude connector (connector-scoped: edits settings.json).
    const rm = removeMeetlessHooks(settings);
    expect(rm.changed).toBe(true);

    // 5. The shared script survives on disk → Codex grounding still runs.
    expect(fs.existsSync(sharedScript)).toBe(true);
    // 6. The Codex hooks.json is untouched and still registers our hooks.
    expect(codexHooksInstalled({ hooksPathOverride: codexHooks })).toBe(true);

    cleanup(codexDir, claudeDir);
  });
});
