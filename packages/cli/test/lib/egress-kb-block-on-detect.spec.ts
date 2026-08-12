// KB block-on-detect, proven at the TRANSPORT (Phase 2e of ruling §5).
//
// The scan used to live in the capture pipeline (live-pipeline.ts SECRET-1). That
// was a check, not a boundary, and the difference is the whole point of this file:
// `/internal/v1/kb/add` has THREE producers in this CLI, and only one of them ever
// passed through that pipeline.
//
//   src/lib/agent-memory-capture/upsert-client.ts:149   scanned (SECRET-1)
//   src/commands/kb_add.ts:1117                         NOT scanned
//   src/commands/enrich.ts:724                          NOT scanned
//
// So `mla kb add ./notes.md` on a file containing a live PAT wrote that PAT into
// the knowledge base, which is read back as fact and re-served to every future
// retrieval. `scanForCredentials` appears in exactly four modules and neither
// command is one of them.
//
// The registry rows are `block_on_detect` rather than `redact` because a redacted
// document is a WRONG document permanently (a `[REDACTED]` that used to be a
// version number is not a smaller answer, it is a false one), and rather than
// `passthrough` because passthrough is what put the credential in the KB. Scan
// every string leaf with the high-confidence denylist, send byte-exact when clean,
// refuse and name the rule ids when not.
//
// Everything below drives the REAL producers through the REAL intelPost and the
// REAL egressFetch. The only fake is `global.fetch`, which is the genuinely
// non-deterministic seam; the assertion that matters most is that it is never
// reached.
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { collectAndUploadOnce } from "../../src/lib/agent-memory-capture/live-pipeline";
import { createIntelUpsertClient } from "../../src/lib/agent-memory-capture/upsert-client";
import { EgressPolicyError } from "../../src/lib/egress/policy";
import { intelPost } from "../../src/lib/http";
import type { CliConfig } from "../../src/lib/config";
import type { MemoryBinding } from "../../src/lib/agent-memory-capture/types";

const NOW = "2026-07-27T00:00:00.000Z";

// A real credential FORMAT with a fake value. scanForCredentials matches on shape,
// so the shape has to be right; nothing here is or ever was a live secret.
const PAT = "gh" + "p_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

const cfg = {
  controlUrl: "https://control.invalid",
  controlToken: "internal-key-for-tests",
  intelUrl: "https://intel.invalid",
  mlaPath: "/tmp/mla",
  auth: { mode: "shared-key" },
} as unknown as CliConfig;

const kbAddBody = (content: string) => ({
  workspaceId: "ws-1",
  actor: "user-1",
  mode: "file" as const,
  documents: [{ relPath: "notes.md", content }],
});

