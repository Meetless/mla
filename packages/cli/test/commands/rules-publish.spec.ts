import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { openCe0Store, closeCe0Store, type Ce0Store } from "../../src/lib/rules/ce0-store";
import { runRulesPublish, type RulesPublishDeps } from "../../src/commands/rules";
import { NOTES_LOCATION_RULE_ID } from "../../src/lib/rules/attest-notes-location";
import {
  insertLocalRuleVersion,
  supersedeLiveLocalRuleVersion,
  type LocalRuleVersionRecord,
} from "../../src/lib/rules/local-rule-version-repo";
import type { WorkspaceCliConfig } from "../../src/lib/config";

// `mla rules publish` is the bridge half of the local-first rules engine: `attest` / `revoke` only ever
// mutate the local CE0 store; this command is the ONE place that pushes that local truth to control so the
// console Rules page can surface it. It reads every LIVE LocalRuleVersion in the active scope, maps each to
// a publish item (the headline pulled from the opaque payload), and POSTs the whole set. It is a thin IO
// shell over listLiveLocalRuleVersions + one network call, so every non-deterministic seam (the scope
// resolver, the store, the workspace config, the network post) is injected: the whole projection runs
// against one real ce0 database with no mock store and no real backend.

const PILOT_SCOPE = "/work/meetless";
const WORKSPACE_ID = "ws_pilot";
const OPERATOR_ID = "user_an";

let dir: string;
let dbPath: string;
let store: Ce0Store;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rules-publish-"));
  dbPath = path.join(dir, "ce0.db");
  store = openCe0Store(dbPath);
});

