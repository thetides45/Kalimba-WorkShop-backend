/**
 * 文件访问控制冒烟 —— 纯 HTTP，不 spawn 外部进程、不直连数据库。
 *
 * 覆盖 2026-10-03 那轮「白名单收紧 + 堵静态旁路」：
 *   ① 公开**读**接口不能因为收紧白名单而被打挂（回归保护）
 *   ② 匿名**下载**乐谱附件（GET /api/files/{id}）被拒；而只读的 /meta 与 /content
 *      已从登录层放行（2026-10-13「匿名也能看谱、能试听」）—— 两头都要钉住
 *   ③ ★ 乐谱静态旁路 /uploads/score/** 被堵（此前不带 token 直接 200）
 *   ④ 图片静态路径 /uploads/img/** 仍可匿名读（<img> 发不出 sa-token 头，必须公开）
 *   ⑤ B3：匿名调**写**接口被拦截层拒（此前 /api/posts/* 会把 PUT/DELETE 一起放行）
 *   ⑥ 匿名上传被拒（否则等于开放免费图床）
 *   ⑦ 登录后一切照常（下载、详情、管理端仍按角色拦）
 *
 * 前置：后端 8080 已启动。用法：
 *   node tools/file_access_smoke.js
 * 可选（用于断言 ③④，由外层从数据库/磁盘取，避免脚本直连 DB）：
 *   KAL_SCORE_PATH=/uploads/score/xxx.json  KAL_IMG_PATH=/uploads/img/xxx.png
 *   KAL_SCORE_MARKER=<上传时塞进 title 的随机串>   ← 断言 ③ 的探针，见该处注释
 */
const BASE = process.env.KAL_API || 'http://localhost:8080';
const SCORE_PATH = process.env.KAL_SCORE_PATH || '';
const SCORE_MARKER = process.env.KAL_SCORE_MARKER || '';
const IMG_PATH = process.env.KAL_IMG_PATH || '';

let pass = 0, fail = 0, skipped = 0;
function ok(label, cond, extra = '') {
  const p = !!cond;
  p ? pass++ : fail++;
  console.log(`${p ? '✓' : '✗'} ${label}${extra ? '  [' + extra + ']' : ''}`);
  return p;
}
function skip(label, why) { skipped++; console.log(`⊘ ${label}  [跳过：${why}]`); }

async function req(method, path, body, token) {
  const headers = {};
  if (token) headers['sa-token'] = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    return { code: res.status, message: 'HTTP ' + res.status + ' 非 JSON', data: null };
  }
}
/** 原始请求：用于二进制（下载/静态资源）。同时给「原始字节」与「UTF-8 文本」两种视图 ——
    判图片要看字节（toString('utf8') 会把 PNG 魔数 0x89 变成替换字符，看不出真假）。 */
async function raw(path, token) {
  const headers = {};
  if (token) headers['sa-token'] = token;
  const res = await fetch(BASE + path, { headers });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, type: res.headers.get('content-type') || '', len: buf.length, buf, body: buf.toString('utf8') };
}
async function login(username, password) {
  const r = await req('POST', '/api/auth/login', { username, password });
  return r.code === 0 ? r.data.token : null;
}

