import { injectedSnippets, parseEchoScanArgs, runInternalEchoScan } from "../../src/commands/internal-echo-scan";

// The F1b writer: what `mla _internal echo-scan` records, and what it refuses to record.
//
// The privacy shape is the part worth pinning. The scan reads the turn's text on stdin and
// writes SOURCE IDS. No turn output is stored, anywhere, ever, which is why the scan runs at
// Stop (where the text already exists in the hook that extracted it for report-citations)
// rather than in the recap (which runs a prompt later and would have to persist the text to
// see it at all).

function trace(opts: {
  session?: string;
  turn?: number;
  items?: { source_id: string | null; text: string; injected?: boolean }[];
}): Record<string, unknown> {
  return {
    session_id: opts.session ?? "s1",
    turn_index: opts.turn ?? 1,
    enrichment: {
      status: "ok",
      context_items: (opts.items ?? []).map((i, n) => ({
        id: `ctx_${n + 1}`,
        source_id: i.source_id,
        text: i.text,
        injected: i.injected !== false,
      })),
    },
  };
}

const QUOTE = "is_claim_trusted_for_generation gates the claim span evidence arm and pending claims are dropped";

describe("injectedSnippets", () => {
  it("takes only injected items that carry both an id and text", () => {
    const items = injectedSnippets(
      [
        trace({
          items: [
            { source_id: "NT:a.md", text: QUOTE },
            { source_id: "NT:b.md", text: "not injected", injected: false },
            { source_id: null, text: "a self-echo item carries no source id" },
            { source_id: "NT:c.md", text: "" },
          ],
        }),
      ],
      "s1",
      1,
    );
    expect(items).toEqual([{ source_id: "NT:a.md", text: QUOTE }]);
  });

  it("ignores other sessions and other turns", () => {
    const lines = [
      trace({ session: "s2", turn: 1, items: [{ source_id: "NT:a.md", text: QUOTE }] }),
      trace({ session: "s1", turn: 2, items: [{ source_id: "NT:b.md", text: QUOTE }] }),
    ];
    expect(injectedSnippets(lines, "s1", 1)).toEqual([]);
  });
});

describe("runInternalEchoScan", () => {
  it("writes the echoed ids, and stores no turn text", () => {
    const written: string[] = [];
    const rc = runInternalEchoScan(["--session", "s1", "--turn", "1"], {
      readTraces: () => [trace({ items: [{ source_id: "NT:a.md", text: QUOTE }] })],
      readStdin: () => `Correcting myself: ${QUOTE} there, so the earlier finding is wrong.`,
      appendLine: (l) => written.push(l),
      now: () => "2026-08-08T00:00:00.000Z",
    });
    expect(rc).toBe(0);
    expect(written).toHaveLength(1);
    const row = JSON.parse(written[0]);
    expect(row).toEqual({
      ts: "2026-08-08T00:00:00.000Z",
      event: "evidence_echo",
      session_id: "s1",
      turn_index: 1,
      source_ids: ["NT:a.md"],
    });
    // The whole privacy contract in one assertion: the row carries ids and nothing the agent
    // or the corpus said.
    expect(written[0]).not.toContain("Correcting myself");
    expect(written[0]).not.toContain("claim span");
  });

  it("writes an EMPTY row when the scan ran and found no quotation", () => {
    // "found nothing" and "never ran" must not be the same bytes. A stale zero that reads as
    // all-clear is the failure mode this project has already paid for once.
    const written: string[] = [];
    runInternalEchoScan(["--session", "s1", "--turn", "1"], {
      readTraces: () => [trace({ items: [{ source_id: "NT:a.md", text: QUOTE }] })],
      readStdin: () => "I went and read the code instead.",
      appendLine: (l) => written.push(l),
    });
    expect(JSON.parse(written[0]).source_ids).toEqual([]);
  });

  it("writes NO row when the turn offered nothing", () => {
    const written: string[] = [];
    runInternalEchoScan(["--session", "s1", "--turn", "1"], {
      readTraces: () => [trace({ items: [] })],
      readStdin: () => "anything",
      appendLine: (l) => written.push(l),
    });
    expect(written).toEqual([]);
  });

  it("is fail-soft on a broken stdin and on a broken spool", () => {
    const rcStdin = runInternalEchoScan(["--session", "s1", "--turn", "1"], {
      readTraces: () => [trace({ items: [{ source_id: "NT:a.md", text: QUOTE }] })],
      readStdin: () => {
        throw new Error("no stdin");
      },
      appendLine: () => undefined,
    });
    expect(rcStdin).toBe(0);

    const rcSpool = runInternalEchoScan(["--session", "s1", "--turn", "1"], {
      readTraces: () => {
        throw new Error("unreadable");
      },
      readStdin: () => "x",
    });
    expect(rcSpool).toBe(0);
  });

  it("exits 2 on a bad argv, like every other _internal subcommand", () => {
    const err = jest.spyOn(console, "error").mockImplementation(() => undefined);
    expect(runInternalEchoScan(["--turn", "0"])).toBe(2);
    expect(runInternalEchoScan(["--nope"])).toBe(2);
    err.mockRestore();
  });

  it("exits 0 with no row when session or turn is missing", () => {
    const written: string[] = [];
    expect(runInternalEchoScan([], { appendLine: (l) => written.push(l) })).toBe(0);
    expect(written).toEqual([]);
  });

  it("parses its argv strictly", () => {
    expect(parseEchoScanArgs(["--session", "s1", "--turn", "3"])).toEqual({ session: "s1", turn: 3 });
    expect(() => parseEchoScanArgs(["--turn", "x"])).toThrow();
  });
});
