/**
 * SPA 前端路由冒烟（CDP 无头 Edge）—— 纯 HTTP + 浏览器，不直连数据库。
 *
 * 「为什么要单独一个脚本」：
 *   2026-10-10 前端主线从 V3 多页静态站换成 Vue 3 SPA 后，`admin_ui_smoke` /
 *   `search_smoke` / `v3_features_smoke` / `pwa_smoke` 都已经改指向 5174 的 SPA 路由
 *   （见 `缺口与待办.md` F14），但它们各自只盯着**一个功能**。本脚本补的是
 *   「**换前端形态之后新增的那一类风险**」—— 那 4 个老脚本一条都覆盖不到：
 *
 *     ① **路由可达性**：11 个路由逐个直连（冷启动，不是从首页点进去），
 *        确认 SPA 的 history 回落没配错、每个视图都能独立渲染。
 *     ② **客户端导航**：点顶栏链接是 `router.push`，**不整页刷新**。
 *        这是 SPA 的核心行为，也是 V3 时代不存在的东西 ——
 *        整页刷新会丢掉内存态与滚动位置，是「静默退化」型 bug，不测就发现不了。
 *     ③ **浏览器后退/前进**：走 history 栈而不是重新加载。
 *     ④ **未知路径兜底**：`/no-such-page` 必须落到 `/404`（catch-all 规则）。
 *     ⑤ **全站壳稳定**：每个路由都有顶栏；除 404 外都有页脚。
 *     ⑥ **制谱页 iframe 真能跑**：不是「iframe 标签在」就算过，要伸进 contentDocument
 *        确认内核真的初始化了（12 个调号 option + 出谱 SVG）。
 *     ⑦ **零 console 异常 + 零非预期失败请求**（4xx/5xx 白名单见 ALLOW_HTTP）。
 *
 * 只读：全程不做写操作，不建任何数据，净变化为零。
 * 前置：前端 dev server 在 **5174**（`cd web-vue && npm run dev`）+ 后端 8080。
 * 用法：node tools/web_vue_smoke.js      （可用 KAL_WEB=... 指向别的地址）
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { SHARED_PROFILE, prepareProfile, killBrowserAndClean } = require('./browser_profile');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9431;
const BASE = process.env.KAL_WEB || 'http://127.0.0.1:5174';
const API = process.env.KAL_API || 'http://localhost:8080';
const PROFILE = SHARED_PROFILE;

/* 浏览器进程与 CDP 连接提到模块作用域，供 exit 钩子兜底清理。 */
let browser = null;
let cdpWs = null;
process.on('exit', () => {
  try { cdpWs && cdpWs.close(); } catch (_) {}
  try { browser && browser.kill(); } catch (_) {}
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (_) {}
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, seq = 0; const pending = new Map(); const logs = []; const failed = [];
function send(method, params = {}) {
  return new Promise((res, rej) => { const id = ++seq; pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })); });
}
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __exc: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || 'eval error' };
  return r.result ? r.result.value : undefined;
}
/**
 * 元素「存在且可见」的**空安全**表达式。
 *
 * ⚠️ 别直接写 `getComputedStyle(getElementById('x')).display !== 'none'`：
 * Vue 在组件挂载前这些节点还不存在，`getComputedStyle(null)` 会抛异常，
 * 而 `ev()` 把异常折成一个**真值**返回 —— `waitFor` 会把它当成「条件满足」立刻放行，
 * 断言随即读到 undefined 才崩（现象是一个与现场毫不相干的 TypeError）。
 * 元素不存在一律算「不可见」，让它继续轮询到真正渲染出来。
 */
const vis = (id) => `(() => { const e = document.getElementById(${JSON.stringify(id)}); return !!e && getComputedStyle(e).display !== 'none'; })()`;