(async () => {
  /* ================= ① 公开读：不能被收紧白名单打挂 ================= */
  const pub = [
    ['帖子列表', 'GET', '/api/posts?page=1&size=1'],
    ['标签', 'GET', '/api/tags'],
    ['热榜', 'GET', '/api/hot'],
    ['分类字典', 'GET', '/api/meta/categories'],
    ['综合搜索', 'GET', '/api/search?keyword=' + encodeURIComponent('天空')],
    ['热搜词', 'GET', '/api/search/hot?limit=5'],
    ['用户公开主页', 'GET', '/api/users/2'],
  ];
  for (const [label, m, p] of pub) {
    const r = await req(m, p);
    ok(`匿名可读：${label}`, r.code === 0, 'code=' + r.code);
  }

  // 帖子的 id 与评论列表要拿到具体 id 才能测
  const list = await req('GET', '/api/posts?page=1&size=1');
  const pid = ((list.data && list.data.records) || [])[0] && list.data.records[0].id;
  if (pid) {
    ok('匿名可读：帖子详情', (await req('GET', '/api/posts/' + pid)).code === 0);
    ok('匿名可读：评论列表', (await req('GET', `/api/posts/${pid}/comments?page=1&size=5`)).code === 0);
    /* 互动状态要按「当前登录者」算点赞/收藏，Service 内部直接 getLoginIdAsLong()，
       所以它**本来就**需要登录（/api/posts/* 只匹配一段路径，从来不覆盖它）—— 这里断言
       2001 是为了把这个既有行为钉住，防止以后有人误把它当「公开读」放出去。 */
    const iv = await req('GET', `/api/posts/${pid}/interaction`);
    ok('互动状态需登录（既有行为，非本轮改动）', iv.code === 2001, 'code=' + iv.code);
  } else {
    skip('帖子详情/评论列表', '库里没有帖子');
  }

  ok('匿名可登录（POST /api/auth/login 不受影响）', !!(await login('demo', '123456')));

  /* ================= ② 匿名读乐谱：下载仍拒，只读面已放行 =================
     2026-10-13 口径调整：「匿名也能看谱、能试听」⇒ /meta 与 /content 放进公开白名单。
     断言必须**同时钉住两头** —— 放行的那两条真的通了、下载那条真的还堵着；
     只测一头的话，「放行」很容易悄悄变成把 /api/files/** 一起敞开。 */
  const anonDl = await req('GET', '/api/files/1');
  ok('★ 匿名**下载**乐谱附件仍被拒（必须登录是下载的下限）',
    anonDl.code === 2001, 'code=' + anonDl.code + ' ' + anonDl.message);

  const anonMeta = await req('GET', '/api/files/1/meta');
  ok('★ 匿名可读 /meta（已被白名单放行；帖子页靠它决定渲染谱面还是锁定卡片）',
    anonMeta.code === 0,
    'code=' + anonMeta.code + ' viewable=' + (anonMeta.data && anonMeta.data.viewable));
  ok('匿名 /meta 仍不泄露 filePath',
    anonMeta.code === 0 && !('filePath' in (anonMeta.data || {})),
    '字段=' + Object.keys(anonMeta.data || {}).join(','));

  const anonView = await raw('/api/files/1/content');
  /* 真文件是裸 JSON（无 code）；错误体是 R{code}。据此区分，别只看 HTTP（业务错误恒 200）。 */
  let viewCode = 0;
  try {
    const j = JSON.parse(anonView.body);
    if (j && j.code !== undefined && j.format === undefined) viewCode = j.code;
  } catch (e) { viewCode = -1; }
  const tier1 = (anonMeta.data && anonMeta.data.visibility) || '?';
  /* ★ 关键：**不是 2001** 才说明是白名单放行的。若被登录层拦，这里会是 2001，
     那「匿名可查看」就是假的（只是恰好分级也拦住了，看起来像对）。 */
  ok('★ 匿名取 /content 未被**登录层**拦（白名单确实放行了）',
    viewCode !== 2001, `code=${viewCode} tier=${tier1} ${anonView.len}B`);
  if (tier1 === 'login') {
    ok('★ login 档 · 匿名可取到谱面内容（能看 / 能试听）',
      viewCode === 0 && anonView.len > 100, `${anonView.len}B`);
  } else {
    ok(`非 login 档（${tier1}）· 匿名取内容被**分级**拦（5003，而不是登录层）`,
      viewCode === 5003, 'code=' + viewCode);
  }

  /* ================= ③ 静态旁路被堵 =================
     ⚠️ 判据必须看 **响应体**，不能看 HTTP 状态码：本项目所有业务错误都以
     HTTP 200 + body 里的 code 表达（连「资源不存在」也是 `{code:1000,...}`），
     所以拿 200 当「成功拿到文件」会得到完全相反的结论（这一版就踩了）。 */
  if (SCORE_PATH) {
    const bypass = await raw(SCORE_PATH);
    /* ⚠️ marker 必须是**内容里真实存在的一串**，绝不能写死成格式名。
       2026-10-13 这里写的还是 'kalimba-score'，而上传物早已换成内核格式 kalimba-tab
       → marker 永远找不到 → 断言**恒绿、真空通过**（与 kal_run_clean 少了 process.exit 同类）。
       正确来源：upload_smoke.js 上传时把随机串塞进 title，并把
       `KAL_SCORE_PATH=… KAL_SCORE_MARKER=…` 的串联命令打印出来。
       没给 marker 时退回当前真源格式名（今天确实在测），并**显式告警**提醒补上。 */
    const marker = SCORE_MARKER || 'kalimba-tab';
    if (!SCORE_MARKER) {
      console.log(`  ⚠️ 未提供 KAL_SCORE_MARKER，退回格式名 "${marker}" 当 marker；` +
        '建议按 upload_smoke.js 打印的随机串串联，换格式后此断言才不会失真。');
    }
    const leaked = bypass.body.indexOf(marker) >= 0;
    ok('★ 乐谱静态旁路 /uploads/score/** 已被堵（响应体里不再有乐谱内容）',
      !leaked, `HTTP ${bypass.status}，${bypass.len}B，marker="${marker}"，命中=${leaked}`);
  } else {
    skip('乐谱静态旁路断言', '未提供 KAL_SCORE_PATH');
  }

  /* ================= ④ 图片静态路径仍须公开 ================= */
  if (IMG_PATH) {
    const img = await raw(IMG_PATH);
    /* 按**字节**判真假：真图片应以 PNG 魔数开头，而不是那段错误文案。 */
    const isRealPng = img.buf.length > 8 && img.buf[0] === 0x89 && img.buf[1] === 0x50
      && img.buf[2] === 0x4e && img.buf[3] === 0x47;
    ok('图片静态路径仍可匿名读（<img> 依赖）',
      img.status === 200 && img.type.indexOf('image') === 0 && isRealPng,
      `HTTP ${img.status} ${img.type} PNG魔数=${isRealPng} ${img.len}B`);
  } else {
    skip('图片静态可读断言', '未提供 KAL_IMG_PATH');
  }

  /* ================= ⑤ B3：匿名调写接口被拦截层拒 ================= */
  const writeAnon = [
    ['发帖 POST /api/posts', 'POST', '/api/posts', { title: 'x', content: '', tagIds: [] }],
    ['改资料 PUT /api/users/me', 'PUT', '/api/users/me', { nickname: 'x' }],
    ['举报 POST /api/reports', 'POST', '/api/reports', { targetType: 'post', targetId: '1', reason: 'x' }],
    ['关注 POST /api/users/2/follow', 'POST', '/api/users/2/follow', undefined],
  ];
  for (const [label, m, p, b] of writeAnon) {
    const r = await req(m, p, b);
    ok(`匿名写被拒：${label}`, r.code === 2001, 'code=' + r.code);
  }
  if (pid) {
    ok('匿名写被拒：编辑帖子 PUT /api/posts/{id}（★ B3）',
      (await req('PUT', '/api/posts/' + pid, { title: 'x', content: '', tagIds: [] })).code === 2001);
    ok('匿名写被拒：删除帖子 DELETE /api/posts/{id}（★ B3）',
      (await req('DELETE', '/api/posts/' + pid)).code === 2001);
    ok('匿名写被拒：删评论 DELETE /api/posts/{id}/comments/{cid}',
      (await req('DELETE', `/api/posts/${pid}/comments/1`)).code === 2001);
  }

  /* ================= ⑥ 匿名上传被拒 ================= */
  for (const p of ['/api/files/image', '/api/files/score']) {
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'x.png');
    const res = await fetch(BASE + p, { method: 'POST', body: fd });
    const j = await res.json().catch(() => ({ code: res.status }));
    ok(`匿名上传被拒：POST ${p}`, j.code === 2001, 'code=' + j.code);
  }

  /* ================= ⑦ 登录后照常 ================= */
  const tok = await login('demo', '123456');
  if (tok) {
    const dl = await raw('/api/files/1', tok);
    ok('★ 登录后可下载乐谱附件', dl.status === 200 && dl.len > 0, `HTTP ${dl.status} ${dl.len}B`);
    if (pid) ok('登录后可读帖子详情', (await req('GET', '/api/posts/' + pid, undefined, tok)).code === 0);
    const asUserAdmin = await req('GET', '/api/admin/stats', undefined, tok);
    ok('普通用户仍被管理端拦截（角色校验未被削弱）', asUserAdmin.code === 6001, 'code=' + asUserAdmin.code);
    ok('匿名仍被管理端拦截', (await req('GET', '/api/admin/stats')).code === 2001);
  } else {
    ok('登录 demo 成功', false, '登录失败，后续断言无法进行');
  }

  console.log(`\n${fail === 0 ? '★ 文件访问控制冒烟全部通过' : '✗ 有失败项'} (${pass}/${pass + fail}${skipped ? '，跳过 ' + skipped : ''})`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('ERR', e.message); process.exit(2); });
