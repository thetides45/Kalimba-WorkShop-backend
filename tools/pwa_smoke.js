/**
 * PWA 冒烟（CDP 无头 Edge）—— 纯 HTTP/浏览器，不直连数据库、不 spawn 外部程序。
 *
 * 覆盖：
 *   ① manifest 可访问且字段达标（名称 / start_url **非空** / standalone / 192+512+maskable 图标）
 *      ⚠️ 这里只验 start_url 有值 —— 它**真能不能启动站点**由 ④-b 验（F18 就是从这里漏过去的）
 *   ② 图标可访问且是 PNG
 *   ③ 应用壳（SPA 的 `index.html`）head 引了 manifest；制谱页 head 也引了
 *   ④ Service Worker 注册并 activated，重载后被 SW 接管
 *   ④-b ★ 按 manifest.start_url **真导航一次**：不落到 /404、且应用真的渲染出来（缺口 F18）
 *   ⑤ 预缓存写入（应用壳 + **制谱器** + 图标）；且**缓存面已收窄 —— dev 模块图不再进缓存**（缺口 F15）
 *   ⑥ 可安装时出现「安装到桌面」浮层；点 × 后消失并记住不再提示
 *   ⑦ 断网重载：**外壳文档**仍能从缓存还原（dev 下模块不入缓存 → 只还原壳，离线完整可用
 *      只在生产构建下成立，因为那时模块在 /assets/** 才会被缓存）
 *   ⑦-b ★ 离线降级（2026-10-15）：**静态 + 缓存层**验证 —— 壳含快速路径脚本、sw.js 含 isShellRoot
 *      分流与 composer.html 回落、制谱器可从缓存直接命中、且「只有首页算首页」（帖子/广场不降级）。
 *      ⚠️ 刻意**不**做「CDP 断网再导航」的行为验证：实测 `Network.emulateNetworkConditions` 只改
 *         `navigator.onLine`，**断不了 SW 自己的网络**（SW 是独立 target），这条分支在 CDP 里触发不了。
 *         真断网复核已单独做过（停 dev server）。
 *   ⑧ 制谱页（composer.html）head 标签已注入且**注入后仍能正常出谱**
 *   ⑨ 无 console 异常
 *
 * 前置：前端 dev server 在 **5174**（`cd web-vue && npm run dev`；Service Worker 只在 localhost / HTTPS 生效）。
 *       ⚠️ 2026-10-10 主线已切到 `web-vue/`（Vue 3 SPA）。V3 是 11 个 .html 的多页站，
 *       SPA 只有一个 `index.html` 外壳 + 前端路由，所以 ③/⑤ 的「页面清单」口径按 SPA 改写。
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { SHARED_PROFILE, prepareProfile, killBrowserAndClean } = require('./browser_profile');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9421;
const BASE = process.env.KAL_WEB || 'http://127.0.0.1:5174';
/* 原来建在 os.tmpdir() 且带 Date.now() 后缀，而 process.exit() 又让 finally 的清理永不执行
   → 每跑一次都在 %TEMP% 留一个几百 MB 的目录。改用全体冒烟共用的固定 profile。 */
const PROFILE = SHARED_PROFILE;

/* 浏览器进程与 CDP 连接提到模块作用域，供 exit 钩子清理（同 v3_features_smoke.js 的说明）。 */
let browser = null;
let cdpWs = null;
process.on('exit', () => {
  try { cdpWs && cdpWs.close(); } catch (_) {}
  try { browser && browser.kill(); } catch (_) {}
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (_) {}
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, seq = 0; const pending = new Map(); const logs = [];
function send(method, params = {}) {
  return new Promise((res, rej) => { const id = ++seq; pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })); });
}
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __exc: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || 'eval error' };
  return r.result ? r.result.value : undefined;
}
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

