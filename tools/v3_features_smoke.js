/**
 * V3「7 项待补功能」端到端冒烟（CDP 无头 Edge）—— 纯 HTTP + 浏览器，不直连数据库。
 *
 * 覆盖（对应 待补前端页面清单.md 的 7 项）：
 *   ① 编辑帖子   /post/:id 作者可见「编辑」→ /publish?id= 预填（标题/按钮文案/分类选择器）
 *   ② 删除帖子   /post/:id 作者可见「删除」→ 二次确认后 DELETE，帖子真的没了
 *   ③ 删除评论   自己的评论有「删除」→ 删除后列表少一条
 *   ④ 读取乐谱附件  谱面区从 GET /api/files/{id} 真渲染 + 「下载乐谱 JSON」按钮
 *                （顺带验证：**匿名看不到**，只给「登录后可查看」的提示 —— 2026-10-03 鉴权收紧后的预期）
 *   ⑤ 单条已读   点未读通知 → 未读数-1
 *   ⑥ 分类字典   /publish 的曲谱分类四组渲染 + 可选中
 *   ⑦ 令牌续期   用**伪造令牌**验证安全路径：不会无限重试，而是清会话跳登录
 *
 * 自清理：本脚本"先建一条测试帖 → 全程用它 → 最后删掉它"，净变化为零；
 *        评论也随手删掉。（会留下 admin 的一条 like 记录，不影响功能。）
 * 前置：后端 8080 + 前端 dev server **5174**（`cd web-vue && npm run dev`）。
 *       ⚠️ 2026-10-10 主线已切到 `web-vue/`（Vue 3 SPA），URL 由 `post.html?id=` 一类改为 `/post/:id`。
 * 用法：node tools/v3_features_smoke.js
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { SHARED_PROFILE, prepareProfile, killBrowserAndClean } = require('./browser_profile');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9387;
const BASE = process.env.KAL_WEB || 'http://127.0.0.1:5174';
const API = process.env.KAL_API || 'http://localhost:8080';
/* 固定 profile 名（原来是 .v3f_prof_<Date.now()>，每跑一次多留一个目录 —— 曾堆到 13 个 / 1.1 GB）。
   固定名 + 启动前清扫 = 无论怎么中断，最多只残留一个，且下次运行会被扫掉。 */
const PROFILE = SHARED_PROFILE;

/* 浏览器进程与 CDP 连接提到模块作用域，供 exit 钩子清理。
   ⚠️ 清理**不能只写在 finally 里**：本脚本与 pwa_smoke 都在 try 内直接 process.exit()，
   而 Node 的 process.exit() 会在 finally 之前终止进程（文档明确说明），
   于是 finally 的清理永远不执行 —— 这正是原先 %TEMP% / tools/ 残留越积越多的原因。 */
let browser = null;
let cdpWs = null;
process.on('exit', () => {
  try { cdpWs && cdpWs.close(); } catch (_) {}
  try { browser && browser.kill(); } catch (_) {}
  /* 同步尽力删一次；删不掉也没关系 —— 下次 prepareProfile() 会扫掉，不会持续堆积。 */
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (_) {}
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, seq = 0; const pending = new Map();
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
/** 失败现场：等待超时时把 console / 异常 / 请求流水一起打出来，否则只剩一句「等待超时」。 */
const diag = { logs: [], reqs: [], failed: [] };
function assert(label, cond, extra = '') {
  const pass = !!cond;
  results.push(pass);
  console.log(`${pass ? '✓' : '✗'} ${label}${extra ? '  [' + extra + ']' : ''}`);
}
/* ⚠️ 超时给到 25s（不是 12s）：本机 sandbox 里 `fonts.gstatic.com` 的 woff2 **一直挂着**
   （见「缺口与待办」F12），外加无头 Edge 冷启动 —— 最敏感的恰恰是**第一次导航**，
   实测出现过一次「匿名详情渲染完成」超时而 4 次复跑全过（纯冷启动抖动）。
   放宽只容忍「慢」，不会放过「真不出来」：断言仍然照常判。 */
async function waitFor(fn, desc, timeout = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await fn()) return true; await sleep(300); }
  throw new Error('等待超时: ' + desc);
}
/**
 * 整页导航。
 *
 * ⚠️ 不能假设「赋值 location.href ⇒ 导航一定发生」。本机 sandbox 里第三方字体（Google Fonts）
 * 的请求会**一直挂着**（见「缺口与待办」F12），此时用 CDP 触发的整页导航会**偶发被静默吞掉**：
 * 地址栏停在原页、**无失败请求**、连新页面的 console 都不出现，25s 也等不到。
 * 2026-10-04 实测：不屏蔽字体时 8 次里挂 4 次；屏蔽字体后 8 次 0 挂 ⇒ 环境问题，不是业务逻辑。
 *
 * 所以这里显式确认「新文档真的起来了」（用一次性 token 判断：新文档不会有它），
 * 没起来就重试，并**大声打出来** —— 否则会变成一个时红时绿、没人敢信的门禁。
 * 另：`KAL_BLOCK_FONTS=1` 可直接屏蔽字体请求来隔离这个变量。
 */
