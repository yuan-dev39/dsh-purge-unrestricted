/**
 * 历史备份目录管理。
 *
 * dsh-purge 打补丁时会在三个地方留下原件副本：
 *   1. 宿主文件旁：`X.js.dshpurge.bak`（`shimBackupPath` 的非 runtime 目录分支）
 *   2. `$DSH_HOME/dsh-purge/shim-backups/`：密封 bin 里的 shim 原件（带 sha1 摘要后缀）
 *   3. 插件自带的 `lib.bak-restrict-<ts>/`：整份旧 lib 的快照目录
 *
 * 面板只做「看得见 + 能删」：不还原、不改名。删除是不可逆的，所以每一条都带绝对路径
 * 与大小，前端二次确认后才发 delete。
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

/** listBackups 的 TTL 缓存时长：整盘递归 ~270ms，轮询下不能每次都真扫。 */
const LIST_TTL_MS = 10000;
let listCache = { at: 0, key: "", value: null };

/** 单次列出的上限，防止极端目录把响应撑爆。 */
const MAX_ENTRIES = 1200;
/** 目录快照（lib.bak-restrict-*）最多下钻几层。 */
const SNAPSHOT_DEPTH = 4;

function statSafe(fp) {
  try {
    return fs.statSync(fp);
  } catch {
    return null;
  }
}

function fileRow(fp, label, base) {
  const st = statSafe(fp);
  if (!st || !st.isFile()) return null;
  let rel = "";
  if (base) {
    const b = path.resolve(base);
    const n = path.resolve(fp);
    if (n.startsWith(b + path.sep)) rel = path.dirname(n.slice(b.length + 1));
  }
  return {
    id: Buffer.from(fp, "utf8").toString("base64url"),
    kind: "file",
    label,
    rel,
    path: fp,
    name: path.basename(fp),
    size: st.size,
    mtime: st.mtimeMs,
    mtime_text: st.mtime.toISOString(),
  };
}

function snapshotRow(dir) {
  const st = statSafe(dir);
  if (!st || !st.isDirectory()) return null;
  let count = 0;
  let bytes = 0;
  const walk = (d, depth) => {
    if (depth > SNAPSHOT_DEPTH) return;
    let ents = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else {
        const s = statSafe(p);
        if (s && s.isFile()) {
          count += 1;
          bytes += s.size;
        }
      }
    }
  };
  walk(dir, 0);
  return {
    id: Buffer.from(dir, "utf8").toString("base64url"),
    kind: "dir",
    label: "lib 快照目录",
    path: dir,
    name: path.basename(dir),
    size: bytes,
    count,
    mtime: st.mtimeMs,
    mtime_text: st.mtime.toISOString(),
  };
}

/** 从安装根推导扫描根：aiBase 可能是 app 根，也可能是 app\node_modules\@deepseek-ai。 */
function hostScanRoot(aiBase) {
  const b = path.resolve(aiBase);
  const nm = path.basename(b);
  const parent = path.basename(path.dirname(b));
  // ...\app\node_modules\@deepseek-ai -> ...\app
  if (/^@/.test(nm) && parent === "node_modules") return path.dirname(path.dirname(b));
  // ...\app\node_modules -> ...\app
  if (nm === "node_modules") return path.dirname(b);
  return b;
}

/** 扫一个目录下的直接文件，收 matching(name) 命中的。 */
function scanFlat(dir, matching, rows, label, base) {
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    if (!e.isFile()) continue;
    if (!matching(e.name)) continue;
    const row = fileRow(path.join(dir, e.name), label, base);
    if (row) rows.push(row);
  }
}

/** 第 4 类：`$DSH_HOME/profiles` 下宿主与用户脚本留下的 *.bak / *.bak-* / *.dshpurge.bak。 */
function scanProfileTree(dir, rows, depth, max, base) {
  if (depth > max || rows.length >= MAX_ENTRIES) return;
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    if (rows.length >= MAX_ENTRIES) return;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      // 备份目录本身就是"一条"，不往里钻（_backups/poisoned-baks 之类只算目录条目）
      scanProfileTree(p, rows, depth + 1, max, base);
    } else if (e.isFile() && /\.bak([-.]{1}[A-Za-z0-9_-]+)?$/i.test(e.name)) {
      const row = fileRow(p, "profile 备份", base);
      if (row) rows.push(row);
    }
  }
}

