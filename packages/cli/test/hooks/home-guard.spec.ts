// test/hooks/home-guard.spec.ts
//
// The shell-side $HOME repair (hooks-template/home.sh), driven as the hooks drive it:
// the REAL file, sourced by a real bash, under a real poisoned environment.
//
// This is the guard for the 2026-07-13 incident. A session was launched with HOME=''
// (a `bash -c 'source ./lib.sh; ... env HOME="$BOX_HOME" ... claude'` run from a cwd
// where lib.sh did not exist: the source failed, no `set -u` was in effect, and every
// box variable expanded to nothing). Claude Code booted with an empty $HOME and the
// repo as its cwd, so everything it spawned re-rooted its state INTO THE REPO:
//   - the hooks resolved "$HOME/.meetless" -> the relative ".meetless"  -> <repo>/.meetless
//   - npm, whose home fallback is `env.HOME || homedir()` and which then resolves the
//     literal string "~/.npm", planted a 71MB "~" DIRECTORY at <repo>/~/.npm.
// Nothing errored. Nothing warned. It looked like 451 untracked files in `git status`.
//
// Node's repairHomeEnv (lib/config.ts) cannot reach any of that: hooks run in Claude
// Code's environment BEFORE any mla process starts. home.sh is the shell twin, and it
// recovers the truth the only way a shell can, through the PASSWORD DATABASE:
// `eval "h=~$user"` is getpwnam, not $HOME. These specs pin exactly that.
//
// Written against the real script (never a copy pasted into a TS literal) for the same
// reason as build-stop-card.spec.ts: a copy cannot drift, so it proves nothing.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

const HOOKS = join(__dirname, "..", "..", "src", "hooks-template");
const HOME_SH = join(HOOKS, "home.sh");

// The passwd home: what home.sh must recover, and the one thing we cannot fake.
const PASSWD_HOME = (() => {
  try {
    return userInfo().homedir;
  } catch {
    return "";
  }
})();
// An exotic CI uid with no passwd entry has nothing to recover TO. Skip rather than
// assert a lie. (`describe.skip` reports as skipped, so this stays visible in CI.)
const canRecover = PASSWD_HOME.startsWith("/");
const describeIf = canRecover ? describe : describe.skip;

interface Run {
  stdout: string;
  stderr: string;
  status: number | null;
}

// Source the real home.sh under a controlled environment and run `script` after it.
// `env` REPLACES the environment (no inheritance), so a value of undefined means the
// variable is genuinely UNSET, which is a distinct case from the empty string here.
function sourceHome(script: string, env: Record<string, string | undefined>, cwd?: string): Run {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) clean[k] = v;
  }
  const r = spawnSync("bash", ["-c", `source "${HOME_SH}"; ${script}`], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...clean },
    cwd: cwd ?? tmpdir(),
    encoding: "utf8",
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
}

