/*
 * 端到端自动化验证：真实无头 Edge 驱动 http://localhost:5173 的完整流程。
 * 覆盖：登录 → 首页登录态 → 发布（含曲谱分类）→ 详情渲染 → 点赞 → 广场列表。
 * 用法：node e2e_flow.js   （前置：后端 8080、前端 5173 均已启动）
 * 退出码：0=全绿，1=有断言失败，2=环境/驱动错误。
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { SHARED_PROFILE, prepareProfile, killBrowserAndClean } = require('./browser_profile');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9339; // 独立端口，避免和 kalprobe 的 9333/9334 冲突
const BASE = 'http://localhost:5173';
/* 全体冒烟共用固定 profile。 */
const PROFILE = SHARED_PROFILE;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws;
let seq = 0;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJs(expression, awaitPromise = true) {
  const r = await send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error('页面 JS 异常: ' + JSON.stringify(r.exceptionDetails));
  }
  return r.result ? r.result.value : undefined;
}

async function connect() {
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    try {
      const list = await new Promise((res, rej) => {
        http.get({ host: '127.0.0.1', port: PORT, path: '/json/list' },
          (r) => { let s = ''; r.on('data', (c) => s += c); r.on('end', () => res(JSON.parse(s))); })
          .on('error', rej);
      });
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch (_) { /* 还没起来 */ }
  }
  throw new Error('CDP 目标未出现（浏览器没起来？）');
}

const results = [];
function assert(label, cond, extra = '') {
  const pass = !!cond;
  results.push({ label, pass, extra });
  console.log(`${pass ? '✓' : '✗'} ${label}${extra ? '  [' + extra + ']' : ''}`);
}

// 轮询等待某个条件为真（用于异步路由组件挂载、列表刷新等）
async function waitFor(fn, desc, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const v = await fn();
      if (v) return true;
      if (process.env.E2E_VERBOSE) console.log(`  [waitFor] ${desc} = ${JSON.stringify(v)}`);
    } catch (e) {
      console.log(`  [waitFor] ${desc} 检查异常: ${e.message}`);
    }
    await sleep(300);
  }
  throw new Error('等待超时: ' + desc);
}