/** 递归找宿主目录里的 `*.dshpurge.bak`（含 node_modules 里的补丁原件）。 */
function scanTree(dir, rows, depth, max, base) {
  if (depth > max || rows.length >= MAX_ENTRIES) return;
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    if (rows.length >= MAX_ENTRIES) return;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      scanTree(p, rows, depth + 1, max, base);
    } else if (e.isFile() && /\.dshpurge\.bak$/i.test(e.name)) {
      const row = fileRow(p, "宿主原件", base);
      if (row) rows.push(row);
    }
  }
}

/**
 * 列出全部备份。
 * @param {string} dshHome - `$DSH_HOME`
 * @param {object} opts - `{ aiBase, pluginRoot }`
 * @returns `{ ok, groups, total_size, total_count, scanned }`
 */
export function listBackups(dshHome, opts = {}) {
  const aiBase = String(opts.aiBase || "");
  const force = opts.force === true;
  const cacheKey = String(dshHome || "") + "|" + aiBase + "|" + String(opts.pluginRoot || "");
  if (!force && listCache.value && listCache.key === cacheKey && Date.now() - listCache.at < LIST_TTL_MS) {
    return listCache.value;
  }
  const pluginRoot = String(opts.pluginRoot || "");
  const rows = [];

  // 1) 宿主目录里的 .dshpurge.bak
  const hostRoot = aiBase ? hostScanRoot(aiBase) : "";
  if (hostRoot && fs.existsSync(hostRoot)) scanTree(hostRoot, rows, 0, 9, hostRoot);

  // 2) shim-backups
  const shimDir = dshHome ? path.join(dshHome, "dsh-purge", "shim-backups") : "";
  if (shimDir) scanFlat(shimDir, (n) => /\.bak$/i.test(n), rows, "shim 原件", shimDir);

  // 2.5) $DSH_HOME/profiles 下的宿主/用户 *.bak
  const profileRoot = dshHome ? path.join(dshHome, "profiles") : "";
  if (profileRoot && fs.existsSync(profileRoot)) scanProfileTree(profileRoot, rows, 0, 8, profileRoot);

  // 3) 插件目录里的 lib.bak-restrict-<ts>
  const libDirs = [];
  if (pluginRoot) {
    let list = [];
    try {
      list = fs.readdirSync(pluginRoot, { withFileTypes: true });
    } catch {
      list = [];
    }
    for (const e of list) {
      if (e.isDirectory() && /^lib\.bak-/i.test(e.name)) libDirs.push(path.join(pluginRoot, e.name));
    }
  }
  for (const d of libDirs) {
    const row = snapshotRow(d);
    if (row) rows.push(row);
  }

  rows.sort((a, b) => b.mtime - a.mtime);

  // 按相对目录聚合：54 条宿主原件太扁平，面板需要能折叠。
  const dirMap = new Map();
  for (const r of rows) {
    const key = r.label + "|" + (r.rel || "");
    let bin = dirMap.get(key);
    if (!bin) {
      bin = { key, label: r.label, rel: r.rel || "", count: 0, size: 0, rows: [] };
      dirMap.set(key, bin);
    }
    bin.count += 1;
    bin.size += r.size;
    bin.rows.push(r);
  }
  const dirs = Array.from(dirMap.values()).sort((a, b) => b.size - a.size);

  const groups = [
    { id: "host", label: "宿主原件", rows: rows.filter((r) => r.label === "宿主原件") },
    { id: "profile", label: "profile 备份", rows: rows.filter((r) => r.label === "profile 备份") },
    { id: "shim", label: "shim 原件", rows: rows.filter((r) => r.label === "shim 原件") },
    { id: "snapshot", label: "lib 快照目录", rows: rows.filter((r) => r.label === "lib 快照目录") },
  ].filter((g) => g.rows.length > 0);

  let totalSize = 0;
  for (const r of rows) totalSize += r.size;
  const result = {
    ok: true,
    rows,
    groups,
    dirs,
    total_count: rows.length,
    total_size: totalSize,
    scanned: {
      host: hostRoot || "",
      shim: shimDir || "",
      plugin_root: pluginRoot || "",
    },
  };
  listCache = { at: Date.now(), key: cacheKey, value: result };
  return result;
}

