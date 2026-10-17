/**
 * 后台管理页（SPA 路由 `/admin`）端到端冒烟（CDP 无头 Edge）—— 纯 HTTP，不直连数据库。
 *
 * 覆盖：未登录 403 / 普通用户非管理员提示 / 管理员可进
 *       概览统计卡 · 待审分区 · 举报分区与筛选 · 用户管理（封禁 → 解除，可逆）
 *       **评论管理（B8：状态筛选 / 数据行渲染 / 下架↔恢复可逆）**
 *       审核记录分区（结果筛选 / 操作类型 chip / 记录渲染）
 * 说明：本机环境下 Node 不能 spawn 外部程序（EBUSY），所以状态校验也走 admin 接口而非 mysql；
 *       用户封禁在 finally 里无条件复位，中途失败也不会留下脏状态。
 * 前置：前端 dev server 在 **5174**（`cd web-vue && npm run dev`）+ 后端在 8080。
 *       ⚠️ 2026-10-10 主线已切到 `web-vue/`（Vue 3 SPA），URL 由 `admin.html` 改为 `/admin`；
 *       仍可用 `KAL_WEB=http://127.0.0.1:5199` 指向别处。
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { SHARED_PROFILE, prepareProfile, killBrowserAndClean } = require('./browser_profile');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9381;
const BASE = process.env.KAL_WEB || 'http://127.0.0.1:5174';
const API = 'http://localhost:8080';
/* 全体冒烟共用固定 profile（原先各脚本各用一个，各自常驻约 280 MB）。 */
const PROFILE = SHARED_PROFILE;

/* 浏览器进程与 CDP 连接提到模块作用域，供 exit 钩子兜底清理
   （进程被外部杀掉时 finally 也跑不到，这一层是最后保险）。 */
let browser = null;
let cdpWs = null;
process.on('exit', () => {
  try { cdpWs && cdpWs.close(); } catch (_) {}
  try { browser && browser.kill(); } catch (_) {}
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (_) {}
});

/* ---- 通过 admin 接口读取/复位 zhangsan（替代直连数据库） ---- */
async function adminToken() {
  const r = await (await fetch(API + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' })
  })).json();
  return r.code === 0 ? r.data.token : null;
}
async function adminZhangSan() {
  try {
    const tok = await adminToken();
    if (!tok) return null;
    const list = await (await fetch(API + '/api/admin/users?keyword=zhangsan', { headers: { 'sa-token': tok } })).json();
    return ((list.data && list.data.records) || [])[0] || null;
  } catch (_) { return null; }
}
async function resetZhangSan() {
  try {
    const u = await adminZhangSan();
    if (u && u.status !== 1) {
      const tok = await adminToken();
      await fetch(`${API}/api/admin/users/${u.id}/status?status=1`, { method: 'PUT', headers: { 'sa-token': tok } });
    }
  } catch (_) {}
}

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
 * 元素「可见」判断的**空安全**表达式生成器。
 *
 * ⚠️ 不能直接写 `getComputedStyle(getElementById('x')).display !== 'none'`：
 * SPA 版（Vue）的分区/提示常以 `v-if` 渲染，**元素压根不存在**时 getComputedStyle(null) 会抛异常，
 * 而 `ev()` 把「抛异常」折成一个**真值对象**返回 —— 于是 `waitFor` 把它当成「条件已满足」，
 * 断言变成**假通过**（V3 的多页版里这些节点是常驻 + display 切换，所以老写法没暴露这个坑）。
 * 统一走这里：元素不存在一律视为「不可见」。
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
 * 「点一个会二次确认的按钮」——**同时兼容两种确认实现**。
 *
 * · V3 多页静态版走原生 `window.confirm`（无头环境会吞掉弹框，覆盖成 `() => true` 即放行）；
 * · SPA 版（Vue）走 Element Plus 的 `ElMessageBox.confirm` —— 那是**真实 DOM 模态框**，
 *   覆盖 window.confirm 对它无效，必须等它出现后点它的「确定」。
 */