describe("KB block-on-detect at the transport boundary", () => {
  let prevFetch: typeof fetch;
  let calls: Array<{ url: string; body: string }>;

  beforeEach(() => {
    prevFetch = global.fetch;
    calls = [];
    global.fetch = (async (url: unknown, init: { body?: unknown }) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ receipts: [{ outcome: "ingested" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = prevFetch;
  });

  const post = (body: unknown) =>
    intelPost(cfg, "/internal/v1/kb/add", body).then(
      () => null,
      (e: unknown) => e,
    );

  it("refuses a credential-bearing document from `mla kb add`", async () => {
    // The producer that never had a scan. This is the gap the move closes.
    const err = (await post(kbAddBody(`deploy with ${PAT}\n`))) as EgressPolicyError;

    expect(err).toBeInstanceOf(EgressPolicyError);
    expect(err.reason).toBe("blocked");
    expect(calls).toHaveLength(0); // never reached the network
  });

  it("names the rule ids and never the matched text", async () => {
    // Hard rule: a refusal explains itself by RULE, never by quoting what it
    // matched. An error message is logged, forwarded and pasted into tickets; a
    // message that quotes the secret has moved the secret somewhere new.
    const err = (await post(kbAddBody(`deploy with ${PAT}\n`))) as EgressPolicyError;

    // `provider_token` is the denylist's id for the ghp_/sk-/xoxb- family. The
    // operator gets a CLASS, which is enough to find the line themselves, and the
    // egress log gets nothing it would be embarrassing to retain.
    expect(err.message).toContain("provider_token");
    expect(err.message).toContain("/internal/v1/kb/add");
    expect(err.message).not.toContain(PAT);
    expect(err.message).not.toContain("ghp_");
  });

  it("states the remedy, because the obvious next move (re-run) can never work", async () => {
    // A refusal without a remedy sends the operator straight back to `mla kb add`,
    // where they are refused identically. This mode never rewrites the body, so
    // nothing changes until the SOURCE does, and the message is the only place
    // that fact is ever stated. Every caller inherits it: the refusal travels as
    // the error message, and `kb add` stamps that string onto the document receipt.
    const err = (await post(kbAddBody(`deploy with ${PAT}\n`))) as EgressPolicyError;

    expect(err.message).toMatch(/quote the shape, not the value/i);
    expect(err.message).toMatch(/re-?running refuses identically/i);
    // The remedy must not become the leak: a worked example that pasted the match
    // back in would defeat the assertion above it.
    expect(err.message).not.toContain(PAT);
  });

  it("sends a clean document BYTE-EXACT (this is why it is not `redact`)", async () => {
    // The other half of the contract, and the reason the mode exists. A KB write
    // that survived the scan must arrive unmodified: version numbers, paths and
    // hashes in a document are its content, and rewriting any of them would make
    // the KB confidently wrong.
    const content = "bump to v2.14.0 and run scripts/deploy.sh --env prod\n";
    const err = await post(kbAddBody(content));

    expect(err).toBeNull();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].body)).toEqual(kbAddBody(content));
  });

  it("scans nested string leaves, not just the top level", async () => {
    // `documents[].content` is two levels down. A top-level-only scan would have
    // been a decoration, since the document body is the only field that ever
    // carries a credential.
    const err = (await post({
      workspaceId: "ws-1",
      actor: "user-1",
      mode: "file",
      documents: [
        { relPath: "a.md", content: "clean" },
        { relPath: "b.md", content: `token=${PAT}` },
      ],
    })) as EgressPolicyError;

    expect(err.reason).toBe("blocked");
    expect(calls).toHaveLength(0);
  });

  it("holds when the producer-side scan is absent", async () => {
    // THE test that distinguishes "moved" from "duplicated". `scannerMode: "off"`
    // is the pipeline's own escape hatch; here it stands in for any producer that
    // does not scan, which is two of the three real ones. The pipeline hands raw
    // bytes to the real client, the real client calls the real intelPost, and the
    // upload still fails without a byte leaving the process.
    const home = mkdtempSync(join(tmpdir(), "kb-block-home-"));
    const mem = mkdtempSync(join(tmpdir(), "kb-block-mem-"));
    try {
      writeFileSync(
        join(mem, "a.md"),
        `---\nname: x\nmetadata:\n  type: project\n---\nexport GITHUB_TOKEN=${PAT}\n`,
      );
      const binding: MemoryBinding = {
        bindingId: "bind-1",
        memoryDir: mem,
        workspaceId: "ws-1",
        enabled: true,
        consentedAt: NOW,
      };

      const sum = await collectAndUploadOnce(binding, {
        client: createIntelUpsertClient(cfg),
        actor: "user-1",
        nowIso: NOW,
        home,
        scannerMode: "off",
      });

      const rec = sum.records.find((r) => r.relativePath === "a.md")!;
      expect(rec.outcome).toBe("failed");
      expect(rec.reason).toContain("upload_failed");
      expect(rec.reason).toContain("blocked");
      expect(rec.reason).not.toContain(PAT);
      expect(calls).toHaveLength(0);

      // And the refusal is not silently absorbed as success: an unsettled entry is
      // re-attempted next pass (RETRY-2), so a file blocked here never masquerades
      // as uploaded.
      expect(rec.revisionId).toBeUndefined();
    } finally {
      for (const d of [home, mem]) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it("still uploads a clean file through the real client", async () => {
    // The control arm. If the boundary refused everything the tests above would
    // pass for the wrong reason.
    const home = mkdtempSync(join(tmpdir(), "kb-clean-home-"));
    const mem = mkdtempSync(join(tmpdir(), "kb-clean-mem-"));
    try {
      writeFileSync(
        join(mem, "a.md"),
        `---\nname: x\nmetadata:\n  type: project\n---\na durable claim\n`,
      );
      const sum = await collectAndUploadOnce(
        {
          bindingId: "bind-1",
          memoryDir: mem,
          workspaceId: "ws-1",
          enabled: true,
          consentedAt: NOW,
        },
        {
          client: createIntelUpsertClient(cfg),
          actor: "user-1",
          nowIso: NOW,
          home,
        },
      );

      expect(sum.records.find((r) => r.relativePath === "a.md")!.outcome).toBe(
        "uploaded",
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain("/internal/v1/kb/add");
      expect(calls[0].body).toContain("a durable claim");
    } finally {
      for (const d of [home, mem]) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });
});
