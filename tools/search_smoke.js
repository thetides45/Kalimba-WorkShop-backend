/**
 * 搜索功能端到端冒烟（CDP 驱动无头 Edge）。
 * ① 顶栏搜索框存在且在「我的」与「消息」之间、两侧留白足够
 * ② 提交 → 跳 /search?keyword=，三组（琴谱/用户/标签）按真实接口渲染
 * ③ 类型 chip 过滤（点「用户」→ 琴谱组隐藏）
 * ④ 标签卡点击 → 用标签名再搜一次
 * ⑤ 无结果 → 空状态
 * 前置：前端 dev server 在 **5174**（`cd web-vue && npm run dev`）+ 后端在 8080。
 *       ⚠️ 2026-10-10 主线已切到 `web-vue/`（Vue 3 SPA），URL 由 `search.html` 改为 `/search`。
 *
 * ⚠️ 副作用：本脚本会真的发起搜索，而后端会把「新搜索」记进 search_log（热搜数据源），
 *    因此测试用的关键词（尤其「无结果」用例的假词）会出现在热搜榜上。跑完可清一次：
 *      mysql -uroot -proot --default-character-set=utf8mb4 -e \
 *        "USE kalimba_workshop; DELETE FROM search_log WHERE keyword LIKE 'zzz%';"
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { SHARED_PROFILE, prepareProfile, killBrowserAndClean } = require('./browser_profile');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9371;
const BASE = process.env.KAL_WEB || 'http://127.0.0.1:5174';
/* 全体冒烟共用固定 profile：原先各脚本各用一个固定目录（.search_prof 等），
   加上 process.exit() 让 finally 的清理跑不到，每个都常驻约 280 MB。 */
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
let ws, seq = 0; const pending = new Map(); const logs = [];
function send(method, params = {}) {
  return new Promise((res, rej) => { const id = ++seq; pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })); });
}
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __exc: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || 'eval error' };
  return r.result ? r.result.value : undefined;
}
/**
 * 元素「可见」判断的**空安全**表达式。
 *
 * ⚠️ 不要直接写 `getComputedStyle(getElementById('x')).display !== 'none'`：
 * SPA 版（Vue）在**组件挂载前**这些节点还不存在，getComputedStyle(null) 会抛异常；
 * 而 `ev()` 把异常折成一个**真值对象**返回 —— `waitFor()` 于是把它当成「条件已满足」立刻放行，
 * 紧接着的断言读到 undefined 才崩（现象是「报了一个和现场毫不相干的 TypeError」）。
 * 统一走这里：元素不存在一律算「不可见」，让它继续轮询到真正渲染出来。
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
async function waitFor(fn, desc, timeout = 9000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await fn()) return true; await sleep(300); }
  throw new Error('等待超时: ' + desc);
}
/**
 * 整页导航（**带落地确认 + 重试**）。
 *
 * ⚠️ 不要写「赋值 location.href 就当导航成功」：本机 sandbox 里第三方字体（Google Fonts）请求
 * 一直挂着（缺口 F12），此时用 CDP 触发的整页导航会**偶发被静默吞掉** —— 地址栏停在原页、
 * 无失败请求、新页面的 console 都不出现。2026-10-04 实测：同一批 4 个 UI 冒烟里，
 * 做了落地确认的两个（pwa / v3_features）全过，没做的两个（本文件与 admin_ui_smoke）双双超时。
 * 所以：打个一次性 token 再跳，读得到 token = 还是老文档 = 没跳成 → 重试并**大声打出来**。
 */
async function go(url, readyExpr, desc) {
  /* 绝对化：允许传相对路径。不解析的话下面 `location.href === url` 永远为假，
     会被误判成「导航被吞」而空转 3 轮。 */
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
  /* 三种都会走到这里，且**症状很像**，所以不硬指某一种，而是依次给排查指令：
     ① 5174 前端 dev server 没在跑（本机 curl 经一层代理，502 = 没服务；页面会落到 chrome-error://）
        —— 2026-10-04 实测最常见，占本轮全部失败。先前文案只喊「字体长挂」把人带偏过一轮。
     ② 本机字体长挂（缺口 F12）时 CDP 整页导航偶发被静默吞掉。诊断开关 KAL_BLOCK_FONTS=1。
     ③ 有陈旧无头 Edge 占着固定调试端口 / profile。 */
  throw new Error(
    '导航始终未生效: ' + target + '\n'
    + '    排查顺序：\n'
    + '      1) 前端 dev server 在不在？ curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5174/  （要 200；未启动就 cd web-vue && npm run dev）\n'
    + '      2) 后端在不在？      curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/api/posts        （要 200）\n'
    + '      3) 用 KAL_BLOCK_FONTS=1 复跑一次以隔离字体长挂（缺口 F12）');
}