async function clickAndConfirm(clickExpr) {
  await ev(`window.confirm = function(){ return true; };`);
  await ev(clickExpr);
  for (let i = 0; i < 25; i++) {
    if (await ev(`!!document.querySelector('.el-message-box__btns .el-button--primary')`)) {
      await ev(`(() => { document.querySelector('.el-message-box__btns .el-button--primary').click(); return true; })()`);
      return;
    }
    await sleep(200);
  }
}
/**
 * 整页导航（**带落地确认 + 重试**）。
 *
 * ⚠️ 不要写「赋值 location.href 就当导航成功」：本机 sandbox 里第三方字体（Google Fonts）请求
 * 一直挂着（缺口 F12），此时用 CDP 触发的整页导航会**偶发被静默吞掉** —— 地址栏停在原页、
 * 无失败请求、新页面的 console 都不出现。2026-10-04 实测：同一批 4 个 UI 冒烟里，
 * 做了落地确认的两个（pwa / v3_features）全过，没做的两个（本文件与 search_smoke）双双超时。
 * 所以：打个一次性 token 再跳，读得到 token = 还是老文档 = 没跳成 → 重试并**大声打出来**。
 */
async function go(url, readyExpr, desc) {
  /* 绝对化：允许传相对路径（'/login'）。不解析的话下面 `location.href === url` 永远为假，
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
  /* 见 search_smoke.js 同处注释：三种原因症状很像，不硬指某一种，依次给排查指令。 */
  throw new Error(
    '导航始终未生效: ' + target + '\n'
    + '    排查顺序：\n'
    + '      1) 前端 dev server 在不在？ curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5174/  （要 200；未启动就 cd web-vue && npm run dev）\n'
    + '      2) 后端在不在？      curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/api/posts        （要 200）\n'
    + '      3) 用 KAL_BLOCK_FONTS=1 复跑一次以隔离字体长挂（缺口 F12）');
}
async function loginAs(username, password) {
  await ev(`(() => { localStorage.removeItem('kc_auth'); return true; })()`);
  /* 走 go() 而不是直接赋值 location.href：这一步同样会被静默吞掉（见 go() 的说明） */
  await go('/login', `!!document.getElementById('lg-user')`, '登录页就绪');
  /* ⚠️ SPA 版登录框是 `v-model`（Vue 双向绑定）——只写 `.value` **不会**同步到组件状态，
     必须再派发一次 `input` 事件，否则提交时读到的是空串、登录必失败。
     （V3 静态版用原生 form，直接赋 value 就够；这行是为 Vue 版补的，对静态版无副作用。） */
  await ev(`(() => {
    const fill = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    fill('lg-user', ${JSON.stringify(username)});
    fill('lg-pass', ${JSON.stringify(password)});
    document.getElementById('form-login').requestSubmit();
    return true;
  })()`);
  await waitFor(() => ev(`!!(JSON.parse(localStorage.getItem('kc_auth')||'null'))`), '登录写入本地会话');
}
async function openTab(sec) {
  await ev(`(() => { [...document.querySelectorAll('#admin-tabs .chip')].find(c => c.dataset.sec === ${JSON.stringify(sec)}).click(); return true; })()`);
  await waitFor(() => ev(vis('sec-' + sec)), `切到分区 ${sec}`);
}