/**
 * 校验一个 id 解出来确实是上面三类之一 —— 面板传来的 id 是 base64url 的绝对路径，
 * 不校验就等于给了任意路径删除能力。
 */
function allowedRoots(dshHome, opts = {}) {
  const roots = [];
  const aiBase = String(opts.aiBase || "");
  const pluginRoot = String(opts.pluginRoot || "");
  if (aiBase) {
    const hostRoot = hostScanRoot(aiBase);
    roots.push(path.resolve(aiBase));
    if (hostRoot && path.resolve(hostRoot) !== path.resolve(aiBase)) roots.push(path.resolve(hostRoot));
  }
  if (dshHome) {
    roots.push(path.resolve(path.join(dshHome, "dsh-purge", "shim-backups")));
    roots.push(path.resolve(path.join(dshHome, "profiles")));
  }
  if (pluginRoot) roots.push(path.resolve(pluginRoot));
  return roots;
}

function pathAllowed(fp, roots) {
  const norm = path.resolve(fp);
  for (const root of roots) {
    if (norm === root) return false;
    if (!norm.startsWith(root + path.sep)) continue;
    // 三类备份形态，逐类按"相对该根的路径"判定：
    //   1. 宿主/插件树里的 `*.dshpurge.bak`
    //   2. shim 根下的直接子文件 `*.bak`（根本身就是 shim-backups，rel 只有文件名）
    //   3. 插件根下的一级目录 `lib.bak-*`
    if (/\.dshpurge\.bak$/i.test(norm)) return true;
    // profile 树 / 宿主树里的 *.bak 与 *.bak-<suffix>（宿主 sanitizeProfile 用 .bak-<ts>）
    if (/\.bak([-.]{1}[A-Za-z0-9_-]+)?$/i.test(norm) && /[\\/]profiles[\\/]/.test(norm)) return true;
    const rel = norm.slice(root.length + 1);
    const parts = rel.split(path.sep);
    if (parts.length === 1 && /\.bak$/i.test(parts[0])) return true;
    if (parts.length >= 2 && parts[0] === "dsh-purge" && parts[1] === "shim-backups") return true;
    if (/^lib\.bak-/i.test(parts[0] || "")) return true;
  }
  return false;
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 删除指定备份。ids 是 listBackups 返回的 id 数组。
 * @returns `{ ok, removed, failed, skipped }`
 */
export function deleteBackups(dshHome, ids, opts = {}) {
  // 删完立刻让缓存失效，避免面板拿到删除前的快照。
  listCache = { at: 0, key: "", value: null };
  const roots = allowedRoots(dshHome, opts);
  const removed = [];
  const failed = [];
  const skipped = [];
  if (!Array.isArray(ids) || ids.length === 0) {
    return { status: 400, ok: false, error: "ids 不能为空" };
  }
  for (const id of ids.slice(0, MAX_ENTRIES)) {
    let fp = "";
    try {
      fp = Buffer.from(String(id), "base64url").toString("utf8");
    } catch {
      skipped.push({ id: String(id), reason: "bad id" });
      continue;
    }
    if (!fp || !path.isAbsolute(fp)) {
      skipped.push({ id: String(id), reason: "not absolute" });
      continue;
    }
    if (!pathAllowed(fp, roots)) {
      skipped.push({ id: String(id), reason: "不在允许范围", path: fp });
      continue;
    }
    const st = statSafe(fp);
    if (!st) {
      skipped.push({ id: String(id), reason: "已不存在", path: fp });
      continue;
    }
    if (!st.isFile() && !st.isDirectory()) {
      skipped.push({ id: String(id), reason: "不是普通文件/目录", path: fp });
      continue;
    }
    if (rmrf(fp)) removed.push(fp);
    else failed.push({ path: fp, reason: "删除失败（可能被占用）" });
  }
  return { ok: failed.length === 0, removed, failed, skipped };
}

/** 给面板用的字节数格式化（后端不做，前端做，这里留一个给 CLI/工具的口径）。 */
export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + " B";
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + " KB";
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + " MB";
  return (v / 1024 / 1024 / 1024).toFixed(2) + " GB";
}
