// 纯 Node 实现的 asar 解包器：node asar-read.mjs <app.asar> <destDir>
// 不依赖 @electron/asar，不联网。
import fs from "node:fs";
import path from "node:path";

const archive = process.argv[2];
const dest = process.argv[3];
if (!archive || !dest) {
  console.error("usage: node asar-read.mjs <app.asar> <destDir>");
  process.exit(2);
}

const CHUNK = 4 * 1024 * 1024; // 4 MB 分块写，避免把整个归档读进内存

const fd = fs.openSync(archive, "r");
const fileSize = fs.fstatSync(fd).size;

function readAt(pos, len) {
  const buf = Buffer.allocUnsafe(len);
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, buf, got, len - got, pos + got);
    if (n <= 0) throw new Error(`short read at ${pos + got}`);
    got += n;
  }
  return buf;
}

// asar header: [u32 = 4][u32 = pickleSize][u32 = headerStringSize][json...]
const head = readAt(0, 16);
const pickleSize = head.readUInt32LE(4);
const jsonLen = head.readUInt32LE(12);
if (jsonLen <= 0 || jsonLen > 512 * 1024 * 1024) {
  throw new Error(`bad asar header: jsonLen=${jsonLen}`);
}
const index = JSON.parse(readAt(16, jsonLen).toString("utf8"));
const baseOffset = 8 + pickleSize;
if (baseOffset >= fileSize) throw new Error("bad asar header: baseOffset past EOF");

const stats = { files: 0, bytes: 0, links: 0, unpackedSkipped: 0 };

function writeRange(outPath, offset, len) {
  const out = fs.openSync(outPath, "w");
  try {
    let written = 0;
    while (written < len) {
      const take = Math.min(CHUNK, len - written);
      const buf = readAt(baseOffset + offset + written, take);
      fs.writeSync(out, buf, 0, take);
      written += take;
    }
  } finally {
    fs.closeSync(out);
  }
}

function walk(node, rel) {
  for (const [name, info] of Object.entries(node.files || {})) {
    const relPath = rel ? `${rel}/${name}` : name;
    if (info.files) {
      fs.mkdirSync(path.join(dest, relPath), { recursive: true });
      walk(info, relPath);
      continue;
    }
    const outPath = path.join(dest, relPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    if (info.link) {
      // 归档里的符号链接：能建就建，建不了跳过（Windows 需要权限）
      try {
        fs.symlinkSync(info.link, outPath);
        stats.links += 1;
      } catch {
        /* ignore */
      }
      continue;
    }
    if (info.unpacked) {
      // asarUnpack 的文件本体不在归档里，由 app.asar.unpacked 提供
      stats.unpackedSkipped += 1;
      continue;
    }
    const offset = Number(info.offset || 0);
    const len = Number(info.size || 0);
    if (!Number.isFinite(offset) || !Number.isFinite(len) || len < 0) {
      throw new Error(`bad entry: ${relPath}`);
    }
    writeRange(outPath, offset, len);
    stats.files += 1;
    stats.bytes += len;
  }
}

try {
  walk(index, "");
  console.log(JSON.stringify(stats));
} finally {
  fs.closeSync(fd);
}