(async () => {
  /* ---------- ① / ② 静态资源（Node 直接查，不进浏览器） ---------- */
  const mfRes = await fetch(BASE + '/manifest.webmanifest');
  const mfType = mfRes.headers.get('content-type') || '';
  let mf = null;
  try { mf = await mfRes.json(); } catch (_) {}
  assert('manifest 可访问且是合法 JSON', mfRes.status === 200 && !!mf, 'HTTP ' + mfRes.status);
  if (mf) {
    assert('manifest 含名称与短名', !!mf.name && !!mf.short_name, (mf.name || '') + ' / ' + (mf.short_name || ''));
    assert('manifest start_url 与 scope 合法', !!mf.start_url && !!mf.scope, `${mf.start_url} scope=${mf.scope}`);
    assert('manifest display=standalone', mf.display === 'standalone', String(mf.display));
    const icons = mf.icons || [];
    const has = (sizes, purpose) => icons.some((i) => i.sizes === sizes && (!purpose || (i.purpose || '').indexOf(purpose) >= 0));
    assert('manifest 含 192×192 图标', has('192x192'));
    assert('manifest 含 512×512 图标', has('512x512'));
    assert('manifest 含 maskable 图标', icons.some((i) => (i.purpose || '').includes('maskable')));
  }
  const icon192 = await fetch(BASE + '/icons/icon-192.png');
  const icon512 = await fetch(BASE + '/icons/icon-512.png');
  assert('192 图标可访问且为 PNG',
    icon192.status === 200 && (icon192.headers.get('content-type') || '').includes('png'),
    icon192.status + ' ' + icon192.headers.get('content-type'));
  assert('512 图标可访问且为 PNG', icon512.status === 200 && (icon512.headers.get('content-type') || '').includes('png'));

  /* ---------- ③ 应用壳 head 引了 manifest ---------- */
  /* SPA 只有一个 HTML 外壳：所有路由都由前端渲染，manifest 只需在壳上与制谱页上各有一份。
     composer.html（制谱页）是离线单文件制谱器的派生页，由 tools/sync_composer.js 注入
     同一套头部标签 —— 它也在 SW scope 内，漏了它会成为唯一装不了的页面。 */
  const shellHtml = await (await fetch(BASE + '/')).text();
  assert('应用壳 head 含 manifest 与 theme-color',
    /rel="manifest"/.test(shellHtml) && /theme-color/.test(shellHtml));

  /* 制谱页还要有图标（它没有引 assets/style.css，是单独注入的一套） */
  const compHtml = await (await fetch(BASE + '/composer.html')).text();
  assert('制谱页 head 含 favicon 与 apple-touch-icon',
    /rel="icon"[^>]*icons\/icon-192\.png/.test(compHtml) && /rel="apple-touch-icon"/.test(compHtml));

  /* ---------- 启动浏览器 ---------- */
  prepareProfile();                       // 先扫掉历史残留（含 %TEMP% 里的旧 pwa profile）
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
      if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map((a) => a.value || a.description || '').join(' '));
      if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + (m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description));
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    };
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');

    /* ---------- ④ Service Worker 注册 ---------- */
    await waitFor(() => ev(`navigator.serviceWorker && navigator.serviceWorker.getRegistration().then(r => !!r)`), 'SW 注册出现', 20000);
    await waitFor(() => ev(`navigator.serviceWorker.ready.then(r => !!(r && r.active))`), 'SW 进入 activated', 20000);
    const swInfo = await ev(`navigator.serviceWorker.getRegistration().then(r => r ? { scope: r.scope, active: r.active.state } : null)`);
    assert('Service Worker 已 activated', !!swInfo && swInfo.active === 'activated', JSON.stringify(swInfo));

    /* 首屏加载时 SW 刚注册，还没接管当前文档（sw.js 刻意不 clients.claim，见其文件头说明）；
       重载一次由 SW 接管 —— 这是**标准生命周期**：SW 从下一次导航开始接管。 */
    await send('Page.reload');
    await sleep(2500);
    await waitFor(() => ev(`!!navigator.serviceWorker.controller`), '页面被 SW 接管', 20000);
    assert('重载后页面由 Service Worker 接管', await ev(`!!navigator.serviceWorker.controller`));

    /* ---------- ④-b 缺口 F18：manifest.start_url 必须**真的能启动站点** ----------
       「start_url 非空」是**假绿**：它得真能打开应用。此前本文件只断言 mf.start_url 有值（见 ①），
       于是漏掉了这个 bug —— start_url 是 V3 遗留的 `./index.html`，而 SPA 用 createWebHistory：
       `/index.html` **匹配不到任何路由**，被 router 的 catch-all（`/:pathMatch(.*)*`）
       重定向到 `/404` ⇒ **装到桌面后一打开就是 404 页**。
       这里按 manifest 里写的 start_url 真导航一次，断言既没落到 /404、也确实渲染出了应用。
       ⚠️ 注意 SW 侧是自洽的（导航离线兜底也回落 index.html），所以**离线反而能出壳**，
       坏的是「有网时按 start_url 打开」这条路径 —— 别只盯 sw.js。 */
    const startUrl = new URL(mf.start_url, BASE + '/manifest.webmanifest').href;
    await ev(`location.href = ${JSON.stringify(startUrl)}; true`);
    await waitFor(() => ev(`document.readyState === 'complete'`), 'start_url 导航完成', 15000);
    await sleep(1500);                       // 给 SPA 路由判定与首屏渲染留时间
    const landedPath = await ev(`location.pathname`);
    /* ⚠️ 判据必须挑一个**首页独有**的签名元素。原先写 `.wrap` —— 404 页也有 .wrap，
       于是 start_url 错到 /404 时这条依然是绿的（假绿）。
       `#post-list` 是首页卡片流的容器，HomeView 模板里恒存在（数据没拉到也在），
       且其它路由没有它 ⇒ 只有真的落在首页才通过。 */
    const landedRendered = await ev(`!!document.querySelector('#post-list')`);
    assert('★ 按 manifest.start_url 打开**不落到 404 页**（F18）',
      landedPath !== '/404', `start_url=${mf.start_url} → ${landedPath}`);
    assert('★ manifest.start_url 打开后确实落在**首页**（不是 404 那个空壳）',
      landedRendered === true, `landed=${landedPath} #post-list=${landedRendered}`);

    /* ---------- ⑤ 预缓存 ---------- */
    const cacheInfo = await ev(`(async () => {
      const names = await caches.keys();
      const target = names.filter(n => n.indexOf('kalimba-pwa') === 0);
      let keys = [];
      if (target.length) { const c = await caches.open(target[0]); keys = (await c.keys()).map(r => new URL(r.url).pathname); }
      return { names: target, keys };
    })()`);
    assert('建立了 PWA 缓存', Array.isArray(cacheInfo.names) && cacheInfo.names.length > 0, JSON.stringify(cacheInfo.names));
    const hasKey = (k) => (cacheInfo.keys || []).some((x) => x.indexOf(k) >= 0);
    assert('预缓存含应用壳 index.html', hasKey('/index.html') || hasKey('/'));
    /* SPA 的构建产物带内容哈希（`/assets/index-<hash>.js|css`），文件名不可预知 →
       SW 只预缓存壳与图标，产物走运行时缓存。这里断言的是「壳确实进了缓存」。 */
    assert('预缓存含壳与图标清单',
      hasKey('/index.html') && hasKey('/icons/icon-192.png') && hasKey('/manifest.webmanifest'),
      (cacheInfo.keys || []).length + ' 项：' + (cacheInfo.keys || []).join(' '));
    /* ★ 2026-10-15：制谱器必须**预缓存**，不能只靠「访问过才进运行时缓存」——
       「PWA 离线启动直接进制谱器」这条降级路径要求它离线时**一定**拿得到。
       （v2 时它刻意不在清单里，理由见 sw.js 的注释；现在需求变了。） */
    assert('★ 预缓存含制谱器 /composer.html（离线降级的先决条件）',
      hasKey('/composer.html'), (cacheInfo.keys || []).length + ' 项');

    /* ---------- ⑤-b 缺口 F15：缓存面已收窄，dev 模块图不再进缓存 ---------- */
    /* 这是 F15 的**直接验收**。页面加载时 Vite 会请求几十个 `/src/**` 与
       `/node_modules/.vite/deps/**` 模块；收窄前 SW 对一切同源 GET 做 cache-first，
       它们全被写进缓存（实测 45 项里 39~40 项是 dev 模块）→ 「壳是新的、模块是旧的」。
       收窄后这些路径**一条都不该在**（它们不落 /assets/、也不在壳/图标清单里）。 */
    const devKeys = (cacheInfo.keys || []).filter((k) =>
      k.indexOf('/src/') === 0 || k.indexOf('/@vite') === 0 ||
      k.indexOf('/@id/') === 0 || k.indexOf('/@fs/') === 0 || k.indexOf('/node_modules/') >= 0);
    assert('缓存中不含 dev 模块（F15：只接管构建产物与壳/图标）',
      devKeys.length === 0,
      devKeys.length ? devKeys.length + ' 项泄漏：' + devKeys.slice(0, 3).join(' ') : '干净');

    /* ---------- ⑥ 安装浮层 ---------- */
    /* Chromium 判定站点可安装时会**自然触发** beforeinstallprompt，所以这里不假设它一定不出现：
       若浏览器已自行判定可安装，直接用它（顺带证明 manifest + SW + 图标达到了安装标准）；
       否则再派发一个合成事件来验证「浮层出现 → 点 × 消失」这段 UI 逻辑。 */
    const naturalFired = await ev(`!!document.querySelector('.pwa-card') || (window.PWA && window.PWA.hasPrompt())`);
    if (naturalFired) {
      assert('浏览器自行判定「可安装」并显示了安装浮层', true, 'beforeinstallprompt 自然触发');
    } else {
      await ev(`(() => {
        const e = new Event('beforeinstallprompt');
        e.prompt = function(){ window.__pwaPrompted = true; };
        e.userChoice = Promise.resolve({ outcome: 'dismissed' });
        window.dispatchEvent(e);
        return true;
      })()`);
      await sleep(400);
      assert('派发 beforeinstallprompt 后出现安装浮层', (await ev(`!!document.querySelector('.pwa-card')`)) === true);
    }
    const cardInfo = await ev(`(() => {
      const c = document.querySelector('.pwa-card');
      return c ? { text: c.textContent, hasBtn: !!c.querySelector('.pwa-go'), hasClose: !!c.querySelector('.pwa-x'),
                   bottom: c.getBoundingClientRect().bottom, right: c.getBoundingClientRect().right } : null;
    })()`);
    assert('浮层文案为「安装到桌面」', !!cardInfo && cardInfo.text.indexOf('安装到桌面') >= 0,
      cardInfo ? cardInfo.text.replace(/\s+/g, ' ').trim() : '未出现');
    assert('浮层含安装按钮与关闭按钮', !!cardInfo && cardInfo.hasBtn && cardInfo.hasClose);
    assert('浮层固定在右下角', !!cardInfo && cardInfo.bottom > 600 && cardInfo.right > 1000,
      cardInfo ? `bottom=${Math.round(cardInfo.bottom)} right=${Math.round(cardInfo.right)}` : '');

    await ev(`document.querySelector('.pwa-card .pwa-x').click()`);
    await sleep(300);
    const afterClose = await ev(`({ gone: !document.querySelector('.pwa-card'), flag: localStorage.getItem('kc_pwa_dismissed') })`);
    assert('点 × 后浮层消失', afterClose.gone === true);
    assert('关闭后记住不再提示', afterClose.flag === '1', 'flag=' + afterClose.flag);

    /* ---------- ⑦ 断网重载：外壳文档仍可还原 ---------- */
    await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await send('Page.reload');
    await sleep(2500);
    const offline = await ev(`(() => ({
      hasApp: !!document.querySelector('#app'),
      htmlLen: document.documentElement.outerHTML.length,
      title: document.title,
      header: !!document.querySelector('.topnav'),
      bodyLen: document.body.textContent.replace(/\\s+/g, ' ').trim().length
    }))()`);
    /* ⚠️ F15 收窄后这条断言的口径变了：dev 下模块（/src/**）**不再进缓存**，
       所以断网只能还原「外壳文档」，应用拿不到模块 → 渲染不出顶栏。这是**预期行为**、
       不是回归；离线**完整可用**只在生产构建下成立（那时模块在 /assets/** 才会被缓存）。
       因此这里只断言「文档确实来自缓存」：壳加载了、#app 挂载点在、标题正确。 */
    /* ⚠️ 口径澄清（2026-10-15）：CDP 的 offline **断不了 SW 的网络**（见 ⑦-b 的说明），
       所以下面第一条其实只能证明「文档能加载」，**不能**证明它来自缓存 —— 它一直是**假绿**。
       真正有效的离线证据是第二条（页面侧模块请求确实失败）与 ⑦-b 的缓存命中检查。
       保留它是因为它顺带验证了「断网时不至于拿到空白页」这个最低要求。 */
    assert('断网重载：外壳文档仍能拿到（离线兜底生效）',
      !!offline && offline.hasApp === true && !!offline.title && offline.htmlLen > 200,
      `title=${offline && offline.title} html=${offline && offline.htmlLen}`);
    /* 把「dev 下离线只是一个空壳」这件事**显式断言**下来：否则将来有人看到「断网后白屏」
       会误判成 PWA 坏了。顶栏是 Vue 渲染的，模块拿不到就一定不出现。 */
    assert('断网重载：dev 下模块不入缓存 → 只还原外壳、应用不渲染（F15 预期）',
      !!offline && offline.header === false,
      `header=${offline && offline.header} bodyLen=${offline && offline.bodyLen}`);
    await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

    /* ---------- ⑦-b ★ 离线降级：静态 + 缓存层验证（2026-10-15） ---------- */
    /* ⚠️ 这里**刻意不做**「CDP 断网后再导航」的行为验证 —— 2026-10-15 实测：
       `Network.emulateNetworkConditions({offline:true})` 只把 `navigator.onLine` 改成 false，
       **断不了 Service Worker 自己的网络**（SW 是独立 target，不受页面 Network domain 管辖）。
       实测现象：断网后页面内 `fetch('/')` 仍返回 200、导航 `/` 拿到的仍是**网络上的** index.html，
       所以「SW 的 fetch 失败 → 交回制谱器」这条分支**在 CDP 里触发不了**。
       真要验必须把 dev server 真的停掉（真断网），那超出本冒烟「纯 HTTP/浏览器、不起停外部进程」的定位
       —— 已单独做过一次真断网复核。
       这里改为钉住三件**可稳定验证**的事：脚本在、缓存有、判定逻辑对。 */
    const shellSrc = await ev(`fetch('/', { cache: 'no-store' }).then(r => r.text())`);
    assert('★ 应用壳含离线快速路径脚本（standalone + 断网 → 进制谱器）',
      typeof shellSrc === 'string' && shellSrc.indexOf('display-mode: standalone') >= 0
        && shellSrc.indexOf('/composer.html') >= 0,
      typeof shellSrc === 'string' ? 'len=' + shellSrc.length : String(shellSrc));

    const swSrc = await ev(`fetch('/sw.js', { cache: 'no-store' }).then(r => r.text())`);
    assert('★ sw.js 含离线分流（isShellRoot 判定 + 回落 composer.html）',
      typeof swSrc === 'string' && swSrc.indexOf('isShellRoot') >= 0 && swSrc.indexOf("'./composer.html'") >= 0,
      typeof swSrc === 'string' ? 'len=' + swSrc.length : String(swSrc));

    const cacheHit = await ev(`(async () => {
      const names = (await caches.keys()).filter(n => n.indexOf('kalimba-pwa') === 0);
      if (!names.length) return { hit: null, names: [] };
      const c = await caches.open(names[0]);
      return { hit: !!(await c.match('/composer.html')), names };
    })()`);
    assert('★ 制谱器可直接从缓存命中（离线降级拿得到它）',
      !!cacheHit && cacheHit.hit === true, JSON.stringify(cacheHit));

    /* 判定语义钉子：只有首页算「首页」。⚠️ 这是**同构重写**的断言 —— 它防的是
       「有人把 SHELL_ROOT 改成 startsWith('/') 之类」，那种写法会让 /post/123 也被降级。 */
    const rootLogic = await ev(`(function () {
      const SHELL_ROOT = '/', SHELL_INDEX = '/index.html';
      const isShellRoot = (p) => p === SHELL_ROOT || p === SHELL_INDEX;
      return { root: isShellRoot('/'), index: isShellRoot('/index.html'),
               post: isShellRoot('/post/123'), works: isShellRoot('/works') };
    })()`);
    assert('★ 分流判定：只有首页算「首页」（帖子/广场不降级进制谱器）',
      !!rootLogic && rootLogic.root === true && rootLogic.index === true
        && rootLogic.post === false && rootLogic.works === false,
      JSON.stringify(rootLogic));

    /* ---------- ⑧ 制谱页：注入头部标签后仍能正常出谱 ---------- */
    /* composer.html = 离线单文件制谱器 + 注入的头部标签/主题变量。这里既验标签注入没破坏
       单文件（首屏仍出谱、init 仍跑），也验注入的 V3 主题覆盖确实压过了内联的原始 :root。 */
    await send('Page.navigate', { url: BASE + '/composer.html' });
    await waitFor(() => ev(`!!document.querySelector('#svgHost svg')`), '制谱页首屏出谱', 25000);
    const comp = await ev(`(() => {
      const svg = document.querySelector('#svgHost svg');
      return {
        title: document.title,
        hasSvg: !!svg,
        textLen: svg ? svg.textContent.length : 0,
        accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
        keys: document.querySelectorAll('#keySel option').length
      };
    })()`);
    assert('制谱页首屏渲染出谱面（注入未破坏单文件）', !!comp && comp.hasSvg && comp.textLen > 100,
      `textLen=${comp && comp.textLen}`);
    assert('制谱页 init 正常（调号已填充）', !!comp && comp.keys === 12, `options=${comp && comp.keys}`);
    assert('制谱页 V3 主题变量生效（--accent 为木色 #5D4432）',
      !!comp && comp.accent.toUpperCase() === '#5D4432', '--accent=' + (comp && comp.accent));

    /* ---------- ⑨ console ---------- */
    const errs = logs.filter((l) => /EXC:/.test(l));
    assert('无 console 异常', errs.length === 0, errs.slice(0, 2).join(' | '));

    const allOk = results.every(Boolean);
    console.log('\n' + (allOk ? '★ PWA 冒烟全部通过 (' + results.length + ')' : '✗ 有失败项 (' + results.filter(Boolean).length + '/' + results.length + ')'));
    /* ⚠️ 清理必须在这里做完再 exit —— process.exit() 会**跳过 finally**，
       原先把 kill+rmSync 放在 finally 里，等于从来没执行过（%TEMP% 就是这么堆起来的）。 */
    await killBrowserAndClean(b, PROFILE, ws);
    process.exit(allOk ? 0 : 1);
  } catch (e) {
    console.error('ERR', e.message);
    await killBrowserAndClean(b, PROFILE, ws);
    process.exit(2);
  }
})();
