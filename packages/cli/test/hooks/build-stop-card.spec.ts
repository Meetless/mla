// test/hooks/build-stop-card.spec.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rescanAndCache } from "../../src/commands/scan-context";
import { scanCachePath } from "../../src/lib/scanner/cache";

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

// The Stop hook (build_stop_review_card in stop.sh) runs exactly this jq filter
// against the scan cache. This test asserts the cache produced by rescanAndCache
// satisfies that contract: staleSignals is a structured array the filter can slice
// to <=5 items of {id, detail, source} with a total count.
describe("stop review-card cache contract", () => {
  let repo: string;
  let home: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "mla-stop-repo-"));
    home = mkdtempSync(join(tmpdir(), "mla-stop-home-"));
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "t@t"]);
    git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "CLAUDE.md"), "- NEVER commit secrets.\n");
    mkdirSync(join(repo, "docs", "adr"), { recursive: true });
    writeFileSync(
      join(repo, "docs", "adr", "0007-x.md"),
      "# ADR-0007\nStatus: superseded by ADR-0012\n## Decision\nuse X\n",
    );
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "i"]);
    rescanAndCache({ cwd: repo, workspaceId: "ws1", home, now: () => "t" });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("the hook's jq filter yields a <=5-item card with id/detail/source and a total", () => {
    const cache = scanCachePath("ws1", home);
    const out = execFileSync(
      "jq",
      [
        "-c", "-n",
        "--slurpfile", "c", cache,
        "--arg", "sid", "s1",
        "--arg", "ts", "t",
        '{ ts: $ts, event: "review_card", session_id: $sid, items: (($c[0].staleSignals // [])[0:5] | map({id: .id, detail: .detail, source: .source})), total: (($c[0].staleSignals // []) | length) }',
      ],
      { encoding: "utf8" },
    );
    const card = JSON.parse(out);
    expect(card.event).toBe("review_card");
    expect(card.session_id).toBe("s1");
    expect(card.total).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(card.items)).toBe(true);
    expect(card.items.length).toBeLessThanOrEqual(5);
    expect(card.items.length).toBeGreaterThanOrEqual(1);
    const first = card.items[0];
    expect(typeof first.id).toBe("string");
    expect(first.id.length).toBeGreaterThan(0);
    expect(typeof first.detail).toBe("string");
    expect(first.source).toBe("docs/adr/0007-x.md");
  });
});
