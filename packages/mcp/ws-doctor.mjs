#!/usr/bin/env node
/**
 * meetless ws doctor
 *
 * Diagnoses the two-surface workspace-config trap that makes ingest and the
 * MCP answer path silently disagree about which corpus is in play:
 *
 *   1. INGEST surface : the shell `MEETLESS_WORKSPACE_ID` (the default
 *      `ingest_notes.py` falls back to when `--workspace` is omitted). Scoped
 *      to the shell you run ingest in.
 *   2. ANSWER surface : `mcpServers.meetless.env.MEETLESS_WORKSPACE_ID` in the
 *      project `.mcp.json`. Scoped to the MCP subprocess; read once at boot.
 *
 * Same variable name, two different scopes. Setting one does NOT affect the
 * other, so you can ingest into workspace A while the MCP keeps answering from
 * B with no warning anywhere. This command makes that drift loud.
 *
 * Usage:
 *   node tools/meetless-mcp/ws-doctor.mjs
 *   (alias `meetless ws doctor` -> this script; or `npm run ws:doctor`)
 *
 * Exit codes:
 *   0  surfaces agree, or shell has no ingest default (info only)
 *   1  surfaces disagree, or the MCP config could not be read (drift / broken)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function findMcpConfig() {
  // Primary: repo-root .mcp.json, three levels up from this script
  // (tools/meetless-mcp -> meetless/meetless -> meetless).
  const primary = path.resolve(__dirname, "..", "..", "..", ".mcp.json");
  if (fs.existsSync(primary)) return primary;
  // Fallback: walk up from cwd until a .mcp.json is found.
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, ".mcp.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readMcpMeetlessEnv(configPath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch (err) {
    return { error: `could not parse ${configPath}: ${err.message}` };
  }
  const server = parsed?.mcpServers?.meetless;
  if (!server) {
    return { error: `no mcpServers.meetless entry in ${configPath}` };
  }
  return { env: server.env || {} };
}

function color(s, code) {
  if (!process.stdout.isTTY) return s;
  return `\x1b[${code}m${s}\x1b[0m`;
}
const bold = (s) => color(s, "1");
const red = (s) => color(s, "31");
const green = (s) => color(s, "32");
const yellow = (s) => color(s, "33");

function main() {
  const lines = [];
  lines.push(bold("meetless ws doctor"));
  lines.push("");

  const configPath = findMcpConfig();
  let mcpEnv = {};
  let mcpError = null;
  if (!configPath) {
    mcpError = "no .mcp.json found (looked at repo root and up from cwd)";
  } else {
    const res = readMcpMeetlessEnv(configPath);
    if (res.error) mcpError = res.error;
    else mcpEnv = res.env;
  }

  const shellWs = process.env.MEETLESS_WORKSPACE_ID || null;
  const mcpWs = mcpEnv.MEETLESS_WORKSPACE_ID || null;

  lines.push(`  .mcp.json            : ${configPath || red("not found")}`);
  lines.push("");
  lines.push(bold("  ANSWER surface (MCP reads this at boot)"));
  lines.push(`    workspace          : ${mcpWs ? green(mcpWs) : red("(unset)")}`);
  lines.push(`    INTEL_BASE_URL     : ${mcpEnv.INTEL_BASE_URL || "(default 127.0.0.1:8100)"}`);
  lines.push(`    CONTROL_BASE_URL   : ${mcpEnv.CONTROL_BASE_URL || "(default 127.0.0.1:3006)"}`);
  lines.push(`    MEETLESS_NOTES_ROOT: ${mcpEnv.MEETLESS_NOTES_ROOT || "(default ../../notes)"}`);
  lines.push("");
  lines.push(bold("  INGEST surface (ingest_notes.py default when --workspace omitted)"));
  lines.push(`    shell MEETLESS_WORKSPACE_ID: ${shellWs ? green(shellWs) : yellow("(unset)")}`);
  lines.push("");

  // An (Step 3 review, Q1): echo the semantic.m3b posture POLICY so a reader
  // never confuses LIVE (review-visible) with "promoted to the graph". This is
  // the rule, not this workspace's resolved value: ws-doctor is a config-drift
  // checker and intentionally does not read control-db or intel/.env. The
  // per-workspace resolved posture is printed in the ingest banner (it resolves
  // settings.internal with the same pure function the detector stamps with).
  lines.push(bold("  SEMANTIC POSTURE POLICY (semantic.m3b)"));
  lines.push("    internal/dogfood ws : emits LIVE + PENDING_REVIEW + SEMANTIC_REVIEW");
  lines.push("                          (review-visible AI candidate, NOT auto-promoted;");
  lines.push("                           promotion still requires an ACCEPTED verdict)");
  lines.push("    customer/default ws : emits SHADOW (hidden from the review queue)");
  lines.push("    This workspace's resolved posture is printed in the ingest banner.");
  lines.push("");

  let exitCode = 0;
  if (mcpError) {
    lines.push(red(`  BROKEN: ${mcpError}`));
    lines.push("  The MCP cannot resolve an answer workspace. Fix .mcp.json before ingesting.");
    exitCode = 1;
  } else if (!mcpWs) {
    lines.push(red("  BROKEN: mcpServers.meetless.env.MEETLESS_WORKSPACE_ID is unset."));
    lines.push("  The MCP will hard-error at boot. Set it in .mcp.json.");
    exitCode = 1;
  } else if (!shellWs) {
    lines.push(yellow("  INFO: no shell ingest default."));
    lines.push(`  Every ingest must pass --workspace explicitly. The MCP answers from ${bold(mcpWs)}.`);
    lines.push(`  To ingest into the SAME corpus the MCP reads, run:`);
    lines.push(`      python tools/ingest_notes.py <folder> --workspace ${mcpWs}`);
    exitCode = 0;
  } else if (shellWs !== mcpWs) {
    lines.push(red(bold("  MISMATCH: ingest and answer target different workspaces.")));
    lines.push(`    ingest default (shell) -> ${red(shellWs)}`);
    lines.push(`    MCP answers from       -> ${red(mcpWs)}`);
    lines.push("  Notes ingested without --workspace land in the shell workspace,");
    lines.push("  and the MCP will NOT see them. Either:");
    lines.push(`    (a) ingest with --workspace ${mcpWs}, or`);
    lines.push(`    (b) point the MCP at ${shellWs} in .mcp.json and restart Claude Code.`);
    exitCode = 1;
  } else {
    lines.push(green(bold(`  OK: both surfaces target ${mcpWs}.`)));
    lines.push("  Ingest and the MCP answer path agree on the corpus.");
    exitCode = 0;
  }

  lines.push("");
  process.stdout.write(lines.join("\n") + "\n");
  process.exit(exitCode);
}

main();
