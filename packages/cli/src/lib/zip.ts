// Zero-dependency, store-only (uncompressed) ZIP writer + reader.
//
// The mla CLI deliberately keeps a tiny dependency surface (Phase 4.5 OSS
// hardening: only @sentry/node + the workspace trace-core). The Phase 5 debug
// bundle (gap 6.7) needs to emit a single .zip; pulling in archiver/adm-zip just
// for that would undo that hardening. A store-only ZIP is a small, well-specified
// container (PKWARE APPNOTE: local file header + central directory + end-of-
// central-directory), so we hand-roll it here with only Node built-ins.
//
// "Store" means no compression: the file bytes appear verbatim. That is fine for
// a debug bundle (text + small JSON) and removes the only part of the spec that
// would need zlib stream plumbing. CRC-32 is still required by the format and is
// implemented below; readStoredZip verifies it on read so a corrupt bundle is
// caught rather than silently opened.

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIR_SIG = 0x02014b50;
const END_OF_CENTRAL_DIR_SIG = 0x06054b50;

// Fixed DOS timestamp (1980-01-01 00:00:00, the ZIP epoch). Deterministic by
// design: the bundle's real created-at lives in manifest.json, and a fixed entry
// time keeps two bundles of the same inputs byte-identical (easier to test and
// to diff). Avoids any reliance on a wall clock in the archive layer.
const DOS_DATE = 0x0021; // year=1980, month=1, day=1
const DOS_TIME = 0x0000;

export interface ZipEntry {
  name: string;
  data: Buffer;
}

const CRC_TABLE: number[] = (() => {
  const table: number[] = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Build a store-only ZIP archive from the given entries. Names use forward
// slashes (the ZIP convention) and are encoded UTF-8.
export function createZip(entries: ZipEntry[]): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name.replace(/\\/g, "/"), "utf8");
    const data = entry.data;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_FILE_HEADER_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed (2.0)
    local.writeUInt16LE(0x0800, 6); // flags: bit 11 = UTF-8 names
    local.writeUInt16LE(0, 8); // method: 0 = store
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size == size (store)
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    localChunks.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_DIR_SIG, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8); // flags: UTF-8
    central.writeUInt16LE(0, 10); // method: store
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset

    centralChunks.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralDir = Buffer.concat(centralChunks);
  const localData = Buffer.concat(localChunks);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(END_OF_CENTRAL_DIR_SIG, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralDir.length, 12); // central dir size
  eocd.writeUInt32LE(localData.length, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localData, centralDir, eocd]);
}

// Parse a store-only ZIP produced by createZip back into its entries, verifying
// each entry's CRC-32. Throws on a malformed archive or a CRC mismatch. Used by
// the debug-bundle tests for a real round-trip and available for self-verify.
export function readStoredZip(buf: Buffer): ZipEntry[] {
  // Locate the end-of-central-directory record (no trailing comment, so it is
  // the last 22 bytes for archives we produce).
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === END_OF_CENTRAL_DIR_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error("readStoredZip: end-of-central-directory record not found");
  }

  const total = buf.readUInt16LE(eocdOffset + 10);
  let p = buf.readUInt32LE(eocdOffset + 16); // central dir offset
  const entries: ZipEntry[] = [];

  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(p) !== CENTRAL_DIR_SIG) {
      throw new Error("readStoredZip: bad central directory signature");
    }
    const method = buf.readUInt16LE(p + 10);
    if (method !== 0) {
      throw new Error(`readStoredZip: unsupported method ${method} (store only)`);
    }
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);

    // Walk into the local header to find the data start (its name/extra lengths
    // can differ from the central record's, so read them locally).
    if (buf.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER_SIG) {
      throw new Error("readStoredZip: bad local file header signature");
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = buf.subarray(dataStart, dataStart + size);

    if (crc32(data) !== crc) {
      throw new Error(`readStoredZip: CRC mismatch for ${name}`);
    }
    entries.push({ name, data: Buffer.from(data) });

    p += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}
