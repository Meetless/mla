import { spawnSync } from "child_process";

// Platform browser launcher backing the `--open` opt-in flag (B4b, §3 B4).
//
// IMPORTANT: this is never auto-invoked. The resolved B4 decision (§5 #5 of
// notes/20260603-mla-kb-agent-proxy-and-evidence-adoption.md) is "print the URL
// ALWAYS, `--open` opt-in, NO browser auto-open, including for kb add". The CLI is
// driven by an agent proxy in the §1 loop; auto-launching a browser on every
// `kb add` / `kb show` would spawn tabs no human is watching. So the URL is always
// printed by the command layer (B4a), and this helper fires only when the human
// explicitly passes `--open`.

export interface OpenRunResult {
  error?: Error;
  status?: number | null;
}

export interface OpenUrlResult {
  ok: boolean;
  error?: string;
}

// The launcher is injected (default: spawnSync) so the suite never opens a real
// browser. open / xdg-open / start all return promptly after handing the URL to the
// OS, so a synchronous spawn does not block the CLI.
export type OpenRunner = (cmd: string, args: string[]) => OpenRunResult;

const defaultRunner: OpenRunner = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: "ignore" });
  return { error: r.error ?? undefined, status: r.status };
};

function launcherFor(platform: NodeJS.Platform, url: string): { cmd: string; args: string[] } {
  if (platform === "darwin") return { cmd: "open", args: [url] };
  if (platform === "win32") return { cmd: "cmd", args: ["/c", "start", "", url] };
  return { cmd: "xdg-open", args: [url] };
}

export function openUrl(
  url: string,
  opts: { platform?: NodeJS.Platform; run?: OpenRunner } = {},
): OpenUrlResult {
  // Hand the OS launcher only vetted http(s) URLs. The Console URL is the only thing
  // we ever open; rejecting everything else keeps a malformed config or a crafted
  // path from reaching the shell.
  if (!/^https?:\/\/\S+$/i.test(url)) {
    return { ok: false, error: `refusing to open a non-http(s) URL: ${url}` };
  }

  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? defaultRunner;
  const { cmd, args } = launcherFor(platform, url);

  const r = run(cmd, args);
  if (r.error) return { ok: false, error: r.error.message };
  if (typeof r.status === "number" && r.status !== 0) {
    return { ok: false, error: `${cmd} exited ${r.status}` };
  }
  return { ok: true };
}