(async () => {
  prepareProfile();                       // 先扫掉历史残留（只清扫，目录交给 Edge 建）
  const b = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=' + PORT, '--window-size=1440,900', '--user-data-dir=' + PROFILE, BASE + '/admin'], { stdio: ['ignore', 'ignore', 'ignore'] });
  browser = b;
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

    /* ---------- ① 未登录 ---------- */
    await waitFor(() => ev(vis('admin-forbidden')), '未登录提示出现');
    const a1 = await ev(`(() => ({
      text: (document.getElementById('admin-forbidden') || {}).textContent || '',
      tabsShown: ${vis('admin-tabs')},
      bodyShown: ${vis('admin-body')}
    }))()`);
    assert('未登录显示「请先登录管理员账号」', a1.text.includes('请先登录管理员账号'), a1.text.slice(0, 22));
    assert('未登录不显示管理分区', a1.tabsShown === false && a1.bodyShown === false);

    /* ---------- ② 普通用户 ---------- */
    await loginAs('demo', '123456');
    await go(BASE + '/admin', vis('admin-forbidden'), '普通用户提示出现');
    const a2 = await ev(`(document.getElementById('admin-forbidden') || {}).textContent || ''`);
    assert('普通用户显示「当前账号不是管理员」', a2.includes('当前账号不是管理员'), a2.slice(0, 22));

    /* ---------- ③ 管理员进入 ---------- */
    await loginAs('admin', '123456');
    await go(BASE + '/admin', vis('admin-tabs'), '管理分区出现');
    await waitFor(() => ev(`document.querySelectorAll('#stat-grid .stat-card').length > 0`), '概览统计渲染');
    const a3 = await ev(`(() => ({
      cards: document.querySelectorAll('#stat-grid .stat-card').length,
      nums: [...document.querySelectorAll('#stat-grid .stat-card .n')].map(e => e.textContent.trim()),
      navHasAdmin: [...document.querySelectorAll('.navlinks a')].some(x => x.textContent.trim() === '管理')
    }))()`);
    assert('概览渲染 4 张统计卡', a3.cards === 4, JSON.stringify(a3.nums));
    assert('统计数字非空', a3.nums.every((n) => n && n !== '—'), JSON.stringify(a3.nums));
    assert('顶栏出现「管理」入口', a3.navHasAdmin === true);

    /* ---------- ④ 待审分区 ---------- */
    await openTab('pending');
    await sleep(900);
    const a4 = await ev(`(() => ({
      rows: document.querySelectorAll('#pending-list .arow').length,
      empty: (document.querySelector('#pending-list .admin-empty') || {}).textContent || '',
      hasApproveBtn: document.querySelectorAll('#pending-list [data-approve]').length
    }))()`);
    assert('待审分区渲染（有行或空态提示）', a4.rows > 0 || a4.empty.includes('暂无待审'),
      a4.rows > 0 ? `${a4.rows} 行` : a4.empty.trim());
    assert('待审行带通过/驳回按钮（与行数一致）', a4.hasApproveBtn === a4.rows, `btn=${a4.hasApproveBtn} row=${a4.rows}`);

    /* ---------- ⑤ 举报分区与筛选 ---------- */
    await openTab('reports');
    await sleep(900);
    const a5 = await ev(`(() => ({
      chipOn: (document.querySelector('#report-chips .chip.on') || {}).dataset ? document.querySelector('#report-chips .chip.on').dataset.status : '',
      chips: document.querySelectorAll('#report-chips .chip').length,
      rendered: document.querySelectorAll('#report-list .arow').length,
      empty: (document.querySelector('#report-list .admin-empty') || {}).textContent || ''
    }))()`);
    assert('举报分区有 4 个状态筛选', a5.chips === 4, String(a5.chips));
    assert('举报默认筛选「待处理」', a5.chipOn === '0', a5.chipOn);
    assert('举报分区渲染（有行或空态提示）', a5.rendered > 0 || a5.empty.includes('没有符合条件'),
      a5.rendered > 0 ? `${a5.rendered} 行` : a5.empty.trim());

    await ev(`(() => { [...document.querySelectorAll('#report-chips .chip')].find(c => c.dataset.status === '').click(); return true; })()`);
    await sleep(900);
    const a5b = await ev(`document.querySelector('#report-chips .chip.on').dataset.status`);
    assert('切到「全部」筛选生效', a5b === '', 'status=' + JSON.stringify(a5b));

    /* ---------- ⑥ 用户管理：封禁 → 解除 ---------- */
    await openTab('users');
    await waitFor(() => ev(`document.querySelectorAll('#user-list .arow').length > 0`), '用户列表渲染');
    const u1 = await ev(`(() => {
      const rows = [...document.querySelectorAll('#user-list .arow')];
      return {
        rows: rows.length,
        adminRows: rows.filter(r => r.querySelector('.pill.admin')).length,
        adminRowHasBanBtn: rows.some(r => r.querySelector('.pill.admin') && r.querySelector('[data-user]'))
      };
    })()`);
    assert('用户列表渲染行', u1.rows > 0, `${u1.rows} 行`);
    assert('管理员行标注「管理员」且不给封禁按钮',
      u1.adminRows >= 1 && u1.adminRowHasBanBtn === false,
      `adminRows=${u1.adminRows} hasBanBtn=${u1.adminRowHasBanBtn}`);

    await ev(`(() => { document.getElementById('user-q').value = 'zhangsan'; document.getElementById('user-search-btn').click(); return true; })()`);
    await waitFor(() => ev(`document.querySelectorAll('#user-list [data-user]').length > 0`), 'zhangsan 出现');

    await clickAndConfirm(`(() => { document.querySelector('#user-list [data-user]').click(); return true; })()`);
    /* 只看渲染出的列表文本：document.body.textContent 会把 <script> 源码也算进去，
       而脚本里就写着 "已封禁" 字面量，那样断言会永远成立（假通过）。 */
    await waitFor(() => ev(`document.getElementById('user-list').textContent.indexOf('已封禁') >= 0`), '页面显示已封禁');
    const after1 = await adminZhangSan();
    assert('点「封禁」后接口读到 status=0', after1 && after1.status === 0, 'status=' + (after1 && after1.status));

    await clickAndConfirm(`(() => { document.querySelector('#user-list [data-user]').click(); return true; })()`);
    await waitFor(() => ev(`document.getElementById('user-list').textContent.indexOf('已封禁') < 0`), '页面回到正常');
    const after2 = await adminZhangSan();
    assert('点「解除封禁」后接口读到 status=1', after2 && after2.status === 1, 'status=' + (after2 && after2.status));

    /* ---------- ⑦ 评论管理（缺口 B8） ---------- */
    await openTab('comments');
    /* ⚠️ 等**数据行**，不要写「行或空态」—— 空态文案在请求返回**之前**就在 DOM 里，会立刻放行。
       本用例前置是确定的：库里必然有评论。 */
    await waitFor(() => ev(`document.querySelectorAll('#cmt-list .arow').length > 0`), '评论列表渲染');
    const c1 = await ev(`(() => {
      const rows = [...document.querySelectorAll('#cmt-list .arow')];
      const first = rows[0];
      return {
        tabs: [...document.querySelectorAll('#admin-tabs .chip')].map(c => c.textContent.trim()),
        rows: rows.length,
        chips: document.querySelectorAll('#cmt-status-chips .chip').length,
        onChip: (document.querySelector('#cmt-status-chips .chip.on') || {}).textContent || '',
        hasAuthor: !!(first && first.querySelector('.a-meta span')),
        hasToggle: !!(first && first.querySelector('[data-cmt-toggle]')),
        hasDel: !!(first && first.querySelector('[data-cmt-del]')),
        firstId: (first && first.dataset) ? first.dataset.cmt : ''
      };
    })()`);
    assert('管理页共 6 个分区（含「评论管理」）', c1.tabs.length === 6 && c1.tabs.includes('评论管理'), JSON.stringify(c1.tabs));
    assert('评论状态筛选有 3 个 chip 且默认「全部」',
      c1.chips === 3 && c1.onChip.indexOf('全部') >= 0, `chips=${c1.chips} on=${c1.onChip}`);
    assert('评论列表渲染出数据行', c1.rows > 0, `${c1.rows} 行`);
    assert('评论行带作者（服务端补齐，前端零拼接）', c1.hasAuthor === true);
    assert('评论行带「下架/恢复」与「删除」按钮', c1.hasToggle && c1.hasDel);

    /* 下架 → 切「已下架」筛选应能筛到 → 恢复。全程**可逆**，不留脏状态。
       ⚠️ 副作用：这一步会给评论作者写一条 system 通知（notification 表没有删除接口），
       与 v3_features_smoke 点赞留通知同类，属已知代价。 */
    const firstCmtId = c1.firstId;
    /* 状态 pill 在 .a-title 里；⚠️ 别用宽泛的 `.pill.off` —— 孤儿评论的「所属帖子已删除」
       也带 off 类，会把计数算错。 */
    await clickAndConfirm(`(() => { document.querySelector('#cmt-list [data-cmt-toggle]').click(); return true; })()`);
    await waitFor(() => ev(`!!document.querySelector('#cmt-list .a-title .pill.off')`), '评论状态变为已下架');

    await ev(`(() => { [...document.querySelectorAll('#cmt-status-chips .chip')].find(c => c.dataset.status === '0').click(); return true; })()`);
    await waitFor(() => ev(`document.querySelectorAll('#cmt-list .arow').length > 0`), '「已下架」筛选出结果');
    const c2 = await ev(`(() => ({
      ids: [...document.querySelectorAll('#cmt-list .arow')].map(r => r.dataset.cmt),
      offTitles: document.querySelectorAll('#cmt-list .a-title .pill.off').length
    }))()`);
    assert('「已下架」筛选能筛到刚下架的那条',
      c2.ids.indexOf(firstCmtId) >= 0, `命中 ${c2.ids.length} 条，目标 #${firstCmtId}`);
    assert('「已下架」筛选的结果行都标为已下架',
      c2.ids.length > 0 && c2.offTitles === c2.ids.length, `off=${c2.offTitles} rows=${c2.ids.length}`);

    await clickAndConfirm(`(() => { document.querySelector('#cmt-list [data-cmt-toggle]').click(); return true; })()`);
    await waitFor(() => ev(`document.querySelectorAll('#cmt-list .a-title .pill.off').length === 0`), '评论已恢复');
    await ev(`(() => { [...document.querySelectorAll('#cmt-status-chips .chip')].find(c => c.dataset.status === '').click(); return true; })()`);
    await waitFor(() => ev(`document.querySelectorAll('#cmt-list .arow').length > 0`), '回到「全部」筛选');
    const c3 = await ev(`(() => ({ ids: [...document.querySelectorAll('#cmt-list .arow')].map(r => r.dataset.cmt) }))()`);
    assert('恢复后该评论回到「全部」列表（下架↔恢复可逆）',
      c3.ids.indexOf(firstCmtId) >= 0, `目标 #${firstCmtId}`);

    /* 物理删除**不测**：不可逆，且会牵动「帖子详情页评论数」等其它断言。
       它由 admin_api_smoke（自建自删）覆盖，这里只验按钮在位（见上）。 */

    /* ---------- ⑧ 审核记录（操作日志）分区 ----------
       注意 ⑥ 的封禁/解除、⑦ 的评论下架/恢复**各自都会写一条 op_log** —— 所以这里可以
       **确定性地**断言「有记录」，不依赖外部先跑过别的脚本。 */
    await openTab('logs');
    /* ⚠️ 等待条件**不能**写成「`.arow` 或 `.admin-empty` 存在」：空态文案（「没有符合条件的操作记录」）
       和数据行不是一个时刻出现的 —— 空态在请求返回**之前**就已经在 DOM 里，那个条件会**立刻放行**，
       于是下面读到的是「还没加载」的空页。2026-10-10 就是这样偶发红的：
       同一次运行里 `a7.rows=0`，紧接着切「仅失败」却读到 `rows=10`（数据其实还在途中）。
       本用例的前置是**确定性**的（见上：⑥ 的封禁 + 解除必然写入 2 条 op_log），所以直接等数据行。
       另：「操作类型」chip 是**另一次**请求填的（`st.logs.actions`），要单独等一次。 */
    await waitFor(() => ev(`document.querySelectorAll('#log-list .arow').length > 0`), '审核记录数据行渲染');
    await waitFor(() => ev(`!!document.querySelector('#log-action-chips .chip, #log-action-chips .log-hint')`), '操作类型 chip 就绪');
    const a7 = await ev(`(() => ({
      tabs: [...document.querySelectorAll('#admin-tabs .chip')].map(c => c.textContent.trim()),
      rows: document.querySelectorAll('#log-list .arow').length,
      successChips: document.querySelectorAll('#log-success-chips .chip').length,
      actionChips: document.querySelectorAll('#log-action-chips .chip').length,
      onSuccess: (document.querySelector('#log-success-chips .chip.on') || {}).textContent || '',
      donePills: document.querySelectorAll('#log-list .pill.done').length,
      empty: (document.querySelector('#log-list .admin-empty') || {}).textContent || ''
    }))()`);
    assert('管理页共 6 个分区（含「审核记录」）', a7.tabs.length === 6 && a7.tabs.includes('审核记录'),
      JSON.stringify(a7.tabs));
    assert('结果筛选有 3 个 chip 且默认「全部结果」',
      a7.successChips === 3 && a7.onSuccess.indexOf('全部') >= 0, a7.onSuccess);
    assert('操作类型 chip 由后端数据反查渲染（≥ 全部类型 + 1 类）', a7.actionChips >= 2, String(a7.actionChips));
    assert('审核记录渲染出真实记录', a7.rows > 0, a7.rows > 0 ? `${a7.rows} 行` : a7.empty.trim());
    assert('记录里带成功标记（⑥ 的封禁/解除刚写入）', a7.donePills > 0, 'done=' + a7.donePills);

    /* 切「仅失败」：渲染出来的行不应再有成功标记 */
    await ev(`(() => { [...document.querySelectorAll('#log-success-chips .chip')].find(c => c.dataset.success === '0').click(); return true; })()`);
    await waitFor(() => ev(`(document.querySelector('#log-success-chips .chip.on')||{}).textContent.indexOf('仅失败') >= 0`), '切到仅失败');
    await sleep(700);
    const a7b = await ev(`(() => ({
      rows: document.querySelectorAll('#log-list .arow').length,
      donePills: document.querySelectorAll('#log-list .pill.done').length,
      waitPills: document.querySelectorAll('#log-list .pill.wait').length,
      empty: (document.querySelector('#log-list .admin-empty') || {}).textContent || ''
    }))()`);
    assert('「仅失败」筛选下不再出现成功标记', a7b.donePills === 0,
      `done=${a7b.donePills} wait=${a7b.waitPills} rows=${a7b.rows}`);
    assert('「仅失败」渲染（有行或空态提示）', a7b.rows > 0 || a7b.empty.includes('没有符合条件'),
      a7b.rows > 0 ? `${a7b.rows} 行` : a7b.empty.trim());

    const errs = logs.filter((l) => /EXC:/.test(l));
    assert('无 console 异常', errs.length === 0, errs.slice(0, 2).join(' | '));

    const allOk = results.every(Boolean);
    console.log('\n' + (allOk ? '★ 后台管理页冒烟全部通过 (' + results.length + ')' : '✗ 有失败项 (' + results.filter(Boolean).length + '/' + results.length + ')'));
    process.exitCode = allOk ? 0 : 1;
  } catch (e) {
    console.error('ERR', e.message);
    process.exitCode = 2;
  } finally {
    /* 先停浏览器并等它真正退出，再带重试地删 profile。
       原先 `b.kill()` 后直接依赖外层的 rmSync：Windows 上句柄未释放必然失败，
       而错误被 `catch (_) {}` 吞掉，所以 .admin_prof 一直残留着。 */
    await killBrowserAndClean(b, PROFILE, ws);
    await resetZhangSan();   /* 兜底复位，避免中途失败留下封禁状态 */
  }
})();
