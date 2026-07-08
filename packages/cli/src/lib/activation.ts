import * as fs from "fs";
import * as path from "path";

// Per-folder activation marker (opt-in capture gate). The bash counterpart
// lives in hooks-template/common.sh (`meetless_activated`); this module is the
// TypeScript side used by `mla activate` (write) and `mla doctor` (report).
// Both sides MUST agree on the filename and the nearest-wins walk-up semantics.
// "marker" here means the folder activation marker `.meetless.json`; it is the
// only marker concept in the CLI.
export const ACTIVATION_FILENAME = ".meetless.json";

export interface ActivationMarker {
  workspaceId?: string;
  // Display-only workspace label (folder = workspace design). Non-secret, never
  // an authorization input; the server is the sole authority for membership.
  // Purely so humans and `mla workspace show` can name the binding without a
  // round-trip.
  workspaceName?: string;
  // Free-form provenance. Never read by the gate; purely for the human who
  // opens the file later to remember why this folder is activated.
  activatedAt?: string;
  note?: string;
}

export interface FoundActivation {
  path: string;
  dir: string;
  workspaceId?: string;
  workspaceName?: string;
  parseError?: string;
}

// Walk UP from startDir looking for the nearest `.meetless.json`, nearest-wins,
// mirroring how Claude Code resolves CLAUDE.md and how common.sh's
// `meetless_activated` gate behaves. Returns null when no marker is found.
export function findActivation(startDir: string): FoundActivation | null {
  let dir = path.resolve(startDir);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = path.join(dir, ACTIVATION_FILENAME);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      const found: FoundActivation = { path: candidate, dir };
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as ActivationMarker;
        if (typeof parsed.workspaceId === "string" && parsed.workspaceId) {
          found.workspaceId = parsed.workspaceId;
        }
        if (typeof parsed.workspaceName === "string" && parsed.workspaceName) {
          found.workspaceName = parsed.workspaceName;
        }
      } catch (e) {
        // Matches the bash gate: a malformed marker still activates the folder
        // (the file exists); the workspaceId is simply treated as absent.
        found.parseError = (e as Error).message;
      }
      return found;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
