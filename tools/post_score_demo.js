/**
 * 帖子页「内嵌内核预览」真机演示（CDP 无头 Edge）—— 纯 HTTP，不直连数据库。
 *
 * <h3>做什么</h3>
 * 走完整链路，而不是看代码猜：
 *   ① 登录 → POST /api/files/score 上传一份**内核导出 JSON**（读 format/version 回显）
 *   ② POST /api/posts 建一篇带 scoreFileId 的帖子
 *   ③ 真浏览器打开 `http://127.0.0.1:5174/post/{id}`（注入登录态），量几何 + 点播放 + 拖进度条
 *   ④ 出 3 张截图（首屏 / 播放中 / 拖动跳转）
 *
 * <h3>为什么必须真浏览器</h3>
 * 谱面是 <ScorePreview> 里那个 iframe（承载内核单文件 composer.html）**本尊**在渲染 ——
 * svg 尺寸、右侧留白、竖向进度条贴边、播放按钮镜像文案，全都只有真实布局才量得出来。
 *
 * <h3>环境（照 local-webapp-cdp-test 的坑办）</h3>
 *   · 端口 9382 —— 与 admin_ui_smoke(9381) 等**错开**；同端口会让后来者连上先起的 target。
 *   · profile 用项目共用的 `.smoke_prof`（prepareProfile 启动前扫掉残留），不各写各的。
 *   · 截图一律 `captureBeyondViewport:false`：带 clip 时它的默认 true 会临时改视口，
 *     页面里跟着视口高的元素会跳位，图与断言对不上。
 *   · 无头环境**没有音频设备** → AudioContext 恒 suspended、音频时钟不走，
 *     所以「点播放后进度自己往前走」在这台机器上测不了（环境假象，非 bug）。
 *     进度机制改由**真实鼠标拖动**验证（拖动直接写 playPos，与音频时钟无关）。
 *
 * 用法：
 *   node tools/post_score_demo.js "<乐谱 json 路径>" ["帖子标题"]
 *   KAL_FILE_ID=35 KAL_POST_ID=236 node tools/post_score_demo.js "<乐谱 json 路径>"   # 复用已有附件/帖子，只跑真机
 *   KAL_ANON=1 KAL_FILE_ID=35 KAL_POST_ID=236 node tools/post_score_demo.js "<乐谱 json 路径>"  # 匿名态
 * 前置：后端 8080 + 前端 dev 5174 都在跑。
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { SHARED_PROFILE, prepareProfile, killBrowserAndClean } = require('./browser_profile');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9382;
/* 匿名模式：不注入登录态，验证「匿名也能看谱、能试听，但下载要登录」。 */
const ANON = !!process.env.KAL_ANON;
const WEB = process.env.KAL_WEB || 'http://127.0.0.1:5174';
const API = process.env.KAL_API || 'http://localhost:8080';
const PROFILE = SHARED_PROFILE;
const SHOT_DIR = process.env.KAL_SHOT_DIR || path.join(__dirname, 'demo_out');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 断言 ---------- */
const results = [];
function ok(label, cond, extra = '') {
  const pass = !!cond;
  results.push(pass);
  console.log(`${pass ? '✓' : '✗'} ${label}${extra ? '  [' + extra + ']' : ''}`);
  return pass;
}

