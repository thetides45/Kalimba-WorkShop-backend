/**
 * 冒烟脚本共用的浏览器 profile 与清理工具。
 *
 * <h3>为什么需要这个文件</h3>
 * 原先每个 UI 冒烟各写各的：
 *   - `pwa_smoke.js` 用 `os.tmpdir()/kalimba_pwa_prof_<Date.now()>`，而且
 *     `process.exit()` 写在 `try` 里 —— **`finally` 里的清理永远不会执行**（Node 文档明确说明
 *     `process.exit()` 会在 finally 之前终止进程）。于是每跑一次就在 %TEMP% 留一个几百 MB 的目录。
 *   - `v3_features_smoke.js` 用 `.v3f_prof_<Date.now()>`，13 次运行留下 13 个目录、合计 1.1 GB。
 *   - 其余脚本用固定名，但**只在启动前删**、跑完不管，所以每个常驻 ~280 MB。
 *   - 而无论哪种写法，`b.kill()` 之后**立即** `rmSync` 在 Windows 上必然失败（Edge 是多进程，
 *     句柄释放有延迟），错误又被 `catch (_) {}` 吞掉，没人发现。
 *
 * 实测：`backend/tools/` 下曾堆积 18 个 profile 目录、共 **1664.7 MB**。
 *
 * <h3>本文件提供的约束</h3>
 *   1. **所有冒烟共用同一个固定 profile 名**（不再有时间戳后缀）→ 最多只会残留一个；
 *   2. `prepareProfile()` 在启动前扫掉本项目内所有历史命名的残留（含旧的 `.v3f_prof_*`）；
 *   3. `killBrowserAndClean()` 先**等进程真的退出**，再重试删除，失败会**打印**而不是静默吞掉。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOOLS_DIR = __dirname;

/** 全体冒烟共用的固定 profile 目录（无时间戳后缀）。 */
const SHARED_PROFILE = path.join(TOOLS_DIR, '.smoke_prof');

/** 本项目历史用过的 profile 目录名（含时间戳变体），启动前一律扫掉。 */
const LEGACY_PREFIXES = [
  '.search_prof', '.admin_prof', '.e2e_prof', '.wb_prof', '.v3f_prof', '.smoke_prof',
  '.probe', '.diagtop_prof',
];

/**
 * 清掉指定目录，失败时重试。返回 true 表示已删掉（或本来就不存在）。
 * Windows 上刚 kill 完的浏览器会短暂占用目录，所以必须带重试。
 */
async function cleanDir(dir, { attempts = 5, delayMs = 400, label = '' } = {}) {
  for (let i = 1; i <= attempts; i++) {
    if (!fs.existsSync(dir)) return true;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      if (!fs.existsSync(dir)) return true;
    } catch (e) {
      if (i === attempts) {
        console.warn(`  ⚠ 清理 ${label || dir} 失败（已重试 ${attempts} 次）：${e.message}`);
        console.warn('    → 该目录会在下次运行 prepareProfile() 时被扫掉，不会持续堆积。');
        return false;
      }
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

/**
 * 启动前调用：移除本项目 tools/ 下所有历史 profile 残留，返回本次要用的 profile 路径。
 * **只清扫、不创建** —— 目录留给 Edge 自己建（否则脚本在起浏览器之前就失败退出时，
 * 又会留下一个空目录）。Edge 用 `--user-data-dir` 时会自动创建该目录。
 * 同时清掉 %TEMP% 里旧的 kalimba_pwa_prof_*（早期 pwa_smoke 的命名）。
 */
function prepareProfile(profileDir = SHARED_PROFILE) {
  let swept = 0;
  let bytes = 0;

  const sizeOf = (p) => {
    let n = 0;
    try {
      for (const ent of fs.readdirSync(p, { withFileTypes: true, recursive: true })) {
        if (ent.isFile()) {
          try { n += fs.statSync(path.join(ent.parentPath || ent.path, ent.name)).size; } catch (_) {}
        }
      }
    } catch (_) {}
    return n;
  };

  let entries = [];
  try { entries = fs.readdirSync(TOOLS_DIR, { withFileTypes: true }); } catch (_) {}
  for (const ent of entries) {
    if (!ent.isDirectory() || !ent.name.startsWith('.')) continue;
    if (!LEGACY_PREFIXES.some((p) => ent.name.startsWith(p))) continue;
    const full = path.join(TOOLS_DIR, ent.name);
    if (path.resolve(full) === path.resolve(profileDir)) continue;   // 本次要用的，交给启动逻辑处理
    bytes += sizeOf(full);
    try {
      fs.rmSync(full, { recursive: true, force: true });
      swept++;
      console.log(`  [profile] 清理历史残留 ${ent.name}`);
    } catch (e) {
      console.warn(`  [profile] 清理 ${ent.name} 失败：${e.message}`);
    }
  }

  // 早期 pwa_smoke 把 profile 建在系统临时目录里
  try {
    for (const n of fs.readdirSync(os.tmpdir())) {
      if (!n.startsWith('kalimba_pwa_prof_')) continue;
      const full = path.join(os.tmpdir(), n);
      bytes += sizeOf(full);
      try { fs.rmSync(full, { recursive: true, force: true }); swept++; console.log(`  [profile] 清理 %TEMP% 残留 ${n}`); } catch (_) {}
    }
  } catch (_) {}

  if (swept) console.log(`  [profile] 共清理 ${swept} 个，释放约 ${(bytes / 1048576).toFixed(1)} MB`);

  /* 最后一次兜底：把本次要用的目录也删掉，保证从干净状态起
     （Edge 会恢复旧标签页，残留会让 CDP connect 到错页面）。
     不 mkdir —— 交给 Edge 自己创建。 */
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (_) {}

  return profileDir;
}

/** 等浏览器进程真正退出（kill 之后句柄通常还要几百毫秒才释放）。 */
function waitExit(b, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!b || b.exitCode !== null || b.signalCode !== null) return resolve();
    const timer = setTimeout(() => {
      try { b.kill('SIGKILL'); } catch (_) {}
      resolve();
    }, timeoutMs);
    b.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

/** 关掉 CDP、kill 浏览器、等退出、再清理 profile。失败会打印。 */
async function killBrowserAndClean(b, profileDir = SHARED_PROFILE, ws) {
  try { ws && ws.close(); } catch (_) {}
  try { b && b.kill(); } catch (_) {}
  await waitExit(b);
  await cleanDir(profileDir, { label: path.basename(profileDir) });
}

module.exports = { SHARED_PROFILE, prepareProfile, killBrowserAndClean, waitExit, cleanDir };
