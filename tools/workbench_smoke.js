/*
 * ⛔ 已失效（2026-10-07）—— 请勿在回归里运行，见 `缺口与待办.md` F11。
 *
 * 本脚本是 **Vue SPA 时代**的验证工装：它用无头 Edge 打开 `http://localhost:5173/workbench`，
 * 而 `/workbench` 是 **vue-router 的路由**（无对应 `.html`）。V3 静态前端接手为唯一主线后
 * 该路径不存在，脚本第一步（等待 `.wb-host`）必然超时；2026-10-07 Vue SPA 整体移除后已**不可能修复**。
 *
 * 保留此文件只为「不丢信息」（它的断言口径见下），**不应再计入回归的绿/红**。
 * V3 侧的等价覆盖：制谱页（2026-10-10 起为 `web-vue/public/composer.html`，由 ComposerView
 * 用 iframe 承载；此前是 `web/composer.html`）+ 内核自身的
 * `kalprobe/kal_accept.js` 验收（21 探针 / 1240 项，含导出指纹）。
 *
 * 原用途（工作台 Vue 化验证，WBS 6「整块嵌入」）：
 *   1. 工作台 DOM 骨架渲染（.wb-host / #src / #svgHost / #keySel）
 *   2. mountStudio() 成功（keySel 有 options、谱面 SVG 已生成）
 *   3. 全屏模式（无门户 .topbar）
 *   4. 返回门户首页，确认 .btn 样式未被工作台 CSS 污染
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9350;
const BASE = 'http://localhost:5173';
const PROFILE = path.join(__dirname, '.wb_prof');
try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (_) {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws; let seq = 0; const pending = new Map();
function send(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++seq; pending.set(id, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result ? r.result.value : undefined;
}
async function connect() {
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    try {
      const l = await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: '/json/list' },
        (r) => { let s = ''; r.on('data', (c) => s += c); r.on('end', () => res(JSON.parse(s))); }).on('error', rej));
      const p = l.find((t) => t.type === 'page');
      if (p) return p.webSocketDebuggerUrl;
    } catch (_) {}
  }
  throw new Error('no target');
}
async function waitFor(fn, desc, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await fn()) return true; } catch (_) {}
    await sleep(300);
  }
  throw new Error('等待超时: ' + desc);
}
const results = [];
function assert(label, cond, extra = '') {
  const pass = !!cond; results.push({ label, pass });
  console.log(`${pass ? '✓' : '✗'} ${label}${extra ? '  [' + extra + ']' : ''}`);
}

async function main() {
  const browser = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required',
    '--disable-features=Translate,MediaRouter', '--remote-debugging-port=' + PORT,
    '--window-size=1440,900', '--user-data-dir=' + PROFILE, BASE + '/workbench',
  ], { stdio: ['ignore', 'ignore', 'ignore'] });

  try {
    const url = await connect();
    ws = new WebSocket(url);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    };
    await send('Page.enable');
    await send('Runtime.enable');
    await sleep(1500);

    // 1. 工作台 DOM 骨架
    await waitFor(() => ev(`!!document.querySelector('.wb-host')`), '.wb-host 出现');
    const dom = await ev(`(() => ({
      host: !!document.querySelector('.wb-host'),
      src: !!document.querySelector('#src'),
      svgHost: !!document.querySelector('#svgHost'),
      keySel: !!document.querySelector('#keySel'),
      topbar: !!document.querySelector('.topbar'),
    }))()`);
    assert('工作台骨架渲染（.wb-host / #src / #svgHost / #keySel）', dom.host && dom.src && dom.svgHost && dom.keySel, JSON.stringify(dom));
    assert('全屏模式（无门户顶栏 .topbar）', !dom.topbar);

    // 2. mountStudio() 成功
    await waitFor(() => ev(`document.querySelectorAll('#keySel option').length > 0`), 'keySel 有 options（init 已跑）');
    const keyOpts = await ev(`document.querySelectorAll('#keySel option').length`);
    assert('init() 填充调号下拉', keyOpts > 0, `options=${keyOpts}`);

    await waitFor(() => ev(`document.querySelectorAll('#svgHost svg').length > 0`), '谱面 SVG 生成');
    const svgCount = await ev(`document.querySelectorAll('#svgHost svg').length`);
    assert('谱面 SVG 已渲染', svgCount > 0, `svg=${svgCount}`);

    // 采样一个谱面几何，确认不是空白（有小节内容）
    const svgText = await ev(`document.querySelector('#svgHost svg') ? document.querySelector('#svgHost svg').textContent.length : 0`);
    assert('谱面有内容（非空 SVG）', svgText > 100, `textLen=${svgText}`);

    // 2b. 交互：改简谱输入 + 点「生成琴谱」，确认事件绑定 + 内核渲染在「工作台整块嵌入」场景下完整可用
    const before = await ev(`document.querySelector('#svgHost').innerHTML.length`);
    await ev(`(() => {
      const src = document.querySelector('#src');
      src.value = 'title: 交互测试\\nkey: 1=C\\nmeter: 4/4\\ntempo: 90\\n\\nM: 1 3 5 7 | 6 5 3 1 |';
      src.dispatchEvent(new Event('input', {bubbles:true}));
      const b = document.querySelector('#btnParse');
      if (b) { b.click(); return true; }
      return false;
    })()`);
    await sleep(800);
    const after = await ev(`document.querySelector('#svgHost').innerHTML.length`);
    assert('改简谱+点「生成琴谱」后谱面重新生成', after > 0 && after !== before, `before=${before} after=${after}`);

    // 3. 返回门户，确认工作台 CSS 未污染门户（门户 --brand 应是橙色 #c1663a，
    //    工作台 --accent 是绿色 #2f6f5f；若被污染 --brand 会变绿）
    await ev(`(() => { location.href = '/'; return true; })()`);
    await waitFor(() => ev(`!!document.querySelector('.topbar')`), '门户顶栏出现');
    const brand = await ev(`getComputedStyle(document.documentElement).getPropertyValue('--brand').trim()`);
    console.log('门户 --brand 值:', brand);
    assert('门户样式未被工作台 CSS 污染（--brand 仍是 V3 木棕 #5D4432）', brand === '#5D4432', brand);

    const fail = results.filter((r) => !r.pass).length;
    console.log('\n========================================');
    console.log(`工作台验证（Vue SPA 时代工装，已失效）：${results.length} 项，通过 ${results.length - fail}，失败 ${fail}`);
    console.log(fail === 0 ? '★ 全部通过' : '✗ 有失败');
    process.exitCode = fail === 0 ? 0 : 1;
  } catch (e) {
    console.error('驱动异常:', e.message);
    process.exitCode = 2;
  } finally {
    try { ws && ws.close(); } catch (_) {}
    browser.kill();
    await sleep(500);
  }
}

main();
