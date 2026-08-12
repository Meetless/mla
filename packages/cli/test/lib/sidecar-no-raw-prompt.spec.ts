import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

// `write_sidecar` writes a human-readable copy of each turn to
// ~/.meetless/logs/enrichments/<trace_id>.md. It has always printed the RAW prompt under a
// `## Prompt` heading.
//
// On 2026-08-04 `write_trace` stopped recording the raw prompt into ask-traces.jsonl,
// because that file had grown to 38MB holding live Sentry, Anthropic and GitHub
// credentials. That fix closed ONE door. This sidecar is the other one, and it was never
// named: on 2026-08-05 the dogfood machine held 4,323 sidecars, ALL at mode 0644, and the
// same four credential families the 08-04 audit reported in the trace were still sitting
// in them -- including in a file written three minutes before this test was authored.
//
// So the exposure that was reported as "fixed at the writer" was still live, at wider
// permissions, in a second file, and still growing one file per prompt.
//
// The substitution here is the one write_trace already chose: prompt_chars plus
// raw_prompt_hash. Redacting instead was considered and rejected there for a reason that
// governs equally here -- redaction keeps text, so every secret shape the scanner does not
// yet know still lands on disk, whereas not writing the body cannot fail open.
//
// Drives the REAL src/hooks-template/user-prompt-submit.sh: JSON on stdin, MEETLESS_HOME
// pointed at a sandbox, then read the sidecar the hook actually wrote.
const HOOK = join(__dirname, "../../src/hooks-template/user-prompt-submit.sh");
const WORKSPACE_ID = "ws_sidecar";

// A credential-SHAPED token that is not a real credential, embedded in an otherwise
// ordinary prompt. `scanForCredentials` recognises this family, so a sidecar that still
// prints the body will contain it verbatim.
const CREDENTIAL_SHAPED = `ghp_${"aB3dE6gH9jK2mN5pQ8rS1tV4wX7yZ0".repeat(1).slice(0, 36)}`;
const PROMPT = `deploy the worker using ${CREDENTIAL_SHAPED} and then report back`;

function runHook(prompt: string): { sidecars: string[]; dir: string } {
  const home = mkdtempSync(join(tmpdir(), "mla-sidecar-home-"));
  const repo = mkdtempSync(join(tmpdir(), "mla-sidecar-repo-"));
  writeFileSync(join(repo, ".meetless.json"), JSON.stringify({ workspaceId: WORKSPACE_ID }));
  mkdirSync(join(home, "logs"), { recursive: true });
  writeFileSync(
    join(home, "cli-config.json"),
    JSON.stringify({ workspaceId: WORKSPACE_ID, actorUserId: "user_a", intelUrl: "http://127.0.0.1:8100" }),
  );

  spawnSync("bash", [HOOK], {
    input: JSON.stringify({ session_id: "sidecar_probe", prompt, cwd: repo }),
    encoding: "utf8",
    cwd: repo,
    env: { ...process.env, MEETLESS_HOME: home, HOME: home },
    timeout: 20000,
  });

  const dir = join(home, "logs", "enrichments");
  const sidecars = readdirSync(dir).filter((f) => f.endsWith(".md"));
  return { sidecars, dir };
}

describe("enrichment sidecar does not persist the raw prompt", () => {
  it("writes a sidecar for the turn at all, so the rest of this suite is not vacuous", () => {
    const { sidecars } = runHook(PROMPT);

    expect(sidecars.length).toBeGreaterThan(0);
  });

  it("does not contain the credential the operator pasted into the prompt", () => {
    const { sidecars, dir } = runHook(PROMPT);

    for (const f of sidecars) {
      expect(readFileSync(join(dir, f), "utf8")).not.toContain(CREDENTIAL_SHAPED);
    }
  });

  it("does not contain the prompt body at all, not merely the secret in it", () => {
    // Asserting only on the credential would pass a fix that pattern-matched known secret
    // shapes, which is exactly the fail-open design write_trace rejected. The body has to
    // be absent.
    const { sidecars, dir } = runHook(PROMPT);

    for (const f of sidecars) {
      expect(readFileSync(join(dir, f), "utf8")).not.toContain("deploy the worker using");
    }
  });

  it("still records the length and hash, so a turn stays identifiable", () => {
    const { sidecars, dir } = runHook(PROMPT);
    const body = readFileSync(join(dir, sidecars[0]), "utf8");

    expect(body).toContain(`prompt_chars: ${PROMPT.length}`);
    // The hook stamps the algorithm alongside the digest (`sha256:<hex>`), which is what
    // ask-traces.jsonl carries too, so the two files join on the exact same string.
    expect(body).toMatch(/raw_prompt_hash: sha256:[0-9a-f]{64}/);
  });

  it("is readable only by its owner", () => {
    // ask-traces.jsonl gets `ml_private_file` (0600); the sidecar never did, so all 4,323
    // files on the dogfood machine sat at 0644 while holding the same material.
    const { sidecars, dir } = runHook(PROMPT);

    for (const f of sidecars) {
      expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
    }
  });
});
