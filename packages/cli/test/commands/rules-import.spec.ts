import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { runRulesImport } from "../../src/commands/rules";
import { openCe0Store, closeCe0Store } from "../../src/lib/rules/ce0-store";
import {
  insertLocalRuleVersion,
  type LocalRuleVersionRecord,
} from "../../src/lib/rules/local-rule-version-repo";
import { makeManagedRule, renderManagedRules } from "../../src/lib/scanner/managed-rules";
import type {
  ImportRulesBody,
  ImportRulesResult,
} from "../../src/lib/rules/control-rule-client";
import type { WorkspaceCliConfig } from "../../src/lib/config";

// `mla rules import` is the G2 one-time migration driver. These tests exercise it end-to-end against a
// REAL ce0 SQLite store and a REAL `.meetless/rules.md` on disk, mocking only the one process boundary:
// the POST to control (the importRules seam). They pin the built batch (CE0 -> PERSONAL, managed -> TEAM),
// the workspace scoping, the exit codes, and both output modes.

const SCOPE = "scope_a";
const WORKSPACE = "ws_1";

let dir: string;
let dbPath: string;
let root: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rules-import-"));
  dbPath = path.join(dir, "evidence.db");
  root = path.join(dir, "repo");
  fs.mkdirSync(root, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function version(over: Partial<LocalRuleVersionRecord> = {}): LocalRuleVersionRecord {
  return {
    versionId: "ver_1",
    ruleId: "rule_notes_location",
    runtimeScopeId: SCOPE,
    rulePayload: '{"text":"keep notes under /notes","runtimeScopeId":"scope_a"}',
    canonicalPayloadHash: "1".repeat(64),
    lifecycleStatus: "LIVE",
    attestationMethod: "HUMAN_DIRECT",
    attestedBy: "operator@example.com",
    supersedesVersionId: null,
    derivedFromObservedHash: "a".repeat(64),
    attestedAt: "2026-06-19T00:00:00.000Z",
    ...over,
  };
}

function seedCe0(rows: LocalRuleVersionRecord[]): void {
  const store = openCe0Store(dbPath);
  try {
    for (const r of rows) insertLocalRuleVersion(store, r);
  } finally {
    closeCe0Store(store);
  }
}

function writeManagedFile(statements: string[]): void {
  const rules = statements.map((s) => makeManagedRule({ statement: s, strength: "MUST_FOLLOW" }));
  fs.mkdirSync(path.join(root, ".meetless"), { recursive: true });
  fs.writeFileSync(path.join(root, ".meetless", "rules.md"), renderManagedRules(rules));
}

function result(over: Partial<ImportRulesResult> = {}): ImportRulesResult {
  return {
    rulesReceived: 0,
    rulesImported: 0,
    rulesSkipped: 0,
    rulesConflicted: 0,
    versionsMinted: 0,
    versionsSkipped: 0,
    conflicts: [],
    ...over,
  };
}

interface Harness {
  out: string[];
  err: string[];
  posted: ImportRulesBody[];
  run: (argv?: string[]) => Promise<number>;
}

function harness(opts: {
  importResult?: ImportRulesResult;
  importThrows?: Error;
  loadConfigThrows?: Error;
} = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const posted: ImportRulesBody[] = [];
  const cfg: WorkspaceCliConfig = { workspaceId: WORKSPACE, actorUserId: "user_1" } as WorkspaceCliConfig;
  const run = (argv: string[] = []) =>
    runRulesImport(argv, {
      cwd: root,
      resolveRuntimeScopeId: () => SCOPE,
      resolveRoot: () => root,
      resolveManagedAttestedAt: () => "2026-06-20T00:00:00.000Z",
      storePath: dbPath,
      openStore: openCe0Store,
      loadConfig: () => {
        if (opts.loadConfigThrows) throw opts.loadConfigThrows;
        return cfg;
      },
      importRules: async (_cfg, body) => {
        posted.push(body);
        if (opts.importThrows) throw opts.importThrows;
        return opts.importResult ?? result();
      },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
  return { out, err, posted, run };
}

describe("runRulesImport — batch construction", () => {
  it("builds CE0 PERSONAL rules (full history, oldest-first) and managed TEAM rules, scoped to the workspace", async () => {
    seedCe0([
      version({ versionId: "ver_1", canonicalPayloadHash: "1".repeat(64), lifecycleStatus: "SUPERSEDED", attestedAt: "2026-06-19T00:00:00.000Z" }),
      version({ versionId: "ver_2", canonicalPayloadHash: "2".repeat(64), lifecycleStatus: "LIVE", attestedAt: "2026-06-19T01:00:00.000Z" }),
    ]);
    writeManagedFile(["include a Mermaid diagram in design docs"]);

    const h = harness({ importResult: result({ rulesReceived: 2, rulesImported: 2, versionsMinted: 3 }) });
    const code = await h.run();

    expect(code).toBe(0);
    expect(h.posted).toHaveLength(1);
    const body = h.posted[0];
    expect(body.workspaceId).toBe(WORKSPACE);

    const ce0 = body.rules.find((r) => r.sourceRuleId === "rule_notes_location")!;
    expect(ce0.authorityScope).toBe("PERSONAL");
    expect(ce0.ownerUserId).toBe("operator@example.com");
    expect(ce0.lifecycleStatus).toBe("ACTIVE");
    expect(ce0.currentSourceVersionId).toBe("ver_2");
    expect(ce0.versions.map((v) => v.sourceVersionId)).toEqual(["ver_1", "ver_2"]);

    const managed = body.rules.find((r) => r.authorityScope === "TEAM")!;
    expect(managed.ownerUserId).toBeNull();
    expect(managed.versions).toHaveLength(1);
    expect(managed.versions[0].attestedAt).toBe("2026-06-20T00:00:00.000Z");
  });

  it("posts an empty batch (and still succeeds) when both legacy stores are empty", async () => {
    const h = harness({ importResult: result() });
    const code = await h.run();
    expect(code).toBe(0);
    expect(h.posted[0].rules).toEqual([]);
  });
});

describe("runRulesImport — exit codes", () => {
  it("returns 2 when the workspace is unbound (loadConfig throws)", async () => {
    const h = harness({ loadConfigThrows: new Error("no workspace bound") });
    const code = await h.run();
    expect(code).toBe(2);
    expect(h.err).toContain("no workspace bound");
    expect(h.posted).toHaveLength(0);
  });

  it("returns 1 when the POST to control fails", async () => {
    const h = harness({ importThrows: new Error("503 from control") });
    const code = await h.run();
    expect(code).toBe(1);
    expect(h.err.some((l) => l.includes("503 from control"))).toBe(true);
  });

  it("returns 1 when the importer refused a rule on a hash conflict", async () => {
    seedCe0([version()]);
    const h = harness({
      importResult: result({
        rulesReceived: 1,
        rulesConflicted: 1,
        conflicts: [
          { sourceRuleId: "rule_notes_location", sourceVersionId: "ver_1", reason: "hash mismatch", existingHash: "1".repeat(64), incomingHash: "9".repeat(64) },
        ],
      }),
    });
    const code = await h.run();
    expect(code).toBe(1);
    // The refused rule is surfaced in the human-readable block.
    expect(h.out.join("\n")).toContain("rule_notes_location / ver_1: hash mismatch");
  });
});

describe("runRulesImport — output modes", () => {
  it("emits a single JSON line carrying the scope, workspace, and result with --json", async () => {
    const h = harness({ importResult: result({ rulesReceived: 1, rulesImported: 1, versionsMinted: 1 }) });
    await h.run(["--json"]);
    expect(h.out).toHaveLength(1);
    const parsed = JSON.parse(h.out[0]);
    expect(parsed).toMatchObject({
      runtimeScopeId: SCOPE,
      workspaceId: WORKSPACE,
      rulesReceived: 1,
      rulesImported: 1,
      versionsMinted: 1,
    });
  });

  it("emits a human-readable block by default", async () => {
    const h = harness({ importResult: result({ rulesReceived: 1, rulesImported: 1 }) });
    await h.run();
    const text = h.out.join("\n");
    expect(text).toContain(`runtime scope: ${SCOPE}`);
    expect(text).toContain(`workspace:     ${WORKSPACE}`);
    expect(text).toContain("received 1 rule(s): imported 1");
  });
});
