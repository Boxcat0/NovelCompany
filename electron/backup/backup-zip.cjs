const fs = require('node:fs');
const zlib = require('node:zlib');
const { RepositoryError } = require('../database/repositories/repository-error.cjs');
const LIMITS = Object.freeze({ files: 10000, file: 128 * 1024 * 1024, total: 512 * 1024 * 1024, archive: 520 * 1024 * 1024, ratio: 100, manifest: 2 * 1024 * 1024 });
const crcTable = Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });

/** ZIP의 무결성 오류를 경로를 노출하지 않는 한국어 오류로 보고한다. */
function invalid() { throw new RepositoryError('BACKUP_INVALID', '백업 ZIP의 구조·경로·크기 또는 무결성이 올바르지 않습니다.'); }
/** 파일 내용의 ZIP CRC32를 계산한다. */
function crc32(buffer) { let crc = 0xffffffff; for (const byte of buffer) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
/** Windows에서도 모호하지 않은 내부 파일 allowlist를 검사한다. */
function safeEntry(name) {
  if (name !== 'manifest.json' && name !== 'database/novelcompany.db' && !/^manuscripts\/[^/]+\/episodes\/[0-9]+\.txt$/.test(name)) invalid();
  if (name.length > 500 || name.split('/').some(segment => !segment || segment === '.' || segment === '..' || /[<>:"\\|?*\x00-\x1f]/.test(segment) || /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment))) invalid();
}
/** 작은 버퍼를 지정 위치에서 완전히 읽고 잘린 파일은 거부한다. */
function readAt(fd, length, position) {
  const buffer = Buffer.alloc(length);
  if (fs.readSync(fd, buffer, 0, length, position) !== length) invalid();
  return buffer;
}
/** ZIP32 중앙·로컬 헤더 전체를 추출 전에 검증하고 제한된 파일 읽기만 제공한다. */
function openZip(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < 22 || size > LIMITS.archive) invalid();
    const tail = readAt(fd, 22, size - 22);
    if (tail.readUInt32LE(0) !== 0x06054b50 || tail.readUInt16LE(4) || tail.readUInt16LE(6) || tail.readUInt16LE(20)) invalid();
    const count = tail.readUInt16LE(10), length = tail.readUInt32LE(12), start = tail.readUInt32LE(16);
    if (!count || count > LIMITS.files || count !== tail.readUInt16LE(8) || start + length !== size - 22 || length > LIMITS.files * 600) invalid();
    const entries = new Map(), names = new Set();
    let cursor = start, localEnd = 0, expanded = 0;
    for (let i = 0; i < count; i++) {
      const header = readAt(fd, 46, cursor);
      if (header.readUInt32LE(0) !== 0x02014b50) invalid();
      const flags = header.readUInt16LE(8), method = header.readUInt16LE(10), crc = header.readUInt32LE(16), compressed = header.readUInt32LE(20), uncompressed = header.readUInt32LE(24);
      const nameLength = header.readUInt16LE(28), extra = header.readUInt16LE(30), comment = header.readUInt16LE(32), offset = header.readUInt32LE(42), attributes = header.readUInt32LE(38);
      if (flags !== 0x800 || ![0, 8].includes(method) || !nameLength || nameLength > 500 || extra || comment || header.readUInt16LE(34) || (attributes & 0x10) || ((attributes >>> 16) && ((attributes >>> 16) & 0xf000) !== 0x8000)) invalid();
      const nameBytes = readAt(fd, nameLength, cursor + 46), name = nameBytes.toString('utf8');
      if (!Buffer.from(name, 'utf8').equals(nameBytes)) invalid();
      safeEntry(name);
      if (names.has(name.toLowerCase()) || uncompressed > (name === 'manifest.json' ? LIMITS.manifest : LIMITS.file) || compressed > LIMITS.file || uncompressed > Math.max(1, compressed) * LIMITS.ratio || (method === 0 && compressed !== uncompressed)) invalid();
      names.add(name.toLowerCase()); expanded += uncompressed;
      if (expanded > LIMITS.total || offset !== localEnd || offset + 30 + nameLength + compressed > start) invalid();
      const local = readAt(fd, 30, offset);
      if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== method || local.readUInt32LE(14) !== crc || local.readUInt32LE(18) !== compressed || local.readUInt32LE(22) !== uncompressed || local.readUInt16LE(26) !== nameLength || local.readUInt16LE(28) || !readAt(fd, nameLength, offset + 30).equals(nameBytes)) invalid();
      entries.set(name, { offset: offset + 30 + nameLength, compressed, size: uncompressed, method, crc });
      localEnd = offset + 30 + nameLength + compressed;
      cursor += 46 + nameLength;
    }
    if (cursor !== start + length || localEnd !== start) invalid();
    /** 정해진 상한 안에서만 해제하고 실제 길이와 CRC를 확인한다. */
    function read(name) {
      const entry = entries.get(name); if (!entry) invalid();
      const packed = readAt(fd, entry.compressed, entry.offset);
      const data = entry.method === 0 ? packed : zlib.inflateRawSync(packed, { maxOutputLength: Math.max(1, entry.size) });
      if (data.length !== entry.size || crc32(data) !== entry.crc) invalid();
      return data;
    }
    return { entries, read, close: () => fs.closeSync(fd) };
  } catch (error) { fs.closeSync(fd); throw error; }
}
/** ZIP32 STORE 형식으로 파일을 순차 기록하고 기존 파일은 절대로 덮어쓰지 않는다. */
function writeZip(file, entries, hook = () => {}) {
  if (!entries.length || entries.length > LIMITS.files) invalid();
  const fd = fs.openSync(file, 'wx');
  let offset = 0, total = 0;
  const central = [], names = new Set();
  try {
    for (const entry of entries) {
      safeEntry(entry.name);
      if (names.has(entry.name.toLowerCase())) invalid(); names.add(entry.name.toLowerCase());
      if (entry.path && fs.statSync(entry.path).size > LIMITS.file) invalid();
      const data = entry.data ?? fs.readFileSync(entry.path), name = Buffer.from(entry.name);
      total += data.length;
      if (data.length > (entry.name === 'manifest.json' ? LIMITS.manifest : LIMITS.file) || total > LIMITS.total) invalid();
      const crc = crc32(data), local = Buffer.alloc(30), header = Buffer.alloc(46);
      local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
      local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
      header.writeUInt32LE(0x02014b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(0x800, 8); header.writeUInt32LE(crc, 16); header.writeUInt32LE(data.length, 20); header.writeUInt32LE(data.length, 24); header.writeUInt16LE(name.length, 28); header.writeUInt32LE(offset, 42);
      fs.writeFileSync(fd, local); fs.writeFileSync(fd, name); fs.writeFileSync(fd, data);
      hook('zip-entry');
      offset += local.length + name.length + data.length; central.push(header, name);
    }
    const end = Buffer.alloc(22), centralLength = central.reduce((sum, item) => sum + item.length, 0);
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralLength, 12); end.writeUInt32LE(offset, 16);
    for (const item of central) fs.writeFileSync(fd, item);
    fs.writeFileSync(fd, end); fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}
module.exports = { LIMITS, safeEntry, openZip, writeZip, crc32 };
