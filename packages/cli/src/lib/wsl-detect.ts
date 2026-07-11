// wsl-detect: identify a WSL-under-Windows session so `mla doctor` can print the
// known-good cross-boundary invocation. The pain this targets: mla runs natively
// inside WSL, but a coding agent driving mla from the *Windows* side (Git Bash /
// MSYS) path-mangles a leading-slash argument into `C:/Program Files/...` and the
// call dies on the space. The fix is a documentation nudge, not a code path: mla
// is tested on macOS and Linux; Windows is community-supported.
//
// Everything here is pure and dependency-injected so the Windows-only behavior is
// unit-testable on macOS/Linux CI (there is no real WSL to run under).

import * as fs from "fs";

export interface WslDetectInputs {
  platform?: NodeJS.Platform;
  // $WSL_DISTRO_NAME is set by WSL2 in every distro shell; the surest signal.
  wslDistroName?: string;
  // Kernel release string (`/proc/sys/kernel/osrelease`); WSL kernels carry a
  // "microsoft"/"WSL" marker. Injected so tests need no /proc.
  osRelease?: string;
}

// True only for a Linux process running inside WSL on Windows. Non-Linux hosts
// (a native macOS or Windows binary) are never WSL, so they short-circuit false.
export function detectWslUnderWindows(inputs: WslDetectInputs = {}): boolean {
  const platform = inputs.platform ?? process.platform;
  if (platform !== "linux") return false;

  const distro = inputs.wslDistroName ?? process.env.WSL_DISTRO_NAME;
  if (distro && distro.trim() !== "") return true;

  const release = (inputs.osRelease ?? readKernelRelease()).toLowerCase();
  return release.includes("microsoft") || release.includes("wsl");
}

// Whether `mla doctor` should surface the cross-boundary hint. Under WSL, show it
// only for a NON-interactive invocation: a program (a Windows-side coding agent
// running `wsl -e bash -c ...`) driving mla, not a human typing `mla doctor` in a
// WSL shell. The interactive human already has a working invocation and does not
// need the nudge cluttering an otherwise-clean report; the agent's output lands in
// a transcript the operator reviews, which is exactly where the hint helps. Kept
// pure (both signals passed in) so the gate is unit-tested without a real TTY.
export function shouldSurfaceWslHint(
  wslDetected: boolean,
  interactive: boolean,
): boolean {
  return wslDetected && !interactive;
}

function readKernelRelease(): string {
  // Two probes: the release string proper, then /proc/version as a fallback for
  // kernels that only stamp the marker there. Both absent (or unreadable) => "".
  for (const p of ["/proc/sys/kernel/osrelease", "/proc/version"]) {
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      // Not Linux, or /proc is restricted; try the next probe.
    }
  }
  return "";
}

// The note `mla doctor` prints when it is running inside WSL. Kept as a single
// pre-joined string so the caller is one `console.log` and the copy is asserted
// verbatim in a test. `$HOME` stays literal (single-quoted) so it expands inside
// WSL, not on the Windows side; the leading slash never reaches Git Bash to be
// rewritten into `C:/...`.
export const WSL_MLA_HINT: string = [
  "",
  "WSL detected. mla runs natively here. A coding agent on the Windows side",
  "(Git Bash) can mangle a WSL path into C:/Program Files/... and break; invoke",
  "mla through WSL, single-quoted so the path survives:",
  "    wsl -e bash -c '$HOME/.meetless/bin/mla <args>'",
  "Windows is community-supported (mla is tested on macOS and Linux). Report",
  "issues at https://github.com/Meetless/mla or run `mla bug report`.",
].join("\n");