/* ---------- HTTP 小工具 ---------- */
async function api(method, p, body, token) {
  const headers = {};
  if (token) headers['sa-token'] = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(API + p, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch (e) { return { code: res.status, message: text.slice(0, 200), data: null }; }
}

/* ---------- CDP ---------- */
let ws = null, seq = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) {
    return { __exc: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
  }
  return r.result ? r.result.value : undefined;
}
async function connect() {
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    try {
      const list = await new Promise((res, rej) => {
        http.get({ host: '127.0.0.1', port: PORT, path: '/json/list' },
          (r) => { let s = ''; r.on('data', (c) => s += c); r.on('end', () => res(JSON.parse(s))); }).on('error', rej);
      });
      const p = list.find((t) => t.type === 'page');
      if (p) return p.webSocketDebuggerUrl;
    } catch (_) { /* 还没起来 */ }
  }
  throw new Error('CDP target 未出现（端口 ' + PORT + '）');
}
async function waitFor(fn, desc, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await fn()) return true; await sleep(300); }
  throw new Error('等待超时：' + desc);
}
/** 整页导航（带落地确认，避免「赋值 href 就当跳成功」被静默吞掉） */
async function go(url) {
  const target = await ev(`new URL(${JSON.stringify(url)}, location.href).href`);
  const tk = 'nav' + Date.now() + Math.random().toString(36).slice(2);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await ev(`(function(){ window.__nav = ${JSON.stringify(tk)}; location.href = ${JSON.stringify(target)}; return true; })()`);
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const landed = await ev(`location.href === ${JSON.stringify(target)} && window.__nav !== ${JSON.stringify(tk)}`);
      if (landed === true) return true;
    }
    console.log(`  ⚠️ 导航未落地（第 ${attempt} 次）：${url}`);
  }
  throw new Error('导航失败：' + url);
}
/** 真实鼠标点击（合成 .click() 绕过命中测试，测不出「点在了哪个元素上」） */
async function realClick(selector) {
  const p = await ev(`(function(){
    var el = document.querySelector(${JSON.stringify(selector)});
    if(!el) return { err: 'no el' };
    el.scrollIntoView({ block: 'center' });
    var r = el.getBoundingClientRect();
    var x = Math.round(r.left + r.width/2), y = Math.round(r.top + r.height/2);
    var t = document.elementFromPoint(x, y);
    if(!t || (!el.contains(t) && t !== el)) return { err: 'hit ' + (t ? t.tagName : 'null') + ' @' + x + ',' + y };
    return { x:x, y:y, hit:String(t.tagName || '').toLowerCase() };
  })()`);
  if (p && p.err) throw new Error('真实点击定位失败：' + p.err);
  const base = { x: p.x, y: p.y, button: 'left', clickCount: 1 };
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', Object.assign({ type }, base));
  }
  return p;
}
async function shot(file) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(SHOT_DIR, file), Buffer.from(r.data, 'base64'));
  console.log('  📷 ' + file);
}

/* ================================================================
   ① 上传 + 建帖
   ================================================================ */
async function seed(jsonPath, titleOverride) {
  const bytes = fs.readFileSync(jsonPath);
  const raw = JSON.parse(bytes.toString('utf8'));

  const login = await api('POST', '/api/auth/login', { username: 'demo', password: '123456' });
  if (login.code !== 0) throw new Error('登录失败：' + login.message);
  const token = login.data.token;
  const me = login.data;
  console.log(`登录 demo 成功（userId=${me.userId}）`);

  /* 复用上次已上传的附件与帖子（重跑「真机」这一步时不必再落一份脏数据）。
     设了 KAL_FILE_ID + KAL_POST_ID 就跳过上传/建帖。 */
  if (process.env.KAL_FILE_ID && process.env.KAL_POST_ID) {
    const fid = Number(process.env.KAL_FILE_ID), pid = Number(process.env.KAL_POST_ID);
    const meta = await api('GET', `/api/files/${fid}/meta`, undefined, token);
    if (meta.code !== 0) throw new Error(`复用失败：附件 ${fid} 不可读（${meta.message}）`);
    console.log(`复用已有附件 fileId=${fid}  postId=${pid}  ` +
      `format=${meta.data.format}  version=${meta.data.version}  fileName=${meta.data.fileName}`);
    return { pid, fid, token, me, raw };
  }

  /* 上传：文件名用原始名，验证非 ASCII（日文）文件名能不能过 */
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: 'application/json' }), path.basename(jsonPath));
  const upRes = await fetch(API + '/api/files/score', { method: 'POST', headers: { 'sa-token': token }, body: fd });
  const up = await upRes.json();
  if (up.code !== 0) throw new Error('上传乐谱失败：' + up.message);
  const fid = up.data.id;
  console.log(`上传成功 fileId=${fid}  format=${up.data.format}  version=${up.data.version}  fileName=${up.data.fileName}`);
  ok('上传回显 format = kalimba-tab（内核导出格式）', up.data.format === 'kalimba-tab', 'format=' + up.data.format);
  ok('上传回显 version = 1（JSON 里是无引号数字）', up.data.version === '1', 'version=' + up.data.version);

  const tags = await api('GET', '/api/tags');
  const tag = (tags.data || []).find((t) => t.name === '曲谱分享') || (tags.data || [])[0];
  const title = titleOverride || raw.title || '未命名曲谱';
  const content = [
    '<p>用制谱内核导出的 JSON 直接发的谱帖 —— 帖子页里嵌的就是内核本尊。</p>',
    `<p>琴型 ${raw.tuning && raw.tuning.key}｜调性 ${raw.key && raw.key.name}｜速度 ${raw.tempo} BPM｜` +
      `${raw.nMeasures} 小节 / ${raw.totalBeats} 拍</p>`,
  ].join('');
  const post = await api('POST', '/api/posts', {
    title, content, cover: '', tagIds: tag ? [tag.id] : [], scoreFileId: fid,
  }, token);
  if (post.code !== 0) throw new Error('建帖失败：' + post.message);
  const pid = post.data.id;
  console.log(`建帖成功 postId=${pid}（标题「${title}」）`);

  return { pid, fid, token, me, raw };
}

