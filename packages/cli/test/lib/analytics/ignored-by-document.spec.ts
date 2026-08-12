// F6: the ignored-evidence signal, aggregated per document.
//
// The value is one number a human can act on ("this note has been pushed into eleven
// turns and engaged with zero times"). The RISK is that the same number quietly becomes
// a ranking penalty, because ignored is a weak negative that cannot tell "useless" from
// "arrived before the question formed" -- which is the exact failure F1 exists for.
//
// So half of these tests are about what the aggregation must NOT do.

import { DocumentOfferRecord, ignoredDocuments } from "../../../src/lib/analytics/ignored-by-document";

function rec(over: Partial<DocumentOfferRecord> = {}): DocumentOfferRecord {
  return { offered_source_ids: [], referenced_source_ids: [], decided: true, ...over };
}

describe("F6 ignoredDocuments", () => {
  it("surfaces a document repeatedly offered and never once referenced", () => {
    const records = Array.from({ length: 4 }, () => rec({ offered_source_ids: ["NT:notes/quixnar.md"] }));
    const out = ignoredDocuments(records);
    expect(out).toEqual([{ source_id: "NT:notes/quixnar.md", offered: 4, referenced: 0 }]);
  });

  it("drops a document that was referenced even once", () => {
    // One reference is enough to say the document is not dead weight, and treating it as
    // ignored anyway is how a weak negative turns into a wrong one.
    const records = [
      rec({ offered_source_ids: ["NT:a.md"] }),
      rec({ offered_source_ids: ["NT:a.md"] }),
      rec({ offered_source_ids: ["NT:a.md"], referenced_source_ids: ["NT:a.md"] }),
    ];
    expect(ignoredDocuments(records)).toEqual([]);
  });

  it("needs repetition: one or two unreferenced offers is not a signal", () => {
    const records = [rec({ offered_source_ids: ["NT:new.md"] }), rec({ offered_source_ids: ["NT:new.md"] })];
    expect(ignoredDocuments(records)).toEqual([]);
    expect(ignoredDocuments([...records, rec({ offered_source_ids: ["NT:new.md"] })])).toHaveLength(1);
  });

  it("EXCLUDES windows that never closed", () => {
    // A pending window, or one that landed on the session's last turn, proves nothing
    // about the document: the agent never had a turn to act. Counting it would
    // manufacture ignored-ness out of an absent opportunity.
    const records = Array.from({ length: 5 }, () => rec({ offered_source_ids: ["NT:a.md"], decided: false }));
    expect(ignoredDocuments(records)).toEqual([]);
  });

  it("counts one inject as one offer even if the payload repeats the id", () => {
    const records = Array.from({ length: 3 }, () =>
      rec({ offered_source_ids: ["NT:a.md", "NT:a", "nt:A.MD"] }),
    );
    expect(ignoredDocuments(records)[0].offered).toBe(3);
  });

  it("joins ids the way every other join does", () => {
    const records = [
      rec({ offered_source_ids: ["NT:notes/a.md"] }),
      rec({ offered_source_ids: ["NT:notes/a.md"] }),
      rec({ offered_source_ids: ["NT:notes/a.md"], referenced_source_ids: ["nt:notes/a"] }),
    ];
    expect(ignoredDocuments(records)).toEqual([]);
  });

  it("orders by how often it was offered, so the loudest waste is first", () => {
    const records = [
      ...Array.from({ length: 3 }, () => rec({ offered_source_ids: ["NT:b.md"] })),
      ...Array.from({ length: 7 }, () => rec({ offered_source_ids: ["NT:a.md"] })),
    ];
    expect(ignoredDocuments(records).map((d) => d.source_id)).toEqual(["NT:a.md", "NT:b.md"]);
  });

  it("returns COUNTS and nothing a ranker could consume", () => {
    // The boundary, asserted structurally. If a score, weight, penalty or rank ever
    // appears on this shape, someone is about to feed a weak negative into ranking.
    const out = ignoredDocuments(Array.from({ length: 3 }, () => rec({ offered_source_ids: ["NT:a.md"] })));
    expect(Object.keys(out[0]).sort()).toEqual(["offered", "referenced", "source_id"]);
  });
});