async function main() {
  prepareProfile();   // 先扫掉历史残留（只清扫，目录交给 Edge 自建）
  const browser = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required',
    '--disable-features=Translate,MediaRouter', '--remote-debugging-port=' + PORT,
    '--window-size=1440,900', '--user-data-dir=' + PROFILE, BASE + '/login',
  ], { stdio: ['ignore', 'ignore', 'ignore'] });

  try {
    const url = await connect();
    ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message));
        else p.resolve(m.result);
      }
    };
    await send('Page.enable');
    await sleep(2000);

    // 1. 登录页可达（等异步组件挂载）
    await waitFor(() => evalJs(`document.querySelectorAll('input').length >= 2`), '登录页输入框');
    const loginTitle = await evalJs('document.title');
    assert('登录页可达', loginTitle.includes('登录'), loginTitle);

    // 2. 填表登录 demo
    await evalJs(`(() => {
      const inp = document.querySelectorAll('input');
      inp[0].value = 'demo';
      inp[0].dispatchEvent(new Event('input', {bubbles:true}));
      inp[1].value = '123456';
      inp[1].dispatchEvent(new Event('input', {bubbles:true}));
      return inp.length;
    })()`);
    // 点击「登录」按钮
    await evalJs(`(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '登录');
      if (btn) { btn.click(); return true; }
      return false;
    })()`);
    await sleep(2000);

    // 3. 登录后跳转首页，确认登录态（顶栏有「发布作品」按钮）
    const afterLogin = await evalJs(`(() => {
      return {
        href: location.href,
        hasPublish: document.body.textContent.includes('发布作品'),
        hasAvatar: !!document.querySelector('.avatar'),
      };
    })()`);
    assert('登录后进入首页', afterLogin.href.includes('/') && !afterLogin.href.includes('/login'), afterLogin.href);
    assert('顶栏出现登录态（发布按钮+头像）', afterLogin.hasPublish || afterLogin.hasAvatar);

    // 4. 进入发布页
    await evalJs(`(() => { location.href = '/publish'; return true; })()`);
    await sleep(800);
    // 等标题输入框出现（异步路由组件挂载完成）
    await waitFor(() => evalJs(`document.querySelector('input.input') !== null`), '发布页标题输入框');
    const pubReady = await evalJs(`(() => ({
      title: document.title,
      hasTitleInput: !!document.querySelector('input.input'),
    }))()`);
    assert('发布页可达', pubReady.title.includes('发布'), pubReady.title);

    // 5. 填标题/正文，选曲谱分类（音乐类型=纯音乐、琴型=17键）
    await evalJs(`(() => {
      const title = document.querySelector('input.input');
      title.value = 'E2E自动化测试谱';
      title.dispatchEvent(new Event('input', {bubbles:true}));
      const ta = document.querySelector('textarea');
      if (ta) { ta.value = '端到端自动化验证正文'; ta.dispatchEvent(new Event('input', {bubbles:true})); }
      const sels = document.querySelectorAll('select');
      // select 顺序：琴型 / 调性 / 难度 / 音乐类型
      if (sels.length >= 4) {
        sels[0].value = 'k17'; sels[0].dispatchEvent(new Event('change', {bubbles:true}));
        sels[3].value = 'pure'; sels[3].dispatchEvent(new Event('change', {bubbles:true}));
      }
      return { selects: sels.length };
    })()`);
    await sleep(500);

    // 6. 点发布
    await evalJs(`(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('发布'));
      if (btn) { btn.click(); return true; }
      return false;
    })()`);
    await sleep(2500);

    // 7. 发布后应跳到帖子详情，标题正确
    const detail = await evalJs(`(() => ({
      href: location.href,
      bodyText: document.body.textContent.slice(0, 500),
    }))()`);
    assert('发布后跳转帖子详情', /\/posts\/\d+/.test(detail.href), detail.href);
    assert('详情页渲染标题', detail.bodyText.includes('E2E自动化测试谱'));

    // 8. 点赞
    await waitFor(() => evalJs(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('点赞'))`), '点赞按钮出现');
    const readLike = `(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('点赞'));
      if (!btn) return null;
      const m = btn.textContent.match(/[0-9]+/);
      return m ? parseInt(m[0], 10) : null;
    })()`;
    const likeBefore = await evalJs(readLike);
    await evalJs(`(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('点赞'));
      if (btn) { btn.click(); return true; }
      return false;
    })()`);
    await sleep(1500);
    const likeAfter = await evalJs(readLike);
    assert('点赞数 +1', likeAfter === (likeBefore ?? 0) + 1, `before=${likeBefore} after=${likeAfter}`);

    // 9. 回广场，确认新帖在列表
    await evalJs(`(() => { location.href = '/square'; return true; })()`);
    await waitFor(() => evalJs(`document.body.textContent.includes('E2E自动化测试谱')`), '广场列表出现新帖');
    const square = await evalJs('document.body.textContent');
    assert('广场列表出现新帖', square.includes('E2E自动化测试谱'));

    // 汇总
    const fail = results.filter((r) => !r.pass).length;
    console.log('\n========================================');
    console.log(`端到端：${results.length} 项，通过 ${results.length - fail}，失败 ${fail}`);
    console.log(fail === 0 ? '★ 端到端全部通过' : '✗ 有失败');
    process.exitCode = fail === 0 ? 0 : 1;
  } catch (e) {
    console.error('驱动异常:', e.message);
    process.exitCode = 2;
  } finally {
    /* 先停浏览器、等它真正退出，再带重试地删 profile。
       原先只 `browser.kill()` + sleep(500) 而**从不删目录**，所以 .e2e_prof 每次都残留。 */
    await killBrowserAndClean(browser, PROFILE, ws);
  }
}

main();