async function connect() {
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    try {
      const list = await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: '/json/list' }, (r) => { let s = ''; r.on('data', (c) => s += c); r.on('end', () => res(JSON.parse(s))); }).on('error', rej));
      const p = list.find((t) => t.type === 'page');
      if (p) return p.webSocketDebuggerUrl;
    } catch (_) {}
  }
  throw new Error('no target');
}
const results = [];
function assert(label, cond, extra = '') {
  const pass = !!cond;
  results.push(pass);
  console.log(`${pass ? '✓' : '✗'} ${label}${extra ? '  [' + extra + ']' : ''}`);
}
async function waitFor(fn, desc, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await fn()) return true; await sleep(300); }
  throw new Error('等待超时: ' + desc);
}

/**
 * 整页导航（**带落地确认 + 重试**）。
 *
 * ⚠️ 不要写「赋值 location.href 就当导航成功」：本机 sandbox 里第三方字体（Google Fonts）
 * 请求一直挂着（缺口 F12），此时 CDP 触发的整页导航会**偶发被静默吞掉** ——
 * 地址栏停在原页、无失败请求、新页面的 console 一条都不出现。
 * 所以：打个一次性 token 再跳，读得到 token = 还是老文档 = 没跳成 → 重试并大声打出来。
 *
 * 注：SPA 路由**也走整页导航**（`location.href` 赋值永远触发文档加载，不是 router.push），
 * 所以这套落地确认逻辑对 SPA 依然适用、原样保留。
 */
async function go(url, readyExpr, desc) {
  const target = await ev(`new URL(${JSON.stringify(url)}, location.href).href`);
  const token = 'nav' + Date.now() + '_' + Math.random().toString(36).slice(2);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await ev(`(() => { window.__navToken = ${JSON.stringify(token)}; location.href = ${JSON.stringify(target)}; return true; })()`);
    const arrived = `location.href === ${JSON.stringify(target)} && window.__navToken !== ${JSON.stringify(token)}`;
    let landed = false;
    for (let i = 0; i < 40; i++) { if (await ev(arrived)) { landed = true; break; } await sleep(300); }
    if (landed) { await waitFor(() => ev(readyExpr), desc); return; }
    console.warn(`    ⚠ 导航被吞（第 ${attempt} 次）→ ${target}（重试）`);
  }
  throw new Error(
    '导航始终未生效: ' + target + '\n'
    + '    排查顺序：\n'
    + '      1) 前端 dev server 在不在？ curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5174/  （要 200；未启动就 cd web-vue && npm run dev）\n'
    + '      2) 后端在不在？      curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/api/posts        （要 200）\n'
    + '      3) 有陈旧无头 Edge 占着固定调试端口 / profile 吗？');
}

/* ---------- 路由清单 ---------- */
/* 每条都给：签名元素（**该视图独有**，用顶栏这种全站共有的当签名等于没验）、
   期望的最终 path、正文最小长度。
   ⚠️ 期望 path 必须显式断言：SPA 的路由守卫会在渲染后把匿名用户重定向到 /login，
   只断言「签名元素出现过」的话，元素在重定向前的**那一瞬间**就已经满足条件了 ——
   断言会假通过（2026-10-10 首版就是这么写的，被 /publish 这条抓出来了）。 */
const PUBLIC_ROUTES = [
  { path: '/', sel: '#post-list', expect: '/', minLen: 400, desc: '首页（卡片流容器）' },
  { path: '/works', sel: '#works-list', expect: '/works', minLen: 100, desc: '作品广场（作品列表）' },
  { path: '/login', sel: '#form-login', expect: '/login', minLen: 100, desc: '登录页（登录表单）' },
  { path: '/search?keyword=' + encodeURIComponent('卡林巴'), sel: '#s-meta', expect: '/search', minLen: 300, desc: '搜索页（结果摘要行）' },
  { path: '/user/2', sel: '#user-main', expect: '/user/2', minLen: 300, desc: '个人主页（主容器）' },
  /* /admin 不走守卫重定向，而是**就地**渲染权限提示卡（与 V3 一致）——
     所以它属于公开路由，签名就是那张卡。 */
  { path: '/admin', sel: '#admin-forbidden', expect: '/admin', minLen: 100, desc: '后台管理页（匿名 → 就地权限提示）' }
];
/* 需登录的路由：两条断言 —— 匿名时**必须被守卫拦到 /login 并带上 next**，
   登录后**必须不再重定向**。只写其中一条会漏掉「守卫失灵」或「守卫过度拦截」。 */
