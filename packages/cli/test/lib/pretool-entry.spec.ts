import { runPretoolEntry } from "../../src/pretool-entry";

// Lever A (notes/20260615-rules-as-node-...-consolidated-proposal.md latency lever):
// the managed pre-tool-use.sh hook runs `node dist/pretool-entry.js` directly instead
// of `mla _internal pretool-observe` so the deny decision pays ONLY its own require
// graph (~12ms cold) rather than cli.js's full command registry (~150ms). pretool-entry
// is a thin IO shell over the SAME runInternalPretoolObserve core, so the decision is
// identical by construction; only the cold-start cost changes. These specs pin the two
// invariants that make swapping the transport safe: the core's exit code is forwarded
// verbatim, and an unexpected entrypoint fault fails OPEN (exit 0) so a tool is never
// blocked on infrastructure.
describe("pretool-entry: the minimal PreToolUse entrypoint wrapper", () => {
  it("forwards the observe core's exit code to exit", async () => {
    const exits: number[] = [];
    await runPretoolEntry(async () => 0, (c) => exits.push(c));
    expect(exits).toEqual([0]);
  });

  it("invokes the observe core with no argv (the decision rides stdin, never the args)", async () => {
    let seen: string[] | null = null;
    await runPretoolEntry(
      async (argv) => {
        seen = argv;
        return 0;
      },
      () => {},
    );
    expect(seen).toEqual([]);
  });

  it("fails OPEN (exit 0) when the observe core rejects -- an entrypoint fault must never block a tool", async () => {
    const exits: number[] = [];
    await runPretoolEntry(
      async () => {
        throw new Error("boom");
      },
      (c) => exits.push(c),
    );
    expect(exits).toEqual([0]);
  });
});