describeIf("home.sh: the hook layer's $HOME repair", () => {
  // The three shapes a poisoned $HOME actually takes. "" is what the 2026-07-13
  // incident produced; "~" is what a naive `HOME='~'` produces (and what npm's literal
  // "~/.npm" resolve made us first suspect); a relative path is the general case.
  const POISONED: Array<[string, string]> = [
    ["empty", ""],
    ["a literal tilde", "~"],
    ["a relative path", "some/relative/dir"],
  ];

  describe.each(POISONED)("with $HOME = %s", (_label, poison) => {
    it("recovers the passwd home and EXPORTS it", () => {
      const r = sourceHome('printf "%s" "$HOME"', { HOME: poison });
      expect(r.stdout).toBe(PASSWD_HOME);

      // Exported, not just set: the mla/jq/git the hook spawns must inherit the honest
      // value too. A child shell only sees it if `export` really happened.
      const child = sourceHome('bash -c "printf \\"%s\\" \\"\\$HOME\\""', { HOME: poison });
      expect(child.stdout).toBe(PASSWD_HOME);
    });

    it("warns on stderr (a broken launcher must not be silent)", () => {
      const r = sourceHome("true", { HOME: poison });
      expect(r.stderr).toContain("[Meetless] ignoring $HOME");
      expect(r.stderr).toContain(PASSWD_HOME);
    });

    it("resolves MEETLESS_HOME_DIR to the ABSOLUTE state dir, never a relative one", () => {
      const r = sourceHome('printf "%s" "$MEETLESS_HOME_DIR"', { HOME: poison });
      expect(r.stdout).toBe(join(PASSWD_HOME, ".meetless"));
      expect(r.stdout.startsWith("/")).toBe(true);
    });
  });

  it("repairs an UNSET $HOME silently (nothing is misconfigured, and unset would still break us)", () => {
    // Unset is not a lie, it is an absence: every tool falls back to passwd for it. But
    // "$HOME/.meetless" would still expand to the absolute-but-wrong "/.meetless", so we
    // repair it. Quietly: there is no broken launcher to tell the operator about.
    const r = sourceHome('printf "%s" "$MEETLESS_HOME_DIR"', { HOME: undefined });
    expect(r.stdout).toBe(join(PASSWD_HOME, ".meetless"));
    expect(r.stderr).toBe("");
  });

  it("leaves an absolute $HOME alone, and says nothing", () => {
    const r = sourceHome('printf "%s|%s" "$HOME" "$MEETLESS_HOME_DIR"', { HOME: "/tmp/fake-home" });
    expect(r.stdout).toBe(`/tmp/fake-home|/tmp/fake-home/.meetless`);
    expect(r.stderr).toBe("");
  });

  it("honors an absolute MEETLESS_HOME override, ahead of $HOME", () => {
    const r = sourceHome('printf "%s" "$MEETLESS_HOME_DIR"', {
      HOME: "/tmp/fake-home",
      MEETLESS_HOME: "/tmp/state-elsewhere",
    });
    expect(r.stdout).toBe("/tmp/state-elsewhere");
    expect(r.stderr).toBe("");
  });

  it("REFUSES a relative MEETLESS_HOME and falls back to the home directory", () => {
    // The override is not a free pass to re-root into the cwd: a relative MEETLESS_HOME
    // is the same defect wearing a different name.
    const r = sourceHome('printf "%s" "$MEETLESS_HOME_DIR"', {
      HOME: "/tmp/fake-home",
      MEETLESS_HOME: ".meetless",
    });
    expect(r.stdout).toBe("/tmp/fake-home/.meetless");
    expect(r.stderr).toContain("[Meetless] ignoring MEETLESS_HOME=.meetless");
  });

  it("does not `eval` a username with shell metacharacters", () => {
    // ml_repair_home reaches the password database through `eval "h=~$user"`. `id -un`
    // is not attacker-controlled in practice, but this runs on EVERY hook, so the
    // metacharacter gate is worth pinning: a hostile `id` on PATH must not get a shell.
    const bin = mkdtempSync(join(tmpdir(), "ml-fake-id-"));
    try {
      execFileSync("bash", [
        "-c",
        `printf '#!/bin/sh\\nprintf "%%s" "x; touch ${bin}/PWNED"\\n' > "${bin}/id" && chmod +x "${bin}/id"`,
      ]);
      const r = spawnSync("bash", ["-c", `source "${HOME_SH}"; printf "%s" "$MEETLESS_HOME_DIR"`], {
        env: { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: "" },
        cwd: bin,
        encoding: "utf8",
      });
      expect(existsSync(join(bin, "PWNED"))).toBe(false);
      // No username means no recoverable home: the state dir comes out EMPTY, which
      // every caller treats as "do nothing". It must never come out relative.
      expect(r.stdout).toBe("");
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});

describe("the fallback when home.sh is MISSING (a corrupt install)", () => {
  // home.sh ships with common.sh in every install (wire.ts copies the whole template
  // dir; the plugin generator lists both), so its absence means a corrupt install and
  // `mla doctor` reports it as hook drift. The hook layer still has to fail OPEN. What
  // it must NOT do is fall back to a raw "$HOME/.meetless": under a poisoned $HOME that
  // is a RELATIVE path, and we are right back in the repo.
  //
  // Losing home.sh loses the REPAIR, never the RULE: a state dir is absolute or it does
  // not exist. This runs everywhere (no passwd home needed) precisely because it is the
  // degraded path.
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ml-no-homesh-"));
    // Stage common.sh ALONE, exactly as a corrupt install would leave it.
    execFileSync("cp", [join(HOOKS, "common.sh"), join(dir, "common.sh")]);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("common.sh disables capture rather than re-rooting into the cwd", () => {
    const r = spawnSync("bash", ["-c", `source "${join(dir, "common.sh")}"; echo REACHED`], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "" },
      cwd: dir,
      encoding: "utf8",
    });
    // exit 0 (fail open, no wedged session), the body never runs, and it says why.
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("REACHED");
    expect(r.stderr).toContain("capture is disabled");
    expect(readdirSync(dir)).toEqual(["common.sh"]);
  });

  it("common.sh still honors an absolute MEETLESS_HOME with no home.sh present", () => {
    const state = mkdtempSync(join(tmpdir(), "ml-state-"));
    try {
      const r = spawnSync(
        "bash",
        ["-c", `source "${join(dir, "common.sh")}"; printf "%s" "$QUEUE_DIR"`],
        {
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "", MEETLESS_HOME: state },
          cwd: dir,
          encoding: "utf8",
        },
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(join(state, "queue"));
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });
});

describeIf("the hooks under a poisoned $HOME (the incident, replayed)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "ml-poisoned-cwd-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  // Every shipped hook that resolves state from $HOME. Before this fix each one read
  // `${MEETLESS_HOME:-$HOME/.meetless}` raw, so each one was its own re-rooting bug.
  const HOOK_SCRIPTS = [
    "pre-tool-use.sh",
    "posttool-sweep.sh",
    "ce0-post-tool-use.sh",
    "ce0-stop.sh",
    "ce0-session-start.sh",
    "ce0-user-prompt-submit.sh",
  ];

  it.each(HOOK_SCRIPTS)(
    "%s writes NOTHING into the cwd when it inherits HOME=''",
    (script) => {
      // The exact shape of the incident: HOME empty, MEETLESS_HOME unset, cwd = a repo.
      // stdin is a plausible hook payload; the hook is free to no-op on it. What is NOT
      // free is leaving a "~" or a ".meetless" behind in the cwd.
      const r = spawnSync("bash", [join(HOOKS, script)], {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: "",
        },
        cwd,
        input: JSON.stringify({
          session_id: "home-guard-spec",
          cwd,
          tool_name: "Write",
          tool_input: { file_path: join(cwd, "x.md"), content: "hi" },
        }),
        encoding: "utf8",
        timeout: 30_000,
      });

      // Fail-open contract first: a hook must never wedge a session, whatever the state
      // of $HOME. (The ce0 family and pre-tool-use.sh exit 0 by construction; a non-zero
      // exit from a PreToolUse hook would BLOCK the tool.)
      expect(r.status).toBe(0);

      // The whole point: no state re-rooted into the operator's repo.
      const left = readdirSync(cwd);
      expect(left).not.toContain("~");
      expect(left).not.toContain(".meetless");
    },
  );
});