const GUARDED_ROUTES = [
  { path: '/publish', sel: '#pub-main', minLen: 300, desc: '发布页' },
  { path: '/notifications', sel: '#noti-main', minLen: 200, desc: '消息页' }
];

(async () => {
  /* ---------- 登录取 token（只读用途：写进 localStorage 让登录态页面可渲染） ---------- */
  let sess = null;
  try {
    const r = await (await fetch(API + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'demo', password: '123456' })
    })).json();
    if (r.code === 0 && r.data) {
      const d = r.data;
      sess = { accessToken: d.token, refreshToken: d.token,
        user: { id: String(d.userId), username: d.username, nickname: d.nickname, avatar: d.avatar || '', role: d.role } };
    }
  } catch (_) {}

  prepareProfile();
  const b = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--window-size=1440,900',
    '--user-data-dir=' + PROFILE, BASE + '/',
  ], { stdio: ['ignore', 'ignore', 'ignore'] });
  browser = b;

  try {
    const u = await connect();
    ws = new WebSocket(u);
    cdpWs = ws;
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        logs.push('CONSOLE_ERR: ' + m.params.args.map((a) => a.value || a.description || '').join(' '));
      }
      if (m.method === 'Runtime.exceptionThrown') {
        logs.push('EXC: ' + (m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description));
      }
      if (m.method === 'Network.responseReceived') {
        const res = m.params.response;
        if (res.status >= 400 && res.url.indexOf(BASE) === 0) failed.push(res.status + ' ' + res.url);
      }
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    };
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');

    await waitFor(() => ev(`!!document.querySelector('.topnav')`), '首屏顶栏渲染', 25000);

    /* ================= ① 公开路由逐个直连（冷启动） ================= */
    for (const r of PUBLIC_ROUTES) {
      await go(BASE + r.path, `!!document.querySelector(${JSON.stringify(r.sel)})`, r.desc);
      await sleep(600);   // 留一拍等异步数据/二次渲染落定
      const info = await ev(`(() => ({
        path: location.pathname,
        hasHeader: !!document.querySelector('.topnav'),
        len: document.body.textContent.replace(/\\s+/g, ' ').trim().length
      }))()`);
      assert(`① ${r.desc} 渲染（有顶栏 + 正文非空 + 未被重定向）`,
        !!info && info.hasHeader === true && info.len >= r.minLen && info.path === r.expect,
        `path=${info && info.path} len=${info && info.len}`);
    }

    /* ================= ①-b 路由守卫：匿名访问受保护页必须被拦 ================= */
    /* 单独测「守卫」而不是「页面」：游客点别人的「发布」链接时，正确行为是
       跳到登录页并带上 next，登录后能回到原目标 —— 这是独立于页面渲染的一类风险。 */
    for (const r of GUARDED_ROUTES) {
      await go(BASE + r.path, `location.pathname === '/login'`, r.desc + '（匿名被拦到登录页）');
      const g = await ev(`({ path: location.pathname, search: location.search })`);
      assert(`①-b 匿名访问 ${r.path} 被守卫拦到 /login 且带 next`,
        g.path === '/login' && decodeURIComponent(g.search).indexOf('next=' + r.path) >= 0,
        'path=' + g.path + decodeURIComponent(g.search));
    }

    /* 404 是**兜底落点**，单独走：它的签名是路由被改写成 /404 */
    await go(BASE + '/no-such-page-xyz', `location.pathname === '/404'`, '未知路径兜底到 404');
    const nf = await ev(`(() => ({
      path: location.pathname,
      text: (document.querySelector('main') || document.body).textContent.replace(/\\s+/g, ' ').trim().slice(0, 40),
      hasHeader: !!document.querySelector('.topnav')
    }))()`);
    assert('④ 未知路径被 catch-all 改写到 /404', nf.path === '/404', 'path=' + nf.path);
    assert('④ 404 页有内容且保留顶栏', nf.text.length > 4 && nf.hasHeader === true, nf.text);

    /* ================= ② 客户端导航：不整页刷新 ================= */
    /* 判据：在**旧文档**上打一个全局标记，点 RouterLink 后标记仍在 ⇒ 文档没被替换。
       整页刷新会清掉 window 上的所有属性，所以这个标记就是「是否重载」的探针。 */
    await go(BASE + '/', `!!document.querySelector('#post-list')`, '回首页');
    await sleep(500);
    const nav = await ev(`(() => {
      window.__spaMark = 'alive-' + Date.now();
      const a = [...document.querySelectorAll('.navlinks a')].find(x => x.textContent.trim() === '作品广场');
      if (!a) return { err: '未找到「作品广场」导航链接' };
      a.click();
      return { clicked: true };
    })()`);
    if (nav && nav.err) throw new Error(nav.err);
    await waitFor(() => ev(`location.pathname === '/works'`), '客户端导航切到 /works', 12000);
    const navRes = await ev(`({ mark: window.__spaMark || null, path: location.pathname })`);
    assert('② 点顶栏链接能切到 /works', navRes.path === '/works', 'path=' + navRes.path);
    assert('② 切换是客户端路由（文档未重载，window 标记存活）',
      typeof navRes.mark === 'string' && navRes.mark.indexOf('alive-') === 0, 'mark=' + navRes.mark);

    /* ================= ③ 浏览器后退 / 前进 ================= */
    await ev(`history.back()`);
    await waitFor(() => ev(`location.pathname === '/'`), '后退回到首页', 12000);
    const back = await ev(`({ path: location.pathname, mark: window.__spaMark || null })`);
    assert('③ 后退回到首页且仍是同一文档（未重载）',
      back.path === '/' && typeof back.mark === 'string', `path=${back.path} mark=${back.mark}`);
    await ev(`history.forward()`);
    await waitFor(() => ev(`location.pathname === '/works'`), '前进回到 /works', 12000);
    assert('③ 前进回到 /works', (await ev(`location.pathname`)) === '/works');

    /* ================= ⑥ 制谱页 iframe 真能跑 ================= */
    await go(BASE + '/composer', `!!document.querySelector('.composer-iframe')`, '制谱页 iframe 就位');
    /* 只在「iframe 标签在」就断言通过是不够的 —— 内核报错会导致一片空白。
       同源，可以直接伸进 contentDocument 验内核真的初始化了。 */
    await waitFor(() => ev(`(() => {
      const f = document.querySelector('.composer-iframe');
      const d = f && f.contentDocument;
      return !!(d && d.querySelector('#svgHost svg'));
    })()`), 'iframe 内核出谱', 25000);
    const comp = await ev(`(() => {
      const f = document.querySelector('.composer-iframe');
      const d = f.contentDocument;
      const svg = d.querySelector('#svgHost svg');
      return {
        src: f.getAttribute('src'),
        keys: d.querySelectorAll('#keySel option').length,
        svgText: svg ? svg.textContent.length : 0,
        accent: d.defaultView.getComputedStyle(d.documentElement).getPropertyValue('--accent').trim()
      };
    })()`);
    assert('⑥ 制谱页 iframe 指向内核单文件', comp.src === '/composer.html', 'src=' + comp.src);
    assert('⑥ 内核已初始化（调号 12 项）', comp.keys === 12, 'options=' + comp.keys);
    assert('⑥ 内核真的出谱了（SVG 有内容）', comp.svgText > 100, 'svgText=' + comp.svgText);
    assert('⑥ 内核主题变量生效（--accent 木色 #5D4432）',
      comp.accent.toUpperCase() === '#5D4432', '--accent=' + comp.accent);

    /* ================= ⑤ 登录态：受保护路由不再被守卫拦截 ================= */
    if (sess) {
      await ev(`(() => { localStorage.setItem('kc_auth', ${JSON.stringify(JSON.stringify(sess))}); return true; })()`);
      for (const r of GUARDED_ROUTES) {
        await go(BASE + r.path, `!!document.querySelector(${JSON.stringify(r.sel)})`, '登录态 ' + r.desc);
        await sleep(900);
        const info = await ev(`(() => ({
          path: location.pathname,
          len: document.body.textContent.replace(/\\s+/g, ' ').trim().length
        }))()`);
        assert(`⑤ 登录后 ${r.path} 正常渲染（不再被拦到 /login）`,
          !!info && info.path === r.path && info.len >= r.minLen,
          `path=${info && info.path} len=${info && info.len}`);
      }

      /* demo 不是管理员 → /admin 该看到权限提示，而不是管理分区（越权防线）。
         注意要**显式导航过去**：/admin 不在 GUARDED_ROUTES 里（它不重定向），
         不导航的话这里读到的还是上一个页面的 DOM。 */
      await go(BASE + '/admin', `!!document.querySelector('#admin-forbidden')`, '登录态管理页');
      await sleep(700);
      const adm = await ev(`(() => ({
        tabs: document.querySelectorAll('#admin-tabs .chip').length,
        stats: document.querySelectorAll('#stat-grid .stat-card').length,
        forbiddenVisible: ${vis('admin-forbidden')}
      }))()`);
      assert('⑤ 非管理员账号打开 /admin 得到权限提示（不误放行）',
        adm.forbiddenVisible === true && adm.tabs === 0, JSON.stringify(adm));

      await go(BASE + '/notifications', `!!document.querySelector('#noti-main')`, '登录态消息页');
      await sleep(800);
      const noti = await ev(`(() => ({
        items: document.querySelectorAll('.noti-item').length,
        unread: document.querySelectorAll('.noti-item.unread').length
      }))()`);
      assert('⑤ 消息页渲染出通知条目', noti.items > 0, `共 ${noti.items} 条 / 未读 ${noti.unread}`);
    } else {
      assert('⑤ 拿到 demo 登录会话（后续登录态断言的前提）', false, '登录接口未返回 code=0');
    }

    /* ================= ⑦ console 与失败请求 ================= */
    const excs = logs.filter((l) => /EXC:/.test(l));
    assert('⑦ 无运行时异常', excs.length === 0, excs.slice(0, 2).join(' | '));
    const cerrs = logs.filter((l) => /CONSOLE_ERR:/.test(l));
    assert('⑦ 无 console.error', cerrs.length === 0, cerrs.slice(0, 2).join(' | '));
    /* 匿名访问受保护接口会拿到 401/403，那是**预期**（后端按来源白名单/鉴权拦），不算回归。
       其余 4xx/5xx 一律算失败。 */
    const ALLOW_HTTP = /\/api\/(auth\/refresh|files\/|notifications)/;
    const bad = failed.filter((x) => !ALLOW_HTTP.test(x));
    assert('⑦ 无非预期失败请求（4xx/5xx）', bad.length === 0, bad.slice(0, 3).join(' | ') || '无');

    const allOk = results.every(Boolean);
    console.log('\n' + (allOk ? '★ SPA 路由冒烟全部通过 (' + results.length + ')' : '✗ 有失败项 (' + results.filter(Boolean).length + '/' + results.length + ')'));
    await killBrowserAndClean(b, PROFILE, ws);
    process.exit(allOk ? 0 : 1);
  } catch (e) {
    console.error('ERR', e.message);
    try {
      const st = await ev(`({ href: location.href, ready: document.readyState, body: document.body.textContent.replace(/\\s+/g,' ').trim().slice(0,120) })`);
      console.error('  现场：href=' + (st && st.href) + ' ready=' + (st && st.ready));
      console.error('  正文=' + (st && st.body));
    } catch (_) {}
    console.error('  日志：' + (logs.length ? logs.slice(-8).join('\n         ') : '（无）'));
    console.error('  失败请求：' + (failed.length ? failed.slice(-10).join(' | ') : '（无）'));
    await killBrowserAndClean(b, PROFILE, ws);
    process.exit(2);
  }
})();