(async () => {
  const b = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=' + PORT, '--window-size=1440,900', '--user-data-dir=' + PROFILE, BASE + '/'], { stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    const u = await connect();
    ws = new WebSocket(u);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map((a) => a.value || a.description || '').join(' '));
      if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + (m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description));
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    };
    await send('Runtime.enable'); await send('Page.enable');
    await waitFor(() => ev(`!!document.querySelector('.navsearch input')`), '顶栏搜索框出现');

    /* ---------- ① 顶栏位置 ---------- */
    const geo = await ev(`(() => {
      const box = document.querySelector('.navsearch');
      const mine = [...document.querySelectorAll('.navlinks a')].find(a => a.textContent.trim() === '我的');
      const right = document.querySelector('.topnav .iconbtn') || document.querySelector('.topnav .navavatar') || document.querySelector('.topnav .btn');
      const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, w: b.width }; };
      return { box: r(box), mine: r(mine), right: r(right) };
    })()`);
    if (geo.box && geo.mine && geo.right) {
      const gapL = geo.box.l - geo.mine.r, gapR = geo.right.l - geo.box.r;
      assert('搜索框在「我的」右侧且留白 >=24px', gapL >= 24, `${Math.round(gapL)}px`);
      assert('搜索框在右侧按钮左侧且留白 >=24px', gapR >= 24, `${Math.round(gapR)}px`);
    } else {
      assert('顶栏「我的」/右侧按钮定位可用', false, JSON.stringify(geo));
    }

    /* ---------- ② 提交 → /search 三组 ---------- */
    await ev(`(() => {
      const i = document.getElementById('nav-search-input');
      i.value = '天空'; i.dispatchEvent(new Event('input', { bubbles: true }));
      i.closest('form').requestSubmit(); return true;
    })()`);
    await waitFor(() => ev(`location.pathname.indexOf('/search') >= 0`), '跳到搜索页');
    await waitFor(() => ev(`document.querySelectorAll('#s-post-list .post-card').length > 0`), '琴谱组渲染');

    const s1 = await ev(`(() => ({
      href: location.href,
      posts: document.querySelectorAll('#s-post-list .post-card').length,
      postsN: document.getElementById('s-posts-n').textContent,
      hasPill: !!document.querySelector('#s-post-list .match-pill'),
      pillText: (document.querySelector('#s-post-list .match-pill') || {}).textContent || '',
      usersTip: (document.getElementById('s-user-list') || {}).textContent || '',
      meta: document.getElementById('s-meta').textContent,
      inputVal: document.getElementById('s-input').value
    }))()`);
    assert('提交后进入 /search 且带 keyword', /\/search\?keyword=/.test(decodeURIComponent(s1.href)), decodeURIComponent(s1.href).split('?')[1]);
    /* ⚠️ 原断言写死「恰好 2 篇」——那是在断言**库里的数据量**，不是搜索行为。
       冒烟跑多了会累积同名测试帖（api_smoke / audit_smoke 都建《天空之城》），
       于是它必然随数据漂移而变红（2026-10-03 实测：库里已有 5 篇）。
       改成断言**行为**：有命中，且每张卡确实都包含关键词。 */
    assert('琴谱组有命中（不断言具体篇数：库里同名测试帖会累积）',
      s1.posts > 0, `${s1.posts} 篇 / 页脚「${String(s1.postsN).trim()}」`);
    assert('结果卡片标注命中位置', s1.hasPill && s1.pillText.includes('标题'), s1.pillText);
    assert('搜索页大搜索框回填关键词', s1.inputVal === '天空', s1.inputVal);
    assert('页面标题行显示关键词', s1.meta.includes('天空'), s1.meta);

    /* ---------- ③ 关键词「演」→ 用户组；点「用户」chip 隐藏琴谱组 ---------- */
    await go(BASE + '/search?keyword=' + encodeURIComponent('演'), `document.querySelectorAll('#s-user-list .user-card').length > 0`, '用户组渲染');
    const s2 = await ev(`(() => ({
      users: document.querySelectorAll('#s-user-list .user-card').length,
      userName: (document.querySelector('#s-user-list .uc-name') || {}).textContent || '',
      posts: document.querySelectorAll('#s-post-list .post-card').length,
      usersShown: getComputedStyle(document.getElementById('s-users')).display !== 'none',
      postsShown: getComputedStyle(document.getElementById('s-posts')).display !== 'none'
    }))()`);
    assert('用户组命中演示用户', s2.users >= 1 && s2.userName.includes('演示'), `${s2.users} 位 / ${s2.userName}`);
    assert('综合模式下琴谱组与用户组同时可见', s2.postsShown && s2.usersShown);

    await ev(`(() => { [...document.querySelectorAll('#type-chips .chip')].find(c => c.dataset.type === 'user').click(); return true; })()`);
    await sleep(1200);
    const s3 = await ev(`(() => ({
      postsShown: getComputedStyle(document.getElementById('s-posts')).display !== 'none',
      usersShown: getComputedStyle(document.getElementById('s-users')).display !== 'none',
      tagsShown: getComputedStyle(document.getElementById('s-tags')).display !== 'none',
      chipOn: (document.querySelector('#type-chips .chip.on') || {}).dataset ? document.querySelector('#type-chips .chip.on').dataset.type : ''
    }))()`);
    assert('点「用户」后琴谱组隐藏', s3.postsShown === false);
    assert('点「用户」后仅用户组可见', s3.usersShown === true && s3.tagsShown === false, `chip=${s3.chipOn}`);

    /* ---------- ④ 标签命中 + 标签卡点击 ---------- */
    await go(BASE + '/search?keyword=' + encodeURIComponent('翻弹'), `document.querySelectorAll('#s-tag-list .tag-card').length > 0`, '标签组渲染');
    const s4 = await ev(`(() => ({
      tags: document.querySelectorAll('#s-tag-list .tag-card').length,
      tagName: (document.querySelector('#s-tag-list .tc-name') || {}).textContent || '',
      posts: document.querySelectorAll('#s-post-list .post-card').length,
      pill: (document.querySelector('#s-post-list .match-pill') || {}).textContent || ''
    }))()`);
    assert('标签组命中「翻弹」', s4.tags >= 1 && s4.tagName.includes('翻弹'), s4.tagName.trim());
    assert('按标签名也能搜到琴谱', s4.posts >= 1, `${s4.posts} 篇 / 标注=${s4.pill}`);

    await ev(`(() => { document.querySelector('#s-tag-list .tag-card').click(); return true; })()`);
    await sleep(1200);
    const s5 = await ev(`(() => ({ kw: document.getElementById('s-input').value, href: location.href }))()`);
    assert('点标签卡后用标签名再搜', s5.kw === '翻弹' && decodeURIComponent(s5.href).includes('keyword=翻弹'), decodeURIComponent(s5.href).split('?')[1]);

    /* ---------- ⑤ 无结果 → 空状态 ---------- */
    await go(BASE + '/search?keyword=' + encodeURIComponent('zzz绝对不存在xyz'), vis('s-empty'), '空状态出现');
    const s6 = await ev(`(() => ({
      emptyShown: ${vis('s-empty')},
      emptyText: (document.getElementById('s-empty') || {}).textContent || '',
      posts: document.querySelectorAll('#s-post-list .post-card').length
    }))()`);
    assert('无结果时显示空状态', s6.emptyShown && s6.emptyText.includes('没有找到'), s6.emptyText.slice(0, 24));
    assert('无结果时琴谱组无卡片', s6.posts === 0, `${s6.posts} 条`);

    /* ---------- ⑥ 空关键词（直接访问搜索页） ---------- */
    await go(BASE + '/search', vis('s-empty'), '空关键词提示');
    const s7 = await ev(`(document.getElementById('s-empty') || {}).textContent || ''`);
    assert('空关键词提示输入', s7.includes('输入关键词'), s7.slice(0, 20));

    /* ---------- ⑦ 热搜词 + 搜索历史 ---------- */
    await waitFor(() => ev(vis('hot-row')), '热门搜索行出现');
    const h1 = await ev(`(() => {
      const first = document.querySelector('#hot-chips .kw-chip');
      return {
        chips: document.querySelectorAll('#hot-chips .kw-chip').length,
        first: first ? first.dataset.kw : '',
        historyShown: ${vis('history-row')},
        historyChips: document.querySelectorAll('#history-chips .kw-chip').length
      };
    })()`);
    assert('热门搜索有词条（榜空时回退热门标签）', h1.chips > 0, `${h1.chips} 条 / 首条=${h1.first}`);
    assert('最近搜索已记录本次流程搜过的词', h1.historyShown && h1.historyChips > 0, `${h1.historyChips} 条`);

    await ev(`(() => { document.querySelector('#hot-chips .kw-chip').click(); return true; })()`);
    await waitFor(() => ev(`document.getElementById('s-input').value.trim().length > 0`), '点热词后进入搜索');
    const h2 = await ev(`(() => ({ kw: document.getElementById('s-input').value, href: decodeURIComponent(location.href) }))()`);
    assert('点热门词条可直接发起搜索', h2.kw === h1.first && h2.href.indexOf('keyword=' + h1.first) >= 0, h2.kw);

    await ev(`(() => { document.getElementById('history-clear').click(); return true; })()`);
    await sleep(500);
    const h3 = await ev(`(() => ({
      shown: ${vis('history-row')},
      chips: document.querySelectorAll('#history-chips .kw-chip').length,
      stored: localStorage.getItem('kc_search_history')
    }))()`);
    assert('点「清空」后历史记录消失', h3.shown === false && h3.chips === 0, `stored=${h3.stored}`);

    const errs = logs.filter((l) => /EXC:/.test(l));
    assert('无 console 异常', errs.length === 0, errs.slice(0, 2).join(' | '));

    const allOk = results.every(Boolean);
    console.log('\n' + (allOk ? '★ 搜索端到端冒烟全部通过 (' + results.length + ')' : '✗ 有失败项 (' + results.filter(Boolean).length + '/' + results.length + ')'));
    /* ⚠️ 清理必须在 exit 之前做完：process.exit() 会跳过 finally（Node 文档明确说明），
       原先把 kill 放在 finally 里等于没执行，profile 因此一直残留。 */
    await killBrowserAndClean(b, PROFILE, ws);
    process.exit(allOk ? 0 : 1);
  } catch (e) {
    console.error('ERR', e.message);
    await killBrowserAndClean(b, PROFILE, ws);
    process.exit(2);
  }
})();
