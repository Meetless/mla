// The HTTP `mla kb add` resolves the notes vault root and the per-file
// vault-relative path CLIENT-SIDE (the CLI is the only side that holds the
// filesystem), then ships `{relPath, content}` to the intel route. The route
// prefixes the single `notes/` root and canonicalizes, so the externalObjectId
// matches the locally-seeded one byte-for-byte (dedup parity). This spec pins
// that client contract, which used to live in the python worker
// (tools/mla_kb_add.py: _resolve_vault_root / _enumerate_files /
// notes_external_object_id). It is the replacement for the deleted
// kb-add-path-resolve.spec.ts (which pinned the now-gone subprocess argv).

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  resolveVaultRoot,
  vaultRelPath,
  globFiles,
  readCorpusMarker,
  enumerateDocuments,
} from "../../src/commands/kb_add";

function mkTmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

describe("vaultRelPath", () => {
  const root = mkTmp("mla-vault-rel-");
  beforeAll(() => {
    fs.mkdirSync(path.join(root, "sub"), { recursive: true });
    fs.writeFileSync(path.join(root, "sub", "Worker-Note.md"), "body\n");
  });

  test("file inside vault -> POSIX relative path (server then canonicalizes)", () => {
    const rel = vaultRelPath(root, path.join(root, "sub", "Worker-Note.md"));
    // The wire value keeps the operator's casing/segments; the server lower-cases.
    expect(rel).toBe("sub/Worker-Note.md");
  });

  test("file outside vault throws (would escape the notes/ root)", () => {
    const outside = mkTmp("mla-vault-out-");
    fs.writeFileSync(path.join(outside, "stray.md"), "x\n");
    expect(() => vaultRelPath(root, path.join(outside, "stray.md"))).toThrow(
      /not inside the notes vault root/,
    );
  });
});

describe("resolveVaultRoot", () => {
  test("file mode honors MEETLESS_NOTES_ROOT", () => {
    const vault = mkTmp("mla-vault-env-");
    const file = path.join(vault, "a.md");
    fs.writeFileSync(file, "x\n");
    const prev = process.env.MEETLESS_NOTES_ROOT;
    process.env.MEETLESS_NOTES_ROOT = vault;
    try {
      expect(resolveVaultRoot({ mode: "file" }, file)).toBe(vault);
    } finally {
      if (prev === undefined) delete process.env.MEETLESS_NOTES_ROOT;
      else process.env.MEETLESS_NOTES_ROOT = prev;
    }
  });

  test("file mode falls back to a git-repo-root walk-up", () => {
    const repo = mkTmp("mla-vault-git-");
    fs.mkdirSync(path.join(repo, ".git"));
    fs.mkdirSync(path.join(repo, "notes"), { recursive: true });
    const file = path.join(repo, "notes", "b.md");
    fs.writeFileSync(file, "x\n");
    const prev = process.env.MEETLESS_NOTES_ROOT;
    delete process.env.MEETLESS_NOTES_ROOT;
    try {
      expect(resolveVaultRoot({ mode: "file" }, file)).toBe(repo);
    } finally {
      if (prev !== undefined) process.env.MEETLESS_NOTES_ROOT = prev;
    }
  });

  test("corpus mode resolves to the corpus folder itself", () => {
    const corpus = mkTmp("mla-vault-corpus-");
    expect(resolveVaultRoot({ mode: "corpus" }, corpus)).toBe(corpus);
  });
});

describe("globFiles (mirrors python Path.glob)", () => {
  const root = mkTmp("mla-glob-");
  beforeAll(() => {
    fs.mkdirSync(path.join(root, "deep"), { recursive: true });
    fs.writeFileSync(path.join(root, "top.md"), "x\n");
    fs.writeFileSync(path.join(root, "other.txt"), "x\n");
    fs.writeFileSync(path.join(root, ".hidden.md"), "x\n");
    fs.writeFileSync(path.join(root, "deep", "nested.md"), "x\n");
  });

  test("`*.md` is non-recursive and skips dotfiles", () => {
    expect(globFiles(root, "*.md")).toEqual([path.join(root, "top.md")]);
  });

  test("`**/*.md` is recursive (top + nested), sorted, dotfiles skipped", () => {
    expect(globFiles(root, "**/*.md")).toEqual(
      [path.join(root, "deep", "nested.md"), path.join(root, "top.md")].sort(),
    );
  });
});