/* ================================================================
   ② 真机打开 + 量 + 交互
   ================================================================ */
async function demo(ctx) {
  prepareProfile(PROFILE);
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--window-size=1280,1500', '--force-device-scale-factor=1',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE, 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  try {
    const url = await connect();
    ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    /* ⚠️ 没有这个 onmessage，send() 的 Promise 永远不 resolve —— 会静默卡死在第一条
       await send(...) 上（连接 ESTABLISHED、却毫无反应）。照 admin_ui_smoke 的写法。 */
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
      }
    };
    await send('Page.enable');
    await send('Runtime.enable');

    /* 先落到同源页面，注入登录态，再整页跳 —— SPA 的 store 在启动时读 localStorage，
       必须在文档加载前写好，否则首帧仍是匿名态（会先渲染成锁定提示）。 */
    await go(WEB + '/');
    if (ANON) {
      /* 匿名态：**主动清掉**注入点 —— 否则会沿用上一次跑残留的登录态，测出来的不是匿名 */
      await ev(`localStorage.removeItem('kc_auth'); true`);
    } else {
      await ev(`(function(){
        localStorage.setItem('kc_auth', JSON.stringify({
          accessToken: ${JSON.stringify(ctx.token)},
          refreshToken: ${JSON.stringify(ctx.token)},
          user: { id: String(${JSON.stringify(String(ctx.me.userId))}), username: ${JSON.stringify(ctx.me.username)},
                  nickname: ${JSON.stringify(ctx.me.nickname)}, avatar: ${JSON.stringify(ctx.me.avatar || '')},
                  role: ${JSON.stringify(ctx.me.role)} }
        }));
        return true;
      })()`);
    }

    await go(`${WEB}/post/${ctx.pid}`);
    await waitFor(async () => await ev(`!!document.querySelector('.sp-card iframe')`), '谱面卡出现');
    /* 内核在 iframe 里二次就绪（#src 存在 → 才是内核本尊） */
    await waitFor(async () => await ev(
      `(function(){ var f = document.querySelector('.sp-card iframe'); return !!(f && f.contentDocument && f.contentDocument.getElementById('src')); })()`
    ), '内核 iframe 就绪');
    /* svg 出来 = 谱面真的画完了（不是只有外壳） */
    await waitFor(async () => await ev(
      `(function(){ var f = document.querySelector('.sp-card iframe'); var h = f && f.contentDocument.getElementById('svgHost'); return !!(h && h.querySelector('svg')); })()`
    ), '内核画出 svg');

    const M = await ev(`(function(){
      var f = document.querySelector('.sp-card iframe');
      var d = f.contentDocument;
      var sp = document.querySelector('.sp'), card = document.querySelector('.sp-card'), bar = document.querySelector('.sp-bar');
      var host = d.getElementById('svgHost'), svg = host.querySelector('svg');
      var pb = d.getElementById('progBar'), top = d.querySelector('.top');
      var trk = pb && pb.querySelector('.trk');
      var fr = f.getBoundingClientRect(), tr = trk ? trk.getBoundingClientRect() : null;
      return {
        title: document.title,
        pTitle: (document.querySelector('.p-title') || {}).textContent,
        pSub: (document.querySelector('.p-sub') || {}).textContent,
        btn: (document.querySelector('.sp-play') || {}).textContent,
        cardW: card ? card.getBoundingClientRect().width : null,
        spW: sp ? sp.getBoundingClientRect().width : null,
        barW: bar ? bar.getBoundingClientRect().width : null,
        barBottom: bar ? bar.getBoundingClientRect().bottom : null,
        cardTop: card ? card.getBoundingClientRect().top : null,
        hostW: host.style.width, hostOverflow: getComputedStyle(host).overflow,
        svgW: svg.getAttribute('width'), svgH: svg.getAttribute('height'),
        topDisplay: top ? getComputedStyle(top).display : null,
        progDisplay: pb ? getComputedStyle(pb).display : null,
        progClass: pb ? pb.className : null,
        progW: pb ? pb.getBoundingClientRect().width : null,
        progRight: pb ? getComputedStyle(pb).right : null,
        warnText: (d.querySelector('.warnbox') || {}).textContent || '',
        noteCount: d.querySelectorAll('#svgHost svg text').length,
        /* 诊断：组件是否真的接管了内核（EMBED_CSS 注入 / 顶栏标题被改 / 源文已灌入）。
           这三项能一眼区分「apply() 没跑」与「跑了但渲染不对」。 */
        embed: !!d.querySelector('style[data-kal-embed]'),
        iframeTitle: d.title,
        srcLen: (function(){ var s = d.getElementById('src'); return s ? String(s.value||'').length : -1; })(),
        hasBtnParse: !!d.getElementById('btnParse'),
        audioState: (function(){ try { return new (f.contentWindow.AudioContext || f.contentWindow.webkitAudioContext)().state; } catch(e){ return 'n/a'; } })(),
        trk: tr ? { left: Math.round(fr.left + tr.left), top: Math.round(fr.top + tr.top),
                    width: Math.round(tr.width), height: Math.round(tr.height) } : null
      };
    })()`);

    if (M && M.__exc) throw new Error('量取失败：' + M.__exc);

    ok('帖子标题正确渲染', String(M.title).indexOf(ctx.raw.title) >= 0, 'title=' + M.title);
    ok('谱面标题取内核 title', String(M.pTitle || '').indexOf(ctx.raw.title) >= 0, 'p-title=' + M.pTitle);
    ok('副标题按内核元信息拼（琴型/调性/BPM）',
      M.pSub && M.pSub.indexOf(String(ctx.raw.tuning.key).replace('k', '')) >= 0 && M.pSub.indexOf('BPM') >= 0,
      'p-sub=' + M.pSub);
    ok('内核已画出谱面 svg', M.svgW && M.svgH, `svg=${M.svgW}×${M.svgH}，文字节点 ${M.noteCount} 个`);
    ok('内核顶栏已隐藏（播放按钮挪到卡外）', M.topDisplay === 'none', 'display=' + M.topDisplay);

    /* 几何：卡片宽 = （svg 实宽 − 右侧简谱对照带 108） + 左轨 62 */
    const expectCard = Number(M.svgW) - 108 + 62;
    ok(`卡片宽 = svg 实宽 − 108 + 62 = ${expectCard}`, Math.abs(M.cardW - expectCard) < 1.5,
      `实际 ${M.cardW}`);
    ok('预览区宽 = svg 实宽 − 108（右侧对照带被裁）', Math.abs(parseFloat(M.hostW) - (Number(M.svgW) - 108)) < 1,
      `#svgHost width=${M.hostW} / overflow=${M.hostOverflow}`);
    ok('播放条与卡片同宽', Math.abs(M.barW - M.cardW) < 1.5, `bar=${M.barW} / card=${M.cardW}`);
    ok('播放按钮在卡片**外面**（条底 ≤ 卡顶）', M.barBottom <= M.cardTop + 0.5,
      `bar.bottom=${M.barBottom} / card.top=${M.cardTop}`);
    ok('竖向进度条已接上（display:block + .on）',
      M.progDisplay === 'block' && String(M.progClass).indexOf('on') >= 0,
      `display=${M.progDisplay} class="${M.progClass}"`);
    ok('进度条落在右侧留白里（宽 10、right=5px）',
      Math.abs(M.progW - 10) < 0.6 && parseFloat(M.progRight) === 5,
      `width=${M.progW} right=${M.progRight}`);

    if (M.warnText && M.warnText.trim()) console.log('  ℹ️ 内核超域提示：' + M.warnText.trim());
    console.log(`  ℹ️ 组件接管诊断：embed=${M.embed} iframeTitle="${M.iframeTitle}" ` +
      `srcLen=${M.srcLen} btnParse=${M.hasBtnParse}`);

    /* ================= 匿名分支 =================
       2026-10-13 口径：**查看/试听对所有人生效**（login 档），下载仍要登录。
       所以这里要同时钉住两头：谱面真的渲染出来了、点下载真的会被引去登录。 */
    if (ANON) {
      const a = await ev(`(function(){
        return {
          hasCard: !!document.querySelector('.sp-card'),
          hasLock: !!document.querySelector('.score-lock'),
          lockText: ((document.querySelector('.score-lock')||{}).textContent||'').trim(),
          dlBtn: !!document.querySelector('#score-dl'),
          visNote: ((document.querySelector('.vis-note')||{}).textContent||'').trim(),
          userName: ((document.querySelector('.author-row .name')||{}).textContent||'').trim()
        };
      })()`);

      ok('★ 匿名访客看得到谱面卡（没被锁定态挡住）',
        a.hasCard && !a.hasLock,
        `hasCard=${a.hasCard} hasLock=${a.hasLock}${a.lockText ? ' lock="' + a.lockText.slice(0, 40) + '"' : ''}`);
      ok('匿名的卡外播放按钮在位（可试听）', !!M.btn, 'btn=' + M.btn);
      ok('匿名也挂着「下载乐谱 JSON」按钮（下载是登录后才放行的动作）', a.dlBtn);
      ok('匿名可见「下载权限：登录可下载」提示', /登录可下载/.test(a.visNote), 'vis-note=' + a.visNote);

      await ev(`window.scrollTo(0, 0); true`);
      await sleep(400);
      await shot('10-匿名-帖子页首屏.png');

      /* 试听：真实点卡外播放按钮 → 内核文案应翻「暂停」 */
      const h2 = await realClick('.sp-play');
      ok('匿名真实鼠标点中卡外播放按钮', h2.hit === 'button', 'hit=<' + h2.hit + '>');
      const flipped = await waitFor(async () => {
        const t = await ev(`(document.querySelector('.sp-play') || {}).textContent`);
        return t && t.indexOf('暂停') >= 0;
      }, '匿名点播放后按钮翻暂停').then(() => true).catch(() => false);
      ok('★ 匿名点播放 → 按钮镜像成「❚❚ 暂停」（试听真的在跑）', flipped);
      await ev(`document.querySelector('.sp-card').scrollIntoView({block:'center'}); true`);
      await sleep(400);
      await shot('11-匿名-播放中.png');

      /* 下载：应引导登录（requireLogin → toast「请先登录」→ 600ms 后跳 /login?next=…） */
      await realClick('#score-dl');
      const wentLogin = await waitFor(async () => (await ev(`location.pathname`)) === '/login',
        '点下载后跳到登录页').then(() => true).catch(() => false);
      const dest = await ev(`location.pathname + location.search`);
      ok('★ 匿名点「下载乐谱 JSON」→ 引导去登录（查看免费、下载要登录）',
        wentLogin, 'url=' + dest);
      await shot('12-匿名-点下载引导登录.png');
      return;
    }

    /* 首屏截图（滚到标题处） */
    await ev(`window.scrollTo(0, 0); true`);
    await sleep(400);
    await shot('01-帖子页首屏.png');

    /* ---- 真实点击「卡外播放按钮」 ---- */
    const hit = await realClick('.sp-play');
    ok('真实鼠标点中卡外播放按钮', hit.hit === 'button', 'hit=<' + hit.hit + '>');
    await waitFor(async () => {
      const t = await ev(`(document.querySelector('.sp-play') || {}).textContent`);
      return t && t.indexOf('暂停') >= 0;
    }, '按钮文案翻成暂停').then(
      () => ok('点播放 → 卡外按钮镜像成「❚❚ 暂停」', true),
      () => ok('点播放 → 卡外按钮镜像成「❚❚ 暂停」', false, '文案未变')
    );
    await ev(`document.querySelector('.sp-card').scrollIntoView({block:'center'}); true`);
    await sleep(500);
    await shot('02-播放中.png');

    /* ---- 真实拖动竖向进度条 ---- */
    const trk = M.trk;
    const x = trk.left + Math.round(trk.width / 2);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: trk.top + 4, button: 'left' });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y: trk.top + 4, button: 'left', clickCount: 1 });
    const yTo = Math.round(trk.top + trk.height * 0.3);
    for (const y of [trk.top + Math.round(trk.height * 0.15), yTo]) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left' });
      await sleep(120);
    }
    const afterDrag = await ev(`(function(){
      var f = document.querySelector('.sp-card iframe'), d = f.contentDocument;
      var pb = d.getElementById('progBar');
      var fil = pb.querySelector('.fil'), thm = pb.querySelector('.thm'), tip = pb.querySelector('.tip');
      return { filTop: fil.style.top, filH: fil.style.height, thmTop: thm.style.top,
               cur: (tip.querySelector('b') || {}).textContent, all: (tip.querySelector('span') || {}).textContent,
               dragging: pb.classList.contains('drag'),
               btn: (document.querySelector('.sp-play') || {}).textContent };
    })()`);
    await shot('03-拖动跳转.png');
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: yTo, button: 'left', clickCount: 1 });
    await sleep(300);

    const filPct = parseFloat(String(afterDrag.filH).replace('%', ''));
    ok('按住拖动 → 灰色已播段随指针变化', filPct > 40 && filPct < 95,
      `fil top=${afterDrag.filTop} height=${afterDrag.filH}`);
    ok('拖动时显示时间气泡（当前 / 总时长）',
      /^\d+:\d\d$/.test(String(afterDrag.cur)) && String(afterDrag.all).indexOf('/') >= 0,
      `气泡 = ${afterDrag.cur}${afterDrag.all}`);
    ok('拖动中按钮回到「▶ 播放」（拖动先自动暂停）',
      String(afterDrag.btn).indexOf('播放') >= 0, 'btn=' + afterDrag.btn);

    console.log('  ℹ️ AudioContext.state = ' + M.audioState +
      '（无头无音频设备 ⇒ 进度不会自己走，属环境假象；进度机制已由拖动验证）');
  } finally {
    await killBrowserAndClean(child, PROFILE, ws);
  }
}

/* ================================================================ */
(async () => {
  const jsonPath = process.argv[2] || 'E:/edgeDownload/親愛なるあの日々へ.json';
  const title = process.argv[3];
  if (!fs.existsSync(jsonPath)) { console.error('找不到乐谱 JSON：' + jsonPath); process.exit(2); }
  if (!fs.existsSync(EDGE)) { console.error('找不到 Edge：' + EDGE); process.exit(2); }

  console.log('=== ① 上传乐谱 + 建帖 ===');
  const ctx = await seed(jsonPath, title);
  console.log('\n=== ② 真机打开帖子页 ===');
  await demo(ctx);

  const fail = results.filter((x) => !x).length;
  console.log(`\n${fail ? '✗' : '★'} 帖子页真机演示${ANON ? '（匿名态）' : ''} ${fail ? '有失败项' : '全部通过'} ` +
    `(${results.length - fail}/${results.length})`);
  console.log(`帖子地址：${WEB}/post/${ctx.pid}（登录 demo / 123456 可自行操作）`);
  console.log(`截图目录：${SHOT_DIR}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('✗ 演示失败：' + e.message); process.exit(2); });