async function go(url, readyExpr, desc) {
  /* 绝对化：允许传相对路径。不解析的话下面 `location.href === url` 永远为假，
     会被误判成「导航被吞」而空转 3 轮。 */
  const target = await ev(`new URL(${JSON.stringify(url)}, location.href).href`);
  const token = 'nav' + Date.now() + '_' + Math.random().toString(36).slice(2);
  for (let attempt = 1; attempt <= 3; attempt++) {
    /* 在当前文档打个记号再跳；能读到记号 = 还是老文档 = 导航没发生 */
    await ev(`(() => { window.__navToken = ${JSON.stringify(token)}; location.href = ${JSON.stringify(target)}; return true; })()`);
    const arrived = `location.href === ${JSON.stringify(target)} && window.__navToken !== ${JSON.stringify(token)}`;
    let landed = false;
    for (let i = 0; i < 40; i++) {                 // 最多 12s 等它落地
      if (await ev(arrived)) { landed = true; break; }
      await sleep(300);
    }
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

/* ---------- 直接走 HTTP 的后端辅助（用于造数据与断言副作用） ---------- */
async function api(method, p, body, token) {
  const headers = {};
  if (token) headers['sa-token'] = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(API + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  try { return JSON.parse(text); } catch (e) { return { code: res.status, message: text.slice(0, 120) }; }
}
/**
 * 「点一个会二次确认的按钮」——**同时兼容两种确认实现**。
 *
 * · V3 多页静态版的删除走原生 `window.confirm`，无头环境会吞掉弹框，覆盖成 `() => true` 即可放行；
 * · SPA 版（Vue）走 Element Plus 的 `ElMessageBox.confirm`，那是个**真实 DOM 模态框**，
 *   覆盖 window.confirm 完全无效 —— 必须等它出现后点它的「确定」按钮。
 *
 * 两种都写着：哪条路径先满足就走哪条，互不干扰（原生 confirm 被覆盖后不会弹模态框）。
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
async function loginAs(username, password) {
  const r = await api('POST', '/api/auth/login', { username, password });
  return r.code === 0 ? r.data : null;
}

(async () => {
  /* ================= 准备：造一条带乐谱附件的测试帖 + 一条评论 ================= */
  const demo = await loginAs('demo', '123456');
  if (!demo) { console.error('✗ demo 登录失败，无法继续'); process.exit(1); }
  const tok = demo.token;

  const scoreId = Number(process.env.KAL_SCORE_ID || 1);
  const title = '功能冒烟测试帖 ' + Date.now();
  const created = await api('POST', '/api/posts', {
    title, content: '这条帖子由 v3_features_smoke.js 创建，跑完会自动删除。',
    tagIds: [], scoreFileId: scoreId
  }, tok);
  const pid = created.code === 0 ? String(created.data.id) : '';
  if (!pid) { console.error('✗ 造测试帖失败：', created.message); process.exit(1); }
  console.log(`  （测试帖 #${pid}，挂乐谱附件 #${scoreId}）`);

  const cmt = await api('POST', `/api/posts/${pid}/comments`, { content: '冒烟用评论', parentId: null }, tok);
  assert('准备：给测试帖加一条自己的评论', cmt.code === 0, 'code=' + cmt.code);

  /* ⑤ 要验「点未读通知 → 未读数 -1」，就得有一条**新的**未读通知。
     ⚠️ 不能指望库里存量：历史运行会把最新的通知逐条读掉，而 API 只翻第一页，
        于是「库里 39 条未读、最新 50 条却全已读」→ 页面一个红点都没有，断言必假失败
        （2026-10-04 实测踩到）。所以这里**自己造一条**：admin 给 demo 的测试帖点赞
        → 后端 notify() 会给 demo 生成一条 like 通知。 */
  const admin = await loginAs('admin', '123456');
  if (admin) {
    const lk = await api('POST', `/api/posts/${pid}/likes`, undefined, admin.token);
    console.log(`  （admin 点赞测试帖，制造未读通知：code=${lk.code}）`);
  } else {
    console.warn('  ⚠ admin 登录失败 → ⑤ 的「未读通知」前置不成立');
  }

  /* 起浏览器之前先扫掉历史残留（含旧的 .v3f_prof_* 时间戳目录）。只清扫不创建，
     目录交给 Edge 自己建 —— 否则上面那两处失败退出会留下一个空目录。 */
  prepareProfile();
  const b = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--window-size=1440,900', '--user-data-dir=' + PROFILE,
    BASE + '/'], { stdio: ['ignore', 'ignore', 'ignore'] });
  browser = b;

  try {
    const u = await connect();
    ws = new WebSocket(u);
    cdpWs = ws;
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      /* 留一份「现场」：等待超时时若只有一句「等待超时」是没法排查的
         （2026-10-03 就在这条上耗了 4 轮复跑），所以把 console/异常/失败请求留到最后一起打。 */
      if (m.method === 'Runtime.consoleAPICalled') {
        diag.logs.push('[log] ' + m.params.args.map((a) => a.value || a.description || '').join(' ').slice(0, 160));
      }
      if (m.method === 'Runtime.exceptionThrown') {
        diag.logs.push('[EXC] ' + String(((m.params.exceptionDetails.exception || {}).description)
          || m.params.exceptionDetails.text || '').split('\n')[0].slice(0, 220));
      }
      if (m.method === 'Network.responseReceived') diag.reqs.push(m.params.response.url.replace('http://localhost', ':'));
      if (m.method === 'Network.loadingFailed') diag.failed.push(m.params.errorText);
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    };
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
    /* 诊断开关：本机 sandbox 里第三方字体（Google Fonts）请求会一直挂着，见缺口 F12。
       设 KAL_BLOCK_FONTS=1 可直接屏蔽它们，用来隔离「是不是字体拖累」这一个变量。 */
    if (process.env.KAL_BLOCK_FONTS) {
      await send('Network.setBlockedURLs', {
        urls: ['*fonts.googleapis.com*', '*fonts.gstatic.com*', '*fonts.gstatic.font.im*', '*fonts.gstatic*']
      });
    }
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    const setAuth = (sess) => ev(`(() => { localStorage.setItem('kc_auth', ${JSON.stringify(JSON.stringify(sess))}); return true; })()`);
    const sessOf = (d) => ({ accessToken: d.token, refreshToken: d.token,
      user: { id: String(d.userId), username: d.username, nickname: d.nickname, avatar: d.avatar || '', role: d.role } });

    await waitFor(() => ev(`!!document.body`), '首屏');

    /* ================= ④-a 匿名视角：看不到作者操作，也看不到乐谱 ================= */
    await ev(`(() => { localStorage.removeItem('kc_auth'); return true; })()`);
    /* ⚠️ 就绪条件必须等 `.d-actions`（详情渲染完才有）；早先等 `.empty-tip` 会命中
       「正在打开谱帖…」这个加载占位符 → 断言在渲染前跑，会得到**假通过/假失败**。 */
    await go(`${BASE}/post/${pid}`, `!!document.querySelector('.d-actions')`, '匿名详情渲染完成');
    const anon = await ev(`(() => ({
      ownerBtns: document.querySelectorAll('#owner-bar button').length,
      scorePaper: document.querySelectorAll('.score-paper').length,
      lockTitle: (document.querySelector('#detail .score-lock .lk-t') || {}).textContent || '',
      lockLogin: !!document.querySelector('#detail .score-lock .lk-a a[href*="/login"]')
    }))()`);
    assert('④ 匿名看不到「编辑/删除」（作者操作栏为空）', anon.ownerBtns === 0, '按钮数=' + anon.ownerBtns);
    assert('④ 匿名看不到乐谱（附件接口需登录）', anon.scorePaper === 0, '谱面区=' + anon.scorePaper);
    /* 2026-10-03 起锁定态从「一句 .empty-tip」升级为带 标题/说明/动作 的 .score-lock 卡片
       （要同时表达「缺什么条件 / 为什么 / 怎么解锁」，一句空态文案撑不住）。 */
    assert('④ 匿名给出「登录后可查看」的锁定卡片，而不是空白',
      anon.lockTitle.indexOf('登录') >= 0, anon.lockTitle.trim().slice(0, 24));
    assert('④ 锁定卡片给了可直接点的登录入口', anon.lockLogin === true);

    /* ================= 作者视角 ================= */
    await setAuth(sessOf(demo));
    await go(`${BASE}/post/${pid}`, `!!document.querySelector('#edit-btn')`, '作者视角详情加载');
    const owner = await ev(`(() => ({
      edit: !!document.getElementById('edit-btn'),
      del: !!document.getElementById('del-btn'),
      scorePaper: document.querySelectorAll('.score-paper').length,
      noteCells: document.querySelectorAll('.score-paper .note-cell .n').length,
      dl: !!document.getElementById('score-dl'),
      cmtDel: document.querySelectorAll('.cmt-del').length
    }))()`);
    assert('① 作者可见「编辑」按钮', owner.edit === true);
    assert('② 作者可见「删除」按钮', owner.del === true);
    assert('④ 谱面区从真实附件渲染出来了', owner.scorePaper === 1 && owner.noteCells > 0,
      `谱面区=${owner.scorePaper} 音符格=${owner.noteCells}`);
    assert('④ 有「下载乐谱 JSON」按钮', owner.dl === true);
    assert('③ 自己的评论带「删除」按钮', owner.cmtDel >= 1, '删除按钮=' + owner.cmtDel);

    /* ================= ③ 删除评论 ================= */
    const beforeCmt = await ev(`document.querySelectorAll('.cmt-item').length`);
    await clickAndConfirm(`(() => { document.querySelector('.cmt-del').click(); return true; })()`);
    await waitFor(async () => (await ev(`document.querySelectorAll('.cmt-item').length`)) < beforeCmt, '评论被移除');
    assert('③ 点「删除」后评论从列表消失', true, `${beforeCmt} → ${await ev(`document.querySelectorAll('.cmt-item').length`)}`);

    /* ================= ① 编辑态：/publish/:id ================= */
    await go(`${BASE}/publish/${pid}`, `!!document.getElementById('cat-pick')`, '编辑态发布页加载');
    await sleep(900);
    const edit = await ev(`(() => ({
      head: (document.querySelector('.backline .bt') || {}).textContent || '',
      btn: (document.getElementById('pub-btn') || {}).textContent || '',
      title: (document.getElementById('pub-title') || {}).value || '',
      catGroups: document.querySelectorAll('#cat-pick .field-inline').length,
      catChips: document.querySelectorAll('#cat-pick .chip').length,
      catPrefilled: document.querySelectorAll('#cat-pick .chip.on').length,
      visChips: document.querySelectorAll('#vis-pick .chip').length,
      visOn: (document.querySelector('#vis-pick .chip.on') || {}).dataset ? document.querySelector('#vis-pick .chip.on').dataset.v : '',
      visTip: (document.getElementById('vis-tip') || {}).textContent || ''
    }))()`);
    assert('① 标题变为「编辑谱帖」', edit.head.indexOf('编辑') >= 0, edit.head);
    assert('① 主按钮变为「保存修改」', edit.btn.indexOf('保存') >= 0, edit.btn);
    assert('① 标题已预填（GET /api/posts/{id}）', edit.title.indexOf('功能冒烟测试帖') >= 0, edit.title.slice(0, 24));
    assert('⑥ 曲谱分类渲染出 4 组（琴型/调性/难度/曲风）', edit.catGroups === 4, '组数=' + edit.catGroups);
    assert('⑥ 分类选项 chip 已注入', edit.catChips > 10, '选项数=' + edit.catChips);
    /* ★ 下载分级（2026-10-03）：编辑态必须回显附件当前的档位，否则一保存就会把权限改掉 */
    assert('★ 下载权限选择器有 4 档（登录/收藏/关注/仅自己）', edit.visChips === 4, '档数=' + edit.visChips);
    assert('★ 编辑态回显了附件当前档位（GET /api/files/{id}/meta）', edit.visOn === 'login',
      '选中=' + edit.visOn);
    assert('★ 选中档位后给了文字说明', edit.visTip.length > 4, edit.visTip.slice(0, 20));

    /* ⚠️ 点完**必须等一拍**再读 DOM：V3 是命令式改 DOM（同步生效），
       而 SPA 版（Vue）的渲染是**异步**的（nextTick）—— 点击后立刻读，拿到的还是旧状态，
       会得到「onCount=0」这种看着像功能坏了的假失败。 */
    await ev(`(() => {
      const box = document.querySelector('#cat-pick .tag-pick');
      const c = box.querySelectorAll('.chip')[1] || box.querySelector('.chip');
      c.click();
      box.__probeClicked = c;          // 记住点了哪个节点，等渲染完再比对
      return true;
    })()`);
    await sleep(500);
    const pickOk = await ev(`(() => {
      const box = document.querySelector('#cat-pick .tag-pick');
      const c = box.__probeClicked;
      const onInBox = box.querySelectorAll('.chip.on');
      /* 「单选」的真实契约是**组内唯一**，不是「整页只有一个 on」——
         编辑态会从 files.meta 回显原有分类，所以 #cat-pick 里本来就可能每组各有一个 on。
         2026-10-03 加了回显后，这条断言按组断言（此前按整页断言，属于把巧合当契约）。 */
      return onInBox.length === 1 && onInBox[0] === c;
    })()`);
    assert('⑥ 分类可选中（组内单选：点了新的，同组旧的自动取消）', pickOk === true);

    /* ================= ② 删除帖子（顺带自清理） ================= */
    await go(`${BASE}/post/${pid}`, `!!document.getElementById('del-btn')`, '回到详情准备删除');
    await clickAndConfirm(`(() => { document.getElementById('del-btn').click(); return true; })()`);
    await sleep(1800);
    const gone = await api('GET', '/api/posts/' + pid);
    assert('② 点「删除」后帖子真的没了（GET 返回业务错误）', gone.code !== 0, 'code=' + gone.code);

    /* ================= ⑤ 单条已读 ================= */
    const unreadBefore = (await api('GET', '/api/notifications/unread', undefined, tok)).data;
    const n0 = typeof unreadBefore === 'number' ? unreadBefore : (unreadBefore && unreadBefore.count);
    await go(`${BASE}/notifications`, `document.querySelectorAll('.noti-item').length > 0`, '消息页加载');
    const noti = await ev(`(() => ({
      unread: document.querySelectorAll('.noti-item.unread').length,
      dots: document.querySelectorAll('.noti-item .dot').length,
      firstLine: (document.querySelector('.noti-item .line1') || {}).textContent || ''
    }))()`);
    assert('⑤ 消息页能渲染真实通知（不再因缺 sender 报错）', noti.unread > 0,
      `未读 ${noti.unread} 条，样例「${noti.firstLine.trim().slice(0, 20)}」`);
    assert('⑤ 未读条目带红点', noti.dots === noti.unread, `dot=${noti.dots} unread=${noti.unread}`);
    await ev(`(() => { document.querySelector('.noti-item.unread').click(); return true; })()`);
    await sleep(1500);
    const unreadAfter = (await api('GET', '/api/notifications/unread', undefined, tok)).data;
    const n1 = typeof unreadAfter === 'number' ? unreadAfter : (unreadAfter && unreadAfter.count);
    assert('⑤ 点击未读通知后未读数 -1（PUT /api/notifications/{id}/read 生效）', n1 === n0 - 1, `${n0} → ${n1}`);

    /* ================= ⑦ 令牌续期：安全路径 ================= */
    await go(`${BASE}/`, `!!document.body`, '回首页');
    await ev(`(() => { localStorage.setItem('kc_auth', JSON.stringify({ accessToken: 'bogus-token-xyz', refreshToken: 'bogus', user: { id: '2', nickname: 'x', role: 'user' } })); return true; })()`);
    await go(`${BASE}/notifications`, `!!document.body`, '用伪造令牌进消息页');
    await sleep(2500);
    const after = await ev(`(() => ({ url: location.pathname, auth: localStorage.getItem('kc_auth') }))()`);
    assert('⑦ 伪造令牌不会死循环，而是清会话并跳登录页',
      after.url.indexOf('login') >= 0, '当前路径=' + after.url);

    const errs = results.filter((x) => x === false).length;
    console.log('\n' + (errs === 0 ? '★ V3 七项功能冒烟全部通过 (' + results.length + ')' : '✗ 有失败项 (' + (results.length - errs) + '/' + results.length + ')'));
    process.exitCode = errs === 0 ? 0 : 1;
  } catch (e) {
    console.error('ERR', e.message);
    /* ---- 失败现场快照：别只留一句「等待超时」 ---- */
    try {
      const st = await ev(`(() => ({
        href: location.href, ready: document.readyState,
        actions: document.querySelectorAll('.d-actions').length,
        busy: document.querySelectorAll('.empty-tip').length,
        detailHead: ((document.getElementById('detail') || {}).innerHTML || '').slice(0, 120),
        sw: !!navigator.serviceWorker && !!navigator.serviceWorker.controller
      }))()`);
      console.error('  现场：href=' + (st && st.href) + ' ready=' + (st && st.ready)
        + ' .d-actions=' + (st && st.actions) + ' SW受控=' + (st && st.sw));
      console.error('  #detail=' + (st && st.detailHead));
    } catch (_) {}
    console.error('  日志：' + (diag.logs.length ? diag.logs.slice(-8).join('\n         ') : '（无）'));
    console.error('  请求末尾：' + diag.reqs.slice(-14).join('  '));
    console.error('  失败请求：' + (diag.failed.length ? diag.failed.join(' | ') : '（无）'));
    process.exitCode = 2;
  } finally {
    /* 先关 CDP、再 kill、**等进程真的退出**（Windows 上句柄要几百毫秒才释放），
       然后带重试地删 profile；失败会打印出来而不是被 catch 吞掉。 */
    await killBrowserAndClean(b, PROFILE, ws);
    /* 兜底清理：万一中途失败没走到「删除帖子」，这里补一刀。
       先取消 admin 的点赞再删帖，免得 like_record 留一条指向已删帖子的记录。 */
    try { if (admin) await api('DELETE', `/api/posts/${pid}/likes`, undefined, admin.token); } catch (_) {}
    try { await api('DELETE', '/api/posts/' + pid, undefined, tok); } catch (_) {}
  }
})();