describe("readCorpusMarker", () => {
  test("valid marker yields corpusName + guardrails", () => {
    const folder = mkTmp("mla-marker-ok-");
    fs.writeFileSync(
      path.join(folder, ".meetless-kb-corpus.json"),
      JSON.stringify({
        workspaceId: "ws_1",
        corpusName: "Decisions",
        allowedGlob: "**/*.md",
        allowedProvenance: ["human_authored"],
      }),
    );
    const m = readCorpusMarker(folder, "ws_1");
    expect(m.corpusName).toBe("Decisions");
    expect(m.allowedGlob).toBe("**/*.md");
    expect(m.allowedProvenance).toEqual(["human_authored"]);
  });

  test("workspace mismatch is refused (marker pins one workspace)", () => {
    const folder = mkTmp("mla-marker-ws-");
    fs.writeFileSync(
      path.join(folder, ".meetless-kb-corpus.json"),
      JSON.stringify({ workspaceId: "ws_other" }),
    );
    expect(() => readCorpusMarker(folder, "ws_1")).toThrow(/does NOT match/);
  });

  // Behaviour change (2026-07-21): a missing marker used to be refused, which made corpus mode
  // unusable for a first-time caller — the error named a file but not its schema. It now
  // synthesizes a permissive marker IN MEMORY (never written to the caller's folder, so a crash
  // cannot litter it). The guardrails remain opt-in: committing a marker still enforces them,
  // which the two tests below cover.
  test("missing marker synthesizes a permissive in-memory marker", () => {
    const folder = mkTmp("mla-marker-none-");
    const marker = readCorpusMarker(folder, "ws_1");
    expect(marker.synthesized).toBe(true);
    expect(marker.workspaceId).toBe("ws_1");
    expect(marker.allowedGlob).toBeNull();
    expect(marker.allowedProvenance).toBeNull();
    // nothing is written into the caller's folder
    expect(fs.existsSync(path.join(folder, ".meetless-kb-corpus.json"))).toBe(false);
  });

  test("an explicit marker is still honoured and is not flagged synthesized", () => {
    const folder = mkTmp("mla-marker-explicit-");
    fs.writeFileSync(
      path.join(folder, ".meetless-kb-corpus.json"),
      JSON.stringify({ workspaceId: "ws_1", allowedGlob: "**/*.md" }),
    );
    const marker = readCorpusMarker(folder, "ws_1");
    expect(marker.synthesized).toBe(false);
    expect(marker.allowedGlob).toBe("**/*.md");
  });
});

describe("enumerateDocuments", () => {
  test("file mode yields a single {relPath, content} doc", () => {
    const vault = mkTmp("mla-enum-file-");
    const file = path.join(vault, "note.md");
    fs.writeFileSync(file, "hello body\n");
    const { documents, skipped } = enumerateDocuments(
      { mode: "file", path: file, provenance: "human_authored", allowProvenanceChange: false, queue: false, open: false, reingestIfActive: false },
      file,
      vault,
      null,
    );
    expect(documents).toEqual([{ relPath: "note.md", content: "hello body\n" }]);
    expect(skipped).toEqual([]);
  });

  test("corpus mode globs the marker-pinned set under the folder", () => {
    const folder = mkTmp("mla-enum-corpus-");
    fs.writeFileSync(path.join(folder, "a.md"), "AAA\n");
    fs.writeFileSync(path.join(folder, "b.md"), "BBB\n");
    const marker = { workspaceId: "ws_1", corpusName: "C", allowedGlob: "*.md", allowedProvenance: null };
    const { documents } = enumerateDocuments(
      { mode: "corpus", path: folder, provenance: "human_authored", allowProvenanceChange: false, queue: false, open: false, reingestIfActive: false },
      folder,
      folder,
      marker,
    );
    expect(documents.map((d) => d.relPath).sort()).toEqual(["a.md", "b.md"]);
    expect(documents.find((d) => d.relPath === "a.md")?.content).toBe("AAA\n");
  });

  test("corpus mode rejects a --glob that fights the marker's allowedGlob", () => {
    const folder = mkTmp("mla-enum-glob-");
    fs.writeFileSync(path.join(folder, "a.md"), "AAA\n");
    const marker = { workspaceId: "ws_1", corpusName: "C", allowedGlob: "**/*.md", allowedProvenance: null };
    expect(() =>
      enumerateDocuments(
        { mode: "corpus", path: folder, provenance: "human_authored", glob: "*.txt", allowProvenanceChange: false, queue: false, open: false, reingestIfActive: false },
        folder,
        folder,
        marker,
      ),
    ).toThrow(/the marker wins/);
  });
});
