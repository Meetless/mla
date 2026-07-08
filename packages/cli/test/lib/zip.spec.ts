// Round-trip + integrity tests for the hand-rolled store-only ZIP writer
// (src/lib/zip.ts). The debug bundle (Phase 5) relies on createZip producing a
// readable archive; readStoredZip is the in-repo verifier so the tests never
// shell out to `unzip` or pull an archive library.

import { createZip, readStoredZip, crc32, ZipEntry } from "../../src/lib/zip";

describe("zip: store-only writer/reader (P5)", () => {
  it("round-trips a single entry byte-for-byte", () => {
    const entries: ZipEntry[] = [{ name: "a.txt", data: Buffer.from("hello world", "utf8") }];
    const out = readStoredZip(createZip(entries));
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("a.txt");
    expect(out[0].data.toString("utf8")).toBe("hello world");
  });

  it("round-trips many entries preserving names, order, and bytes", () => {
    const entries: ZipEntry[] = [
      { name: "manifest.json", data: Buffer.from(JSON.stringify({ trace_id: "x" }), "utf8") },
      { name: "logs/kb-knowledge.jsonl", data: Buffer.from('{"a":1}\n{"b":2}\n', "utf8") },
      { name: "README.txt", data: Buffer.from("share boundary", "utf8") },
    ];
    const out = readStoredZip(createZip(entries));
    expect(out.map((e) => e.name)).toEqual([
      "manifest.json",
      "logs/kb-knowledge.jsonl",
      "README.txt",
    ]);
    for (let i = 0; i < entries.length; i++) {
      expect(out[i].data.equals(entries[i].data)).toBe(true);
    }
  });

  it("handles an empty file and a binary payload", () => {
    const bin = Buffer.from([0x00, 0xff, 0x10, 0x7f, 0x80, 0x00, 0x01]);
    const entries: ZipEntry[] = [
      { name: "empty", data: Buffer.alloc(0) },
      { name: "bin.dat", data: bin },
    ];
    const out = readStoredZip(createZip(entries));
    expect(out[0].data.length).toBe(0);
    expect(out[1].data.equals(bin)).toBe(true);
  });

  it("preserves UTF-8 names and forward-slash paths", () => {
    const entries: ZipEntry[] = [{ name: "logs/gouvernancé/é.json", data: Buffer.from("{}", "utf8") }];
    const out = readStoredZip(createZip(entries));
    expect(out[0].name).toBe("logs/gouvernancé/é.json");
  });

  it("computes a known CRC-32 (matches the standard 'IEEE' check value)", () => {
    // CRC-32 of the ASCII string "123456789" is 0xCBF43926, the canonical
    // check value for the IEEE 802.3 polynomial this writer uses.
    expect(crc32(Buffer.from("123456789", "ascii")) >>> 0).toBe(0xcbf43926);
  });

  it("throws on a corrupted payload (CRC mismatch)", () => {
    const zip = createZip([{ name: "a.txt", data: Buffer.from("hello world", "utf8") }]);
    // Flip a byte inside the stored file data (just past the 30-byte local
    // header + 5-byte name "a.txt").
    const corrupt = Buffer.from(zip);
    const dataStart = 30 + Buffer.from("a.txt").length;
    corrupt[dataStart] = corrupt[dataStart] ^ 0xff;
    expect(() => readStoredZip(corrupt)).toThrow(/CRC mismatch/);
  });

  it("throws on a truncated archive (no end-of-central-directory)", () => {
    const zip = createZip([{ name: "a.txt", data: Buffer.from("x", "utf8") }]);
    // Drop the 22-byte EOCD record off the end.
    const truncated = zip.subarray(0, zip.length - 22);
    expect(() => readStoredZip(truncated)).toThrow(/end-of-central-directory/);
  });

  it("is deterministic: same inputs produce byte-identical archives", () => {
    const mk = () =>
      createZip([
        { name: "a.txt", data: Buffer.from("alpha", "utf8") },
        { name: "b.txt", data: Buffer.from("beta", "utf8") },
      ]);
    expect(mk().equals(mk())).toBe(true);
  });
});