afterEach(() => {
  closeCe0Store(store);
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Seed one LIVE attested version in PILOT_SCOPE. payload + hash are opaque to the repo and command. */
function seedLive(over: Partial<LocalRuleVersionRecord> = {}): LocalRuleVersionRecord {
  const rec: LocalRuleVersionRecord = {
    versionId: "ver_notes",
    ruleId: NOTES_LOCATION_RULE_ID,
    runtimeScopeId: PILOT_SCOPE,
    rulePayload: '{"text":"All documentation must go to ~/projects/acme/docs"}',
    canonicalPayloadHash: "1".repeat(64),
    lifecycleStatus: "LIVE",
    attestationMethod: "HUMAN_DIRECT",
    attestedBy: OPERATOR_ID,
    supersedesVersionId: null,
    derivedFromObservedHash: "a".repeat(64),
    attestedAt: "2026-06-22T00:00:00.000Z",
    ...over,
  };
  insertLocalRuleVersion(store, rec);
  return rec;
}

type PublishFn = NonNullable<RulesPublishDeps["publish"]>;
type PublishBody = Parameters<PublishFn>[1];
type PublishResult = Awaited<ReturnType<PublishFn>>;

interface Recorder {
  out: string[];
  err: string[];
  bodies: PublishBody[];
}

function deps(over: Partial<RulesPublishDeps> = {}, result?: Partial<PublishResult>) {
  const rec: Recorder = { out: [], err: [], bodies: [] };
  const base: RulesPublishDeps = {
    storePath: dbPath,
    resolveRuntimeScopeId: () => PILOT_SCOPE,
    loadConfig: () => ({ workspaceId: WORKSPACE_ID }) as unknown as WorkspaceCliConfig,
    publish: async (_cfg, body) => {
      rec.bodies.push(body);
      return {
        published: body.rules.length,
        retired: 0,
        items: body.rules.map((r) => ({ ruleId: r.ruleId, candidateId: `cand_${r.ruleId}`, action: "published" as const })),
        ...result,
      };
    },
    out: (line: string) => rec.out.push(line),
    err: (line: string) => rec.err.push(line),
  };
  return { d: { ...base, ...over }, rec };
}

describe("mla rules publish (the CLI -> control bridge)", () => {
  it("projects every LIVE rule in scope to control with the workspace + scope and headline from payload", async () => {
    seedLive();
    const { d, rec } = deps();

    const code = await runRulesPublish([], d);

    expect(code).toBe(0);
    expect(rec.bodies).toHaveLength(1);
    const body = rec.bodies[0];
    expect(body.workspaceId).toBe(WORKSPACE_ID);
    expect(body.runtimeScopeId).toBe(PILOT_SCOPE);
    expect(body.rules).toHaveLength(1);
    const item = body.rules[0];
    expect(item).toMatchObject({
      ruleId: NOTES_LOCATION_RULE_ID,
      versionId: "ver_notes",
      text: "All documentation must go to ~/projects/acme/docs",
      payloadHash: "1".repeat(64),
      lifecycleStatus: "LIVE",
      attestedBy: OPERATOR_ID,
      attestedAt: "2026-06-22T00:00:00.000Z",
      attestationMethod: "HUMAN_DIRECT",
    });
    expect(rec.out.join("\n")).toContain("published 1");
  });

  it("sends every LIVE rule, ordered by ruleId (the repo's deterministic order)", async () => {
    seedLive({ versionId: "ver_notes", ruleId: NOTES_LOCATION_RULE_ID });
    seedLive({
      versionId: "ver_other",
      ruleId: "another-rule",
      canonicalPayloadHash: "2".repeat(64),
      rulePayload: '{"text":"never push without asking"}',
    });
    const { d, rec } = deps();

    const code = await runRulesPublish([], d);

    expect(code).toBe(0);
    const ids = rec.bodies[0].rules.map((r) => r.ruleId);
    expect(ids).toEqual(["another-rule", NOTES_LOCATION_RULE_ID]);
  });

  it("falls back to the logical id when the opaque payload has no `.text` (e.g. a code rule)", async () => {
    seedLive({
      versionId: "ver_code",
      ruleId: "consult-evidence",
      canonicalPayloadHash: "3".repeat(64),
      rulePayload: '{"schemaVersion":"ce0-rule-v1","ruleId":"consult-evidence"}',
    });
    const { d, rec } = deps();

    const code = await runRulesPublish([], d);

    expect(code).toBe(0);
    expect(rec.bodies[0].rules[0].text).toBe("consult-evidence");
  });

  it("excludes non-LIVE versions: a superseded rule is not sent", async () => {
    const first = seedLive({ versionId: "ver_old" });
    // Supersede the LIVE notes version with a new one; the old version flips to SUPERSEDED.
    supersedeLiveLocalRuleVersion(store, {
      ...first,
      versionId: "ver_new",
      canonicalPayloadHash: "9".repeat(64),
      supersedesVersionId: "ver_old",
      attestedAt: "2026-06-22T01:00:00.000Z",
    });
    const { d, rec } = deps();

    const code = await runRulesPublish([], d);

    expect(code).toBe(0);
    const sent = rec.bodies[0].rules;
    expect(sent).toHaveLength(1);
    expect(sent[0].versionId).toBe("ver_new");
  });

  it("still posts an empty set so a revoked-to-nothing scope reconciles away on the backend", async () => {
    const { d, rec } = deps({}, { published: 0, retired: 1, items: [{ ruleId: NOTES_LOCATION_RULE_ID, candidateId: "cand_x", action: "retired" }] });

    const code = await runRulesPublish([], d);

    expect(code).toBe(0);
    expect(rec.bodies).toHaveLength(1);
    expect(rec.bodies[0].rules).toEqual([]);
    expect(rec.bodies[0].runtimeScopeId).toBe(PILOT_SCOPE);
    expect(rec.out.join("\n")).toContain("retired 1");
  });

  it("emits machine-readable JSON under --json", async () => {
    seedLive();
    const { d, rec } = deps();

    const code = await runRulesPublish(["--json"], d);

    expect(code).toBe(0);
    const parsed = JSON.parse(rec.out.join("\n"));
    expect(parsed).toMatchObject({
      workspaceId: WORKSPACE_ID,
      runtimeScopeId: PILOT_SCOPE,
      published: 1,
      retired: 0,
    });
    expect(Array.isArray(parsed.items)).toBe(true);
  });

  it("exits 2 without calling the backend when no workspace is bound", async () => {
    seedLive();
    const { d, rec } = deps({
      loadConfig: () => {
        throw new Error("cli-config.json is missing required field 'workspaceId'");
      },
    });

    const code = await runRulesPublish([], d);

    expect(code).toBe(2);
    expect(rec.bodies).toEqual([]);
    expect(rec.err.join("\n")).toContain("workspaceId");
  });

  it("exits 1 and surfaces the error when the backend post fails", async () => {
    seedLive();
    const { d, rec } = deps({
      publish: async () => {
        throw new Error("503 control unavailable");
      },
    });

    const code = await runRulesPublish([], d);

    expect(code).toBe(1);
    expect(rec.err.join("\n")).toContain("failed to publish rules to control");
    expect(rec.err.join("\n")).toContain("503 control unavailable");
  });
});
