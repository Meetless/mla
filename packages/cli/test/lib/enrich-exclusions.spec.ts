import { spawnSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// F1 + F2 (2026-08-06): the hook must tell intel which candidates it ALREADY HAS,
// so a slot is never spent re-delivering them.
//
// THE DEFECT, measured on session 4ff1f7f5-28b4-4cc5-b09c-f6884e635bdd. Six operator
// prompts, 51,077 characters of context delivered, and 48,383 of them (94.7%) were
// TWO documents re-sent on three consecutive turns. One of the two the agent had
// WRITTEN during that same session: produced 04:11:01Z, auto-indexed 04:12:32Z,
// injected back into its own context at 15:39Z, 15:40Z and 01:45Z. Zero citations,
// and `carried_governed` recorded it as the best governed-delivery number in the
// series. The metric moved and the product got worse.
//
// TWO SIGNALS, BOTH LOCAL, NEITHER DERIVABLE SERVER-SIDE:
//
//   F1  WHO AUTHORED IT. The Zone-2 auto-index loop already records
//       {sessionId, workspaceId, canonicalPath} into ~/.meetless/logs/kb-knowledge.jsonl
//       at PRODUCE time, which is an exact origin-session fact. Verified against the
//       real store: the incident document is recorded under the incident session id,
//       and canonicalPath `notes/<basename>` joins the enrich citation `NT:notes/<basename>`.
//
//   F2  WHAT WAS ALREADY DELIVERED. Kept in a per-session sidecar beside the ones the
//       hook already owns (`.turns`, route-*.json, inject-*.json).
//
// THE REJECTED F1 DESIGN, recorded so it is not re-proposed: suppress when
// `kb_document.created_at > session_start`. That is TEMPORAL truth, not AUTHORSHIP
// truth -- a teammate or a concurrent agent publishing a governed decision mid-session
// satisfies it too, and suppressing that silences exactly the newly-governed material
// MLA exists to propagate. It is also measurably the wrong clock: the store recorded
// the incident document at 04:11:01Z and kb_document.created_at is 04:12:32Z, so that
// column is an INGESTION timestamp, not an authorship one.
//
// Only the shell is under test here; the matching server-side drop is
// intel/app/graphs/ask/enrich_exclusion_test.py.

const HOOKS_DIR = path.resolve(__dirname, "../../src/hooks-template");
const COMMON = path.join(HOOKS_DIR, "common.sh");

const WS = "cmexample0000000000000001";
const OTHER_WS = "ws-somebody-else";
const SID = "4ff1f7f5-28b4-4cc5-b09c-f6884e635bdd";
const OTHER_SID = "cdf1553e-a05f-4968-afc0-20ad53a62b40";

function requireTools(...tools: string[]): void {
  for (const t of tools) {
    if (spawnSync(t, ["--version"], { encoding: "utf8" }).status !== 0)
      throw new Error(`${t} required`);
  }
}

function home(): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "mla-excl-home-"));
  fs.mkdirSync(path.join(h, "queue"), { recursive: true });
  fs.mkdirSync(path.join(h, "logs", "governance"), { recursive: true });
  return h;
}

/** POSIX single-quote a string so a prompt with spaces/angle brackets survives `bash -c`. */
function shq(s: string): string {
  return `'` + s.replace(/'/g, `'\\''`) + `'`;
}

function inCommon(snippet: string, h: string, env: Record<string, string> = {}): string {
  const r = spawnSync("bash", ["-c", `source "${COMMON}" >/dev/null 2>&1; ${snippet}`], {
    encoding: "utf8",
    env: { ...process.env, MEETLESS_HOME: h, MEETLESS_DEBUG: "0", ...env },
  });
  return (r.stdout || "").trim();
}

/** One `active_memory_record` line, exactly as internal-auto-index writes it. */
function producedDoc(
  h: string,
  opts: { sessionId: string; workspaceId: string; canonicalPath: string; repoRoot?: string },
): void {
  const line =
    JSON.stringify({
      ts: "2026-08-06T04:11:01Z",
      event: "active_memory_record",
      workspaceId: opts.workspaceId,
      ownerUserId: "u1",
      repoRootHash: "abc",
      canonicalPath: opts.canonicalPath,
      contentHash: "deadbeef",
      sessionId: opts.sessionId,
      turnIndex: 1,
      sourceProduct: "claude_code",
      kind: "produced_doc",
      createdAt: new Date().toISOString(),
      repoRoot: opts.repoRoot ?? "/repo",
    }) + "\n";
  fs.appendFileSync(path.join(h, "logs", "kb-knowledge.jsonl"), line);
}

/** The `enrichment` object shape the hook parses out of the enrich response. */
function enrichment(items: Array<{ source_id: string | null; text: string; injected?: boolean }>): string {
  return JSON.stringify({
    status: "ok",
    context_items: items.map((i, n) => ({
      id: `ctx_${n + 1}`,
      kind: "architecture_constraint",
      source_id: i.source_id,
      provenance: "derived_from_accepted_kb",
      status: "accepted",
      text: i.text,
      injected: i.injected !== false,
    })),
  });
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

interface Exclusion {
  source_id: string;
  text_sha256?: string;
}

describe("session_authored_source_ids (common.sh): F1, the document this session wrote", () => {
  beforeAll(() => requireTools("jq"));

  it("returns the note THIS session produced, as an NT: citation", () => {
    const h = home();
    try {
      producedDoc(h, {
        sessionId: SID,
        workspaceId: WS,
        canonicalPath: "notes/20260806-mla-fix-proposal-execution-report.md",
      });
      const out = JSON.parse(inCommon(`session_authored_source_ids "${SID}" "${WS}"`, h));
      // The join key, verified against the real store: canonicalPath `notes/<base>`
      // becomes the enrich citation `NT:notes/<base>`.
      expect(out).toEqual(["NT:notes/20260806-mla-fix-proposal-execution-report.md"]);
    } finally {
      fs.rmSync(h, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it("NEVER returns a document another session produced", () => {
    // THE MUTATION TEST. This is the whole reason F1 keys on the producing session
    // rather than on a timestamp. A concurrent session's brand-new governed note is
    // the material MLA is FOR; suppressing it would be the worse bug.
    const h = home();
    try {
      producedDoc(h, { sessionId: OTHER_SID, workspaceId: WS, canonicalPath: "notes/theirs.md" });
      producedDoc(h, { sessionId: SID, workspaceId: WS, canonicalPath: "notes/mine.md" });
      const out = JSON.parse(inCommon(`session_authored_source_ids "${SID}" "${WS}"`, h));
      expect(out).toEqual(["NT:notes/mine.md"]);
    } finally {
      fs.rmSync(h, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it("never crosses a workspace boundary", () => {
    const h = home();
    try {
      producedDoc(h, { sessionId: SID, workspaceId: OTHER_WS, canonicalPath: "notes/foreign.md" });
      expect(JSON.parse(inCommon(`session_authored_source_ids "${SID}" "${WS}"`, h))).toEqual([]);
    } finally {
      fs.rmSync(h, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it("ignores records that are not produced_doc", () => {
    // A tagged_reference is a doc the USER named, not one the agent wrote.
    const h = home();
    try {
      const line =
        JSON.stringify({
          event: "active_memory_record",
          workspaceId: WS,
          canonicalPath: "notes/tagged.md",
          sessionId: SID,
          kind: "tagged_reference",
          createdAt: new Date().toISOString(),
        }) + "\n";
      fs.appendFileSync(path.join(h, "logs", "kb-knowledge.jsonl"), line);
      expect(JSON.parse(inCommon(`session_authored_source_ids "${SID}" "${WS}"`, h))).toEqual([]);
    } finally {
      fs.rmSync(h, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it("is empty, never an error, when the store does not exist", () => {
    const h = home();
    try {
      expect(inCommon(`session_authored_source_ids "${SID}" "${WS}"`, h)).toBe("[]");
    } finally {
      fs.rmSync(h, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });
});

describe("delivered ledger (common.sh): F2, the unchanged repeat", () => {
  beforeAll(() => requireTools("jq"));

  it("records a delivered item and excludes it WITH its content digest", () => {
    const h = home();
    try {
      const text = "Retire the QUIXNAR5377 lane: decommissioned.";
      inCommon(
        `record_delivered_sources "${SID}" 3 '${enrichment([{ source_id: "NT:notes/a.md", text }])}'`,
        h,
      );
      const out = JSON.parse(
        inCommon(`collect_excluded_sources "${SID}" "${WS}" 4`, h),
      ) as Exclusion[];
      expect(out).toEqual([{ source_id: "NT:notes/a.md", text_sha256: sha256(text) }]);
      // The digest MUST be over the exact delivered text: intel re-hashes the string
      // it composes and drops only on a match, so any other basis silently never
      // matches and repeat-suppression reads as broken rather than as a mismatch.
    } finally {
      fs.rmSync(h, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it("carries a CHANGED payload's new digest, so intel serves the new text", () => {
    const h = home();
    try {
      inCommon(
        `record_delivered_sources "${SID}" 3 '${enrichment([{ source_id: "NT:notes/a.md", text: "v1" }])}'`,
        h,
      );
      inCommon(
        `record_delivered_sources "${SID}" 4 '${enrichment([{ source_id: "NT:notes/a.md", text: "v2 REVISED" }])}'`,
        h,
      );
      const out = JSON.parse(
        inCommon(`collect_excluded_sources "${SID}" "${WS}" 5`, h),
      ) as Exclusion[];
      // Latest delivery wins: excluding on the STALE digest would let the unchanged
      // v2 be re-sent forever, which is the bug in the other direction.
      expect(out).toEqual([{ source_id: "NT:notes/a.md", text_sha256: sha256("v2 REVISED") }]);
    } finally {
      fs.rmSync(h, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it("EXPIRES an entry after the turn window, so suppression is never session-eternal", () => {
    // The bound that keeps this from becoming `at_most_once_per_source_per_session`.
    // A document worth re-reading much later in a long session must come back.
    const h = home();
    try {
      inCommon(
        `record_delivered_sources "${SID}" 1 '${enrichment([{ source_id: "NT:notes/a.md", text: "t" }])}'`,
        h,
      );
      const inside = JSON.parse(inCommon(`collect_excluded_sources "${SID}" "${WS}" 3`, h));
      expect(inside).toHaveLength(1);

      const outside = JSON.parse(inCommon(`collect_excluded_sources "${SID}" "${WS}" 99`, h));
      expect(outside).toEqual([]);
    } finally {
      fs.rmSync(h, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it("ignores items with no source_id (a self-echo is not a delivered source)", () => {
    const h = home();
    try {
      inCommon(
        `record_delivered_sources "${SID}" 3 '${enrichment([{ source_id: null, text: "mirror" }])}'`,
        h,
      );
      expect(inCommon(`collect_excluded_sources "${SID}" "${WS}" 4`, h)).toBe("[]");
    } finally {
      fs.rmSync(h, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it("never reads another session's ledger", () => {
    const h = home();
    try {
      inCommon(
        `record_delivered_sources "${OTHER_SID}" 3 '${enrichment([{ source_id: "NT:notes/theirs.md", text: "t" }])}'`,
        h,
      );
      expect(inCommon(`collect_excluded_sources "${SID}" "${WS}" 4`, h)).toBe("[]");
    } finally {
      fs.rmSync(h, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });
});

describe("collect_excluded_sources (common.sh): the two signals combine", () => {
  beforeAll(() => requireTools("jq"));

  it("emits the authored doc WITHOUT a digest and the delivered doc WITH one", () => {
    // The two semantics on one wire, which is what intel keys on: no digest means
    // "this session wrote it, drop any version"; a digest means "drop only this exact
    // payload, serve it again if it changed".
    const h = home();
    try {
      producedDoc(h, { sessionId: SID, workspaceId: WS, canonicalPath: "notes/mine.md" });
      inCommon(
        `record_delivered_sources "${SID}" 3 '${enrichment([{ source_id: "NT:notes/handed-to-me.md", text: "proposal body" }])}'`,
        h,
      );
      const out = JSON.parse(
        inCommon(`collect_excluded_sources "${SID}" "${WS}" 4`, h),
      ) as Exclusion[];
      const by = Object.fromEntries(out.map((e) => [e.source_id, e]));

      expect(by["NT:notes/mine.md"]).toEqual({ source_id: "NT:notes/mine.md" });
      expect(by["NT:notes/handed-to-me.md"]).toEqual({
        source_id: "NT:notes/handed-to-me.md",
        text_sha256: sha256("proposal body"),
      });
    } finally {
      fs.rmSync(h, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it("emits [] on a fresh session, so the request field is omitted entirely", () => {
    // compat: absent == today's behavior byte for byte.
    const h = home();
    try {
      expect(inCommon(`collect_excluded_sources "fresh-sid" "${WS}" 1`, h)).toBe("[]");
    } finally {
      fs.rmSync(h, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it("de-duplicates a doc that was BOTH authored here and delivered back", () => {
    // The exact incident shape: the agent wrote it, MLA served it back, so it is in
    // both sets. It must appear once, and unconditionally (authorship dominates).
    const h = home();
    try {
      producedDoc(h, { sessionId: SID, workspaceId: WS, canonicalPath: "notes/mine.md" });
      inCommon(
        `record_delivered_sources "${SID}" 3 '${enrichment([{ source_id: "NT:notes/mine.md", text: "my own note" }])}'`,
        h,
      );
      const out = JSON.parse(
        inCommon(`collect_excluded_sources "${SID}" "${WS}" 4`, h),
      ) as Exclusion[];
      expect(out).toEqual([{ source_id: "NT:notes/mine.md" }]);
    } finally {
      fs.rmSync(h, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });
});

// ---------------------------------------------------------------------------
// M1 (2026-08-10): a THIRD signal, and the first one that is not about what MLA
// already sent.
//
// THE DEFECT, measured over the whole local ledger (4,892 traces joined turn by turn
// against the Claude Code transcripts): on turns where the harness told MLA a `.md`
// file was OPEN in the editor AND MLA delivered a payload, the payload contained that
// same file on 13 of 32 (41%), across 13 distinct sessions. 13 of the 88 delivered
// items on those turns (15%) were the file the operator was already looking at.
//
// BOTH EXISTING EXCLUSION SETS ASK "DID MLA ALREADY SEND THIS?". Neither asks "does
// the agent ALREADY HAVE IT?", and an open editor buffer is the strongest possible
// statement that it does. The slot is byte-budgeted (one measured turn cut 14 of 16
// candidates), so a redundant item is a non-redundant one that did not ship.
//
// NOT SELF-ECHO, and the existing detector is structurally blind to it:
// `classify_selected` keys on `agent-observation` provenance, and these are ordinary
// governed notes carrying `derived_from_accepted_kb`. Every dashboard reads such a turn
// as a perfect governed delivery.
//
// RESOLUTION IS EXACT, NEVER FUZZY. The prompt names a path; the same
// `kb-knowledge.jsonl` store F1 already reads records `repoRoot` + `canonicalPath` for
// every indexed doc, so `repoRoot + "/" + canonicalPath == <the path the prompt named>`
// is an exact match against a recorded corpus entry. Verified against the real store:
// all 13 mirrored documents resolve, each to exactly one canonical path. A bare
// filename resolves only when exactly ONE governed source carries that basename;
// two candidates means neither is excluded, because over-excluding silences a
// document the operator never had.
// ---------------------------------------------------------------------------

describe("prompt_named_source_ids (common.sh): M1, the document the agent ALREADY HAS", () => {
  beforeAll(() => requireTools("jq"));

  const ide = (p: string) =>
    `<ide_opened_file>The user opened the file ${p} in the IDE. This may or may not be related to the current task.</ide_opened_file>\nis this ready to ship?`;

  it("resolves an <ide_opened_file> absolute path to the governed id it maps to", () => {
    const h = home();
    try {
      producedDoc(h, {
        sessionId: OTHER_SID,
        workspaceId: WS,
        canonicalPath: "notes/20260809-open.md",
        repoRoot: "/Users/alice/projects/app",
      });
      const out = JSON.parse(
        inCommon(
          `prompt_named_source_ids ${shq(ide("/Users/alice/projects/app/notes/20260809-open.md"))} "${WS}"`,
          h,
        ),
      );
      expect(out).toEqual(["NT:notes/20260809-open.md"]);
    } finally {
      fs.rmSync(h, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it("reads an <ide_selection> envelope too (the operator pointed at it just as hard)", () => {
    const h = home();
    try {
      producedDoc(h, {
        sessionId: OTHER_SID,
        workspaceId: WS,
        canonicalPath: "notes/sel.md",
        repoRoot: "/Users/alice/projects/app",
      });
      const p = "<ide_selection>The user selected lines 40 to 51 from /Users/alice/projects/app/notes/sel.md</ide_selection>\nwhat does this mean?";
      expect(JSON.parse(inCommon(`prompt_named_source_ids ${shq(p)} "${WS}"`, h))).toEqual([
        "NT:notes/sel.md",
      ]);
    } finally {
      fs.rmSync(h, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it("INVENTS NOTHING for a path the corpus never recorded", () => {
    // The failure this forecloses: constructing `NT:notes/<basename>` by string algebra.
    // A path with no recorded corpus entry is not a governed source and must not be
    // named as one, or the exclusion set fills with ids that mean nothing to intel.
    const h = home();
    try {
      producedDoc(h, { sessionId: OTHER_SID, workspaceId: WS, canonicalPath: "notes/real.md" });
      expect(inCommon(`prompt_named_source_ids ${shq(ide("/tmp/scratch/never-indexed.md"))} "${WS}"`, h)).toBe("[]");
    } finally {
      fs.rmSync(h, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it("resolves a BARE filename when exactly one governed source carries that basename", () => {
    const h = home();
    try {
      producedDoc(h, { sessionId: OTHER_SID, workspaceId: WS, canonicalPath: "notes/unique-name.md" });
      const out = JSON.parse(
        inCommon(`prompt_named_source_ids ${shq("re-read notes/unique-name.md and tell me what changed")} "${WS}"`, h),
      );
      expect(out).toEqual(["NT:notes/unique-name.md"]);
    } finally {
      fs.rmSync(h, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it("REFUSES a bare filename two governed sources could mean (E2: ambiguity excludes neither)", () => {
    // The one real basename collision in the served corpus is `readme.md`, at
    // `notes/readme.md` and `notes/meetless-cli/packages/cli/readme.md`. A bare mention
    // cannot say which, so neither is excluded: a wrong exclusion silences a document
    // the operator does not have, which is strictly worse than one redundant delivery.
    const h = home();
    try {
      producedDoc(h, { sessionId: OTHER_SID, workspaceId: WS, canonicalPath: "notes/readme.md" });
      producedDoc(h, {
        sessionId: OTHER_SID,
        workspaceId: WS,
        canonicalPath: "notes/meetless-cli/packages/cli/readme.md",
      });
      expect(inCommon(`prompt_named_source_ids ${shq("check readme.md before you answer")} "${WS}"`, h)).toBe("[]");
    } finally {
      fs.rmSync(h, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it("still resolves an ABSOLUTE path whose basename is ambiguous (the path disambiguates it)", () => {
    // The other half of the collision rule: ambiguity is a property of the REFERENCE,
    // not of the document. A full path names exactly one file.
    const h = home();
    try {
      producedDoc(h, {
        sessionId: OTHER_SID,
        workspaceId: WS,
        canonicalPath: "notes/readme.md",
        repoRoot: "/Users/alice/projects/app",
      });
      producedDoc(h, {
        sessionId: OTHER_SID,
        workspaceId: WS,
        canonicalPath: "notes/meetless-cli/packages/cli/readme.md",
        repoRoot: "/Users/alice/projects/app",
      });
      const out = JSON.parse(
        inCommon(`prompt_named_source_ids ${shq(ide("/Users/alice/projects/app/notes/readme.md"))} "${WS}"`, h),
      );
      expect(out).toEqual(["NT:notes/readme.md"]);
    } finally {
      fs.rmSync(h, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it("returns EVERY id form of ONE absolute path (a doc indexed under two roots is one doc)", () => {
    // Measured on the real store: 12 absolute paths are recorded under two canonical
    // forms, and the served corpus shows the same document delivered as both
    // `NT:notes/x.md` and `NT:x.md`. Excluding one form leaves the other free to be
    // served, which is the defect surviving its own fix.
    const h = home();
    try {
      producedDoc(h, {
        sessionId: OTHER_SID,
        workspaceId: WS,
        canonicalPath: "notes/twoforms.md",
        repoRoot: "/Users/alice/projects/app",
      });
      producedDoc(h, {
        sessionId: OTHER_SID,
        workspaceId: WS,
        canonicalPath: "twoforms.md",
        repoRoot: "/Users/alice/projects/app/notes",
      });
      const out = JSON.parse(
        inCommon(`prompt_named_source_ids ${shq(ide("/Users/alice/projects/app/notes/twoforms.md"))} "${WS}"`, h),
      ).sort();
      expect(out).toEqual(["NT:notes/twoforms.md", "NT:twoforms.md"]);
    } finally {
      fs.rmSync(h, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it("never resolves against ANOTHER workspace's corpus", () => {
    const h = home();
    try {
      producedDoc(h, {
        sessionId: OTHER_SID,
        workspaceId: OTHER_WS,
        canonicalPath: "notes/theirs.md",
        repoRoot: "/Users/alice/projects/app",
      });
      expect(inCommon(`prompt_named_source_ids ${shq(ide("/Users/alice/projects/app/notes/theirs.md"))} "${WS}"`, h)).toBe("[]");
    } finally {
      fs.rmSync(h, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it("is silent on a prompt that names no document at all", () => {
    const h = home();
    try {
      producedDoc(h, { sessionId: OTHER_SID, workspaceId: WS, canonicalPath: "notes/a.md" });
      expect(inCommon(`prompt_named_source_ids ${shq("what did we decide about the replication lane?")} "${WS}"`, h)).toBe("[]");
    } finally {
      fs.rmSync(h, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it("takes the fork-free fast path when the prompt contains no `.md` at all", () => {
    // MEASURED, and the reason the guard exists: the extraction costs ~48ms even when it
    // finds nothing, because it spawns grep/sed/sort before it can know that, and only
    // ~5% of real prompts name a `.md` (253 of 4,892). The assertion is behavioural
    // rather than a timing: a store whose every line would match is present, and the
    // answer is still empty, so the substring guard returned before reading it.
    const h = home();
    try {
      producedDoc(h, { sessionId: OTHER_SID, workspaceId: WS, canonicalPath: "notes/lane.md" });
      expect(inCommon(`prompt_named_source_ids ${shq("what did we decide about lane and notes and the outbox?")} "${WS}"`, h)).toBe("[]");
      // ...and the guard is a SUBSTRING test, not a word test: a path glued to prose
      // must still resolve, or the fast path becomes a silent recall bug.
      producedDoc(h, {
        sessionId: OTHER_SID,
        workspaceId: WS,
        canonicalPath: "notes/glued.md",
        repoRoot: "/Users/alice/projects/app",
      });
      expect(
        JSON.parse(inCommon(`prompt_named_source_ids ${shq("see(/Users/alice/projects/app/notes/glued.md)now")} "${WS}"`, h)),
      ).toEqual(["NT:notes/glued.md"]);
    } finally {
      fs.rmSync(h, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });
});

describe("collect_excluded_sources (common.sh): M1 joins the union", () => {
  beforeAll(() => requireTools("jq"));

  it("adds the prompt-named source WITHOUT a digest, so any version is dropped", () => {
    // No digest is the right semantic: the agent has the file OPEN, so it holds
    // whatever version is on disk, not the one payload MLA happened to compose.
    const h = home();
    try {
      producedDoc(h, {
        sessionId: OTHER_SID,
        workspaceId: WS,
        canonicalPath: "notes/open.md",
        repoRoot: "/Users/alice/projects/app",
      });
      const prompt = `<ide_opened_file>The user opened the file /Users/alice/projects/app/notes/open.md in the IDE.</ide_opened_file>\nreview it`;
      const out = JSON.parse(
        inCommon(`collect_excluded_sources "${SID}" "${WS}" 1 ${shq(prompt)}`, h),
      ) as Exclusion[];
      expect(out).toEqual([{ source_id: "NT:notes/open.md" }]);
    } finally {
      fs.rmSync(h, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it("de-duplicates a doc that is BOTH named in the prompt and delivered earlier", () => {
    // Prompt-naming DOMINATES the delivered ledger for the same reason authorship does:
    // the agent has the file, so no version of it is worth a slot.
    const h = home();
    try {
      producedDoc(h, {
        sessionId: OTHER_SID,
        workspaceId: WS,
        canonicalPath: "notes/open.md",
        repoRoot: "/Users/alice/projects/app",
      });
      inCommon(
        `record_delivered_sources "${SID}" 1 '${enrichment([{ source_id: "NT:notes/open.md", text: "body" }])}'`,
        h,
      );
      const prompt = `<ide_opened_file>The user opened the file /Users/alice/projects/app/notes/open.md in the IDE.</ide_opened_file>\nreview it`;
      const out = JSON.parse(
        inCommon(`collect_excluded_sources "${SID}" "${WS}" 2 ${shq(prompt)}`, h),
      ) as Exclusion[];
      expect(out).toEqual([{ source_id: "NT:notes/open.md" }]);
    } finally {
      fs.rmSync(h, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it("survives a session that authored NOTHING (the pipefail double-[] that ate the union)", () => {
    // THE LATENT DEFECT M1 SURFACED. common.sh runs under `set -euo pipefail`, so the
    // `grep | tail | jq ... || printf '[]'` in `session_authored_source_ids` prints
    // `[]` TWICE when the grep matches nothing: jq emits one, the failed pipeline
    // triggers the `||` and it emits another. `[]\n[]` passes a `[*]` glob and is not
    // valid JSON, so the `--argjson` splice aborted and the function returned `[]` --
    // silently discarding every OTHER exclusion it had correctly computed.
    //
    // Invisible while the union's only other term was also empty. This is the shape
    // that proves it: nothing authored, something named, and the named one must survive.
    const h = home();
    try {
      producedDoc(h, {
        sessionId: OTHER_SID, // NOT this session: the authored set must come back empty
        workspaceId: WS,
        canonicalPath: "notes/open.md",
        repoRoot: "/Users/alice/projects/app",
      });
      const prompt = `<ide_opened_file>/Users/alice/projects/app/notes/open.md</ide_opened_file>\nreview`;
      expect(inCommon(`session_authored_source_ids "${SID}" "${WS}"`, h)).toBe("[]");
      expect(JSON.parse(inCommon(`collect_excluded_sources "${SID}" "${WS}" 1 ${shq(prompt)}`, h))).toEqual([
        { source_id: "NT:notes/open.md" },
      ]);
    } finally {
      fs.rmSync(h, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it("is byte-for-byte today's behavior when the prompt argument is absent", () => {
    // compat: every existing caller and every existing test passes three arguments.
    const h = home();
    try {
      producedDoc(h, { sessionId: SID, workspaceId: WS, canonicalPath: "notes/mine.md" });
      expect(JSON.parse(inCommon(`collect_excluded_sources "${SID}" "${WS}" 4`, h))).toEqual([
        { source_id: "NT:notes/mine.md" },
      ]);
    } finally {
      fs.rmSync(h, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });
});

// ---------------------------------------------------------------------------
// Layer 2: the WIRE. The two contracts above are useless unless the real hook
// actually puts them in the enrich body, which is the seam the I4 recent_turns
// defect proved is invisible from either end alone: a well-formed request that
// legitimately carries nothing looks identical to a field that was never wired.
// ---------------------------------------------------------------------------

import { spawn } from "child_process";
import * as http from "http";
import { AddressInfo } from "net";

const HOOK = "user-prompt-submit.sh";

/** Intel stub that RECORDS request bodies and serves one governed citation. */
function startRecordingStub(delivered: { source_id: string; text: string }): Promise<{
  port: number;
  enrich: any[];
  close: () => Promise<void>;
}> {
  const enrich: any[] = [];
  const sockets = new Set<import("net").Socket>();
  const server = http.createServer((req, res) => {
    let chunks = "";
    req.on("data", (c) => (chunks += c));
    req.on("end", () => {
      let parsed: any = null;
      try {
        parsed = JSON.parse(chunks || "{}");
      } catch {
        parsed = { __unparseable: chunks };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      if ((req.url ?? "").includes("/v1/ask")) {
        enrich.push(parsed);
        res.end(
          JSON.stringify({
            enrichment: {
              strategy: "retrieval_only",
              status: "ok",
              confidence: "high",
              markdown: `- [accepted][${delivered.source_id}] ${delivered.text}`,
              fields_present: [],
              context_items: [
                {
                  id: "ctx_1",
                  kind: "architecture_constraint",
                  source_id: delivered.source_id,
                  provenance: "derived_from_accepted_kb",
                  status: "accepted",
                  text: delivered.text,
                  injected: true,
                },
              ],
            },
            steps: [],
          }),
        );
      } else {
        res.end("{}");
      }
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        enrich,
        close: () =>
          new Promise<void>((r) => {
            sockets.forEach((s) => s.destroy());
            server.close(() => r());
          }),
      });
    });
  });
}

/** Run the REAL hook N times against ONE home: turn N's body is evidence about N-1. */
async function runWiredTurns(opts: {
  prompts: string[];
  sid: string;
  delivered: { source_id: string; text: string };
  authored?: string[];
  /** M1: docs in the corpus that some OTHER session produced, so the prompt can name one. */
  indexed?: Array<{ canonicalPath: string; repoRoot: string }>;
}): Promise<any[]> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-wired-excl-"));
  const stub = await startRecordingStub(opts.delivered);
  try {
    for (const f of [COMMON, path.join(HOOKS_DIR, "home.sh"), path.join(HOOKS_DIR, HOOK)]) {
      fs.copyFileSync(f, path.join(tmp, path.basename(f)));
    }
    fs.chmodSync(path.join(tmp, HOOK), 0o755);

    const h = path.join(tmp, "home");
    fs.mkdirSync(path.join(h, "queue"), { recursive: true });
    fs.mkdirSync(path.join(h, "logs", "governance"), { recursive: true });
    fs.writeFileSync(
      path.join(h, "cli-config.json"),
      JSON.stringify({
        controlUrl: "http://127.0.0.1:1",
        intelUrl: `http://127.0.0.1:${stub.port}`,
        controlToken: "ik-test",
        workspaceId: "ws_test",
        mlaPath: process.env.MLA_TEST_MLA_SHIM ?? "/usr/bin/true",
      }),
    );
    for (const p of opts.authored ?? []) {
      producedDoc(h, { sessionId: opts.sid, workspaceId: "ws_test", canonicalPath: p });
    }
    for (const d of opts.indexed ?? []) {
      // A DIFFERENT session id on purpose: this must resolve as "the agent has it open",
      // not as "this session authored it", or the test passes through the F1 path.
      producedDoc(h, {
        sessionId: "some-other-session",
        workspaceId: "ws_test",
        canonicalPath: d.canonicalPath,
        repoRoot: d.repoRoot,
      });
    }

    const workdir = path.join(tmp, "workdir");
    fs.mkdirSync(workdir);
    // The marker MUST carry workspaceId: that is where the hook resolves
    // $WORKSPACE_ID from (common.sh meetless_activated), and F1 is workspace-scoped.
    // A bare `{}` leaves it empty, which fails F1 CLOSED (no exclusions, today's
    // behavior) and would let this test pass vacuously against a real activation.
    fs.writeFileSync(path.join(workdir, ".meetless.json"), JSON.stringify({ workspaceId: "ws_test" }) + "\n");

    for (const prompt of opts.prompts) {
      await new Promise<void>((resolve, reject) => {
        const child = spawn("bash", [path.join(tmp, HOOK)], {
          cwd: workdir,
          env: { ...process.env, MEETLESS_HOME: h, MEETLESS_DEBUG: "0" },
        });
        child.stdout.on("data", () => {});
        child.stderr.on("data", () => {});
        child.on("error", reject);
        child.on("close", () => resolve());
        child.stdin.write(JSON.stringify({ session_id: opts.sid, prompt }));
        child.stdin.end();
      });
    }
    return stub.enrich;
  } finally {
    await stub.close();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
}

describe("user-prompt-submit.sh puts the exclusions on the wire", () => {
  beforeAll(() => requireTools("jq", "curl"));

  it("omits exclude_sources on turn 1 and carries the delivered source on turn 2", async () => {
    const text = "The QUIXNAR5377 lane is decommissioned.";
    const bodies = await runWiredTurns({
      sid: "sess-excl-wire",
      delivered: { source_id: "NT:notes/lane.md", text },
      prompts: [
        "what did we decide about the replication lane?",
        "what did we decide about the replication lane again?",
      ],
    });

    expect(bodies.length).toBeGreaterThanOrEqual(2);
    // Turn 1: nothing is held yet, so the field must be ABSENT, not an empty array.
    // Absent is the compat contract (6.2): the request is byte-identical to today's.
    expect(bodies[0].exclude_sources).toBeUndefined();
    // Turn 2: the payload delivered on turn 1 is declared, WITH its digest, so intel
    // drops it only while it is unchanged. This is the 82-second re-send from the
    // measured session.
    expect(bodies[1].exclude_sources).toEqual([
      { source_id: "NT:notes/lane.md", text_sha256: sha256(text) },
    ]);
  }, 60000);

  it("carries a note THIS session authored, with NO digest, from the very first turn", async () => {
    const bodies = await runWiredTurns({
      sid: "sess-excl-authored",
      delivered: { source_id: "NT:notes/unrelated.md", text: "unrelated" },
      authored: ["notes/20260806-mla-fix-proposal-execution-report.md"],
      prompts: ["review the execution report"],
    });

    expect(bodies.length).toBeGreaterThanOrEqual(1);
    // No digest: the agent wrote it, so no revision of it is prior knowledge here.
    expect(bodies[0].exclude_sources).toEqual([
      { source_id: "NT:notes/20260806-mla-fix-proposal-execution-report.md" },
    ]);
  }, 60000);

  it("M1: carries the file the IDE says is OPEN, on the FIRST turn, with no digest", async () => {
    // The whole point of M1 is that this fires on turn 1. The delivered ledger cannot:
    // it only knows what MLA already sent, and on turn 1 that is nothing. The 41% of
    // mirrored turns measured across 13 sessions are overwhelmingly first contact with
    // the document, which is exactly when the operator has just opened it.
    const bodies = await runWiredTurns({
      sid: "sess-excl-m1-ide",
      delivered: { source_id: "NT:notes/unrelated.md", text: "unrelated" },
      indexed: [{ canonicalPath: "notes/20260809-open.md", repoRoot: "/Users/alice/projects/app" }],
      prompts: [
        "<ide_opened_file>The user opened the file /Users/alice/projects/app/notes/20260809-open.md in the IDE. " +
          "This may or may not be related to the current task.</ide_opened_file>\nis this proposal ready to ship?",
      ],
    });

    expect(bodies.length).toBeGreaterThanOrEqual(1);
    expect(bodies[0].exclude_sources).toEqual([{ source_id: "NT:notes/20260809-open.md" }]);
  }, 60000);
});
