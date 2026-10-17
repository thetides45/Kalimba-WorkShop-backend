/**
 * 乐谱下载分级（score_file.visibility）冒烟 —— 纯 HTTP，不 spawn 外部进程、不直连数据库。
 *
 * 覆盖 2026-10-03 那轮「下载分级」：
 *   ① 上传带分级 → 分级真的落到 score_file（非法值被拒，不静默回落）
 *   ② 四档 login / favorite / follower / author，对「作者 / 已收藏者 / 未收藏者 / 已关注者 /
 *      未关注者 / 管理员 / 匿名」的可下载性逐一对齐（★ 同一份文件只改分级，就能看到结论翻转）
 *   ③ /meta 与真实下载**结论一致**（页面说能下就必须真能下，反之亦然）
 *   ④ 越权改分级被拒（非作者拿到 1004）
 *   ⑤ /meta 不泄露 filePath（服务端磁盘路径不该给前端）
 *   ⑥ 2026-10-13 起「查看 / 试听」与「下载」拆成两套口径：
 *      · /meta 与 /content **公开**（匿名可读）—— 帖子页要能在未登录时渲染谱面；
 *      · login 档匿名也能**看**，但**下载**仍要登录（「必须登录」是下载的下限）；
 *      · favorite / follower / author 三档对**查看**同样生效（匿名连看都不行）。
 *
 * 角色安排（刻意复用现有账号，不新建用户 —— 建用户会留下无法通过 HTTP 清理的垃圾行）：
 *   作者/上传者 = admin(1)，访问者 = demo(2)，非作者改权限也是 demo。
 *
 * ⚠️ `favorite` 档要求「收藏引用这份谱的帖子」，所以本脚本会**建一条帖子**（跑完删掉），
 *    并**新建一个乐谱附件**（没有删除接口，会留一行 + 一个 json，见末尾打印的清理 SQL）。
 *
 * 前置：后端 8080 已启动。用法：
 *   node tools/score_visibility_smoke.js
 */
const BASE = process.env.KAL_API || 'http://localhost:8080';

let pass = 0, fail = 0;
function ok(label, cond, extra = '') {
  const p = !!cond;
  p ? pass++ : fail++;
  console.log(`${p ? '✓' : '✗'} ${label}${extra ? '  [' + extra + ']' : ''}`);
  return p;
}

async function req(method, path, body, token) {
  const headers = {};
  if (token) headers['sa-token'] = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  try { return JSON.parse(text); }
  catch (e) { return { code: res.status, message: 'HTTP ' + res.status + ' 非 JSON', data: null }; }
}

/** 原始请求：附件接口返回的是**文件本体**或 `R{...}` 错误体，两种都要能看。 */
async function raw(path, token) {
  const headers = {};
  if (token) headers['sa-token'] = token;
  const res = await fetch(BASE + path, { headers });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('utf8');
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 真文件不是 JSON-R 包裹 */ }
  return { status: res.status, len: buf.length, text, json };
}

async function login(username, password) {
  const r = await req('POST', '/api/auth/login', { username, password });
  return r.code === 0 ? r.data.token : null;
}

/** 上传一个乐谱附件，可选择带 visibility。返回后端的原始 R 响应。 */
async function uploadScore(token, visibility) {
  /* ⚠️ 夹具用**内核导出格式**（2026-10-13 起唯一真源）。旧 kalimba-score 已无生成方，
     继续拿它当夹具会让下面 dl() 里的 isRealScore 判定测一份不存在的数据。 */
  const score = JSON.stringify({
    format: 'kalimba-tab', version: 1,
    title: '分级冒烟曲',
    key: { name: 'C', pc: 0 }, meter: [4, 4], tempo: 90,
    tuning: { key: 'k17', notes: [], len: 17 },
    mode: 'movable', direction: 'up', transpose: 0,
    unit: 0.25, rowsPerMeasure: 2, beatsPerMeasure: 4, nMeasures: 1,
    totalBeats: 5, usedCols: [0, 1, 2],
    rows: [{ idx: 0, rest: false, items: [{ col: 0, midi: 60, label: '1', dur: 1, voice: 0, bad: false }] }],
    source: '1 2 3 4 5',
  });
  const fd = new FormData();
  fd.append('file', new Blob([score], { type: 'application/json' }), 'visibility-smoke.json');
  let path = '/api/files/score';
  if (visibility !== undefined) path += '?visibility=' + encodeURIComponent(visibility);
  const res = await fetch(BASE + path, { method: 'POST', headers: { 'sa-token': token }, body: fd });
  const text = await res.text();
  try { return JSON.parse(text); } catch (e) { return { code: res.status, message: text.slice(0, 120), data: null }; }
}

/** 「内容类」接口的通用取法：诊断到底拿到了**真谱面**还是**错误体**。
    业务错误一律 HTTP 200 + body.code；真文件是裸 JSON（没有 code）。 */
async function scoreOf(path, token) {
  const r = await raw(path, token);
  const isRealScore = !!(r.json && r.json.format === 'kalimba-tab')
    || r.text.indexOf('kalimba-tab') >= 0;
  const code = (r.json && r.json.code !== undefined && r.json.format === undefined) ? r.json.code : 0;
  return { code, message: (r.json && r.json.message) || '', isRealScore, len: r.len };
}
/** 某 token（可为空=匿名）**下载**某附件（受分级 + 「必须登录」双重约束） */
const dl = (token, id) => scoreOf('/api/files/' + id, token);
/** 某 token（可为空=匿名）**查看 / 试听**某附件（公开只读；login 档匿名也放行） */
const view = (token, id) => scoreOf('/api/files/' + id + '/content', token);

const meta = (token, id) => req('GET', `/api/files/${id}/meta`, undefined, token);
const setVis = (token, id, v) => req('PUT', `/api/files/${id}/visibility?visibility=${encodeURIComponent(v)}`, undefined, token);

(async () => {
  const adminTok = await login('admin', '123456');
  const demoTok = await login('demo', '123456');
  if (!adminTok || !demoTok) {
    console.error('前置失败：admin / demo 登录不成功，无法继续');
    process.exit(2);
  }
  ok('前置：admin 与 demo 可登录', true);

  /* ================= ① 上传带分级 ================= */
  const upBad = await uploadScore(adminTok, 'nonsense');
  ok('上传时非法分级被拒（不静默回落）', upBad.code === 1001, 'code=' + upBad.code + ' ' + upBad.message);

  const up = await uploadScore(adminTok, 'favorite');
  const fid = up.data && up.data.id;
  ok('上传带 visibility=favorite 成功', up.code === 0 && !!fid, 'fileId=' + fid);
  ok('★ 分级真的落到了附件上（响应回显 favorite）',
    up.data && up.data.visibility === 'favorite', 'visibility=' + (up.data && up.data.visibility));
  if (!fid) { console.error('没有拿到 fileId，后续分级断言无法进行'); process.exit(2); }

  /* ================= ② favorite 档 · 未挂帖时（谁都收藏不了） ================= */
  let mViewer = await meta(demoTok, fid);
  ok('favorite 档 · 附件还没被任何帖子引用时，非作者也不可下',
    mViewer.code === 0 && mViewer.data.downloadable === false,
    'downloadable=' + (mViewer.data && mViewer.data.downloadable));

  /* ================= ③ 建一条引用该附件的帖子（收藏的载体） ================= */
  const created = await req('POST', '/api/posts', {
    title: '分级冒烟帖 ' + Date.now(),
    content: '由 score_visibility_smoke.js 创建，跑完自动删除。',
    tagIds: [], scoreFileId: fid
  }, adminTok);
  const pid = created.code === 0 ? String(created.data.id) : '';
  ok('准备：建一条引用该附件的帖子', !!pid, 'postId=' + pid);

  try {
    /* ================= ④ favorite 档 · 未收藏者 ================= */
    mViewer = await meta(demoTok, fid);
    ok('favorite 档 · 未收藏者：meta 说不可下载',
      mViewer.data.downloadable === false, 'reason=' + mViewer.data.reason);
    ok('★ favorite 档 · 指向「收藏」且 needsFavorite=true、needsFollow=false（解锁动作要唯一）',
      mViewer.data.needsFavorite === true && mViewer.data.needsFollow === false
        && /收藏/.test(mViewer.data.reason || ''),
      `reason=${mViewer.data.reason} needsFavorite=${mViewer.data.needsFavorite}`);

    let dViewer = await dl(demoTok, fid);
    ok('★ favorite 档 · 未收藏者：真下载被拒（5003 + 具体原因）',
      dViewer.code === 5003 && /收藏/.test(dViewer.message) && !dViewer.isRealScore,
      'code=' + dViewer.code + ' ' + dViewer.message);

    /* 收藏 → 解锁 */
    const fav = await req('POST', `/api/posts/${pid}/favorite`, undefined, demoTok);
    ok('demo 收藏该帖成功', fav.code === 0, 'code=' + fav.code);
    mViewer = await meta(demoTok, fid);
    ok('★ favorite 档 · 已收藏者：meta 转为可下载', mViewer.data.downloadable === true,
      'downloadable=' + mViewer.data.downloadable);
    dViewer = await dl(demoTok, fid);
    ok('★ favorite 档 · 已收藏者：真下载拿到源文件',
      dViewer.code === 0 && dViewer.isRealScore, 'code=' + dViewer.code + ' ' + dViewer.len + 'B');

    /* 取消收藏 → 立刻失去 */
    await req('DELETE', `/api/posts/${pid}/favorite`, undefined, demoTok).catch(() => {});
    const mAfterUnfav = await meta(demoTok, fid);
    ok('取消收藏后立刻回到不可下载（证明确实是按收藏关系判的）',
      mAfterUnfav.data.downloadable === false);

    /* ================= ⑤ follower 档 ================= */
    await setVis(adminTok, fid, 'follower');
    mViewer = await meta(demoTok, fid);
    ok('follower 档 · 非关注者：不可下载且 needsFollow=true、needsFavorite=false',
      mViewer.data.downloadable === false && mViewer.data.needsFollow === true
        && mViewer.data.needsFavorite === false,
      'reason=' + mViewer.data.reason);
    dViewer = await dl(demoTok, fid);
    ok('follower 档 · 非关注者：真下载被拒', dViewer.code === 5003 && !dViewer.isRealScore,
      'code=' + dViewer.code + ' ' + dViewer.message);

    const fw = await req('POST', '/api/users/1/follow', undefined, demoTok);
    ok('demo 关注 admin 成功', fw.code === 0, 'code=' + fw.code);
    try {
      mViewer = await meta(demoTok, fid);
      ok('★ follower 档 · 已关注者：meta 转为可下载', mViewer.data.downloadable === true);
      dViewer = await dl(demoTok, fid);
      ok('★ follower 档 · 已关注者：真下载拿到源文件',
        dViewer.code === 0 && dViewer.isRealScore, 'code=' + dViewer.code);
    } finally {
      /* 可逆：无论中间断言是否抛错，都要把关注关系还原（follow 表此前为空） */
      await req('DELETE', '/api/users/1/follow', undefined, demoTok).catch(() => {});
    }
    ok('取关后立刻回到不可下载',
      (await meta(demoTok, fid)).data.downloadable === false);

    /* ================= ⑥ author 档（PUT 改分级，不用重传） ================= */
    const pw = await setVis(adminTok, fid, 'author');
    ok('作者可改分级：PUT visibility=author', pw.code === 0 && pw.data.visibility === 'author');

    mViewer = await meta(demoTok, fid);
    ok('author 档 · 别人：不可下载且**两个解锁动作都不给**（needsFollow/needsFavorite 均 false）',
      mViewer.data.downloadable === false && mViewer.data.needsFollow === false
        && mViewer.data.needsFavorite === false,
      'reason=' + mViewer.data.reason);
    ok('author 档 · 别人的 reason 与 favorite / follower 档都不同（分级真的有区分）',
      mViewer.data.reason !== '收藏这篇帖后可下载' && mViewer.data.reason !== '关注作者后可下载',
      'reason=' + mViewer.data.reason);
    dViewer = await dl(demoTok, fid);
    ok('author 档 · 别人：真下载被拒', dViewer.code === 5003 && !dViewer.isRealScore,
      'code=' + dViewer.code + ' ' + dViewer.message);
    const dOwnerAuthor = await dl(adminTok, fid);
    ok('★ author 档 · 作者本人仍可下载（分级只约束别人，别把作者自己锁在门外）',
      dOwnerAuthor.code === 0 && dOwnerAuthor.isRealScore, 'code=' + dOwnerAuthor.code);
  } finally {
    /* 帖子必须删掉（否则会给后续断言/演示留一条挂测试附件的帖） */
    if (pid) await req('DELETE', '/api/posts/' + pid, undefined, adminTok).catch(() => {});
  }

  /* ================= ⑦ 越权改分级 ================= */
  const pwBad = await req('PUT', `/api/files/${fid}/visibility?visibility=login`, undefined, demoTok);
  ok('★ 非作者改分级被拒（1004）', pwBad.code === 1004, 'code=' + pwBad.code + ' ' + pwBad.message);
  const pwInvalid = await req('PUT', `/api/files/${fid}/visibility?visibility=whatever`, undefined, adminTok);
  ok('改分级时非法值被拒', pwInvalid.code === 1001, 'code=' + pwInvalid.code);
  const pwNoAuth = await req('PUT', `/api/files/${fid}/visibility?visibility=login`);
  ok('匿名改分级被拦截层拒（2001）', pwNoAuth.code === 2001, 'code=' + pwNoAuth.code);

  /* ================= ⑧ login 档 ================= */
  await setVis(adminTok, fid, 'login');
  mViewer = await meta(demoTok, fid);
  ok('login 档：任意登录用户可下载', mViewer.data.downloadable === true);
  const dLogin = await dl(demoTok, fid);
  ok('login 档：真下载拿到源文件', dLogin.code === 0 && dLogin.isRealScore);
  ok('login 档：reason 为空（能下就不该有理由）', !mViewer.data.reason, 'reason=' + mViewer.data.reason);

  /* ================= ⑨ 匿名：查看放行、下载仍拒（2026-10-13 拆口径） ================= */
  const mAnon = await meta(null, fid);      // fid 此刻是 login 档（⑧ 设的）
  ok('匿名可读 /meta（2026-10-13 起放行 —— 帖子页靠它决定渲染谱面还是锁定卡片）',
    mAnon.code === 0, 'code=' + mAnon.code);
  ok('★ login 档 · 匿名：viewable=true 而 downloadable=false（能看不等于能下）',
    mAnon.data.viewable === true && mAnon.data.downloadable === false,
    `viewable=${mAnon.data.viewable} downloadable=${mAnon.data.downloadable}`);
  const vAnonLogin = await view(null, fid);
  ok('★ login 档 · 匿名能真的取到内容（内嵌预览 / 试听靠它）',
    vAnonLogin.code === 0 && vAnonLogin.isRealScore, 'code=' + vAnonLogin.code + ' ' + vAnonLogin.len + 'B');
  const dAnon = await dl(null, fid);
  ok('★ 匿名**下载**被拒（「必须登录」仍是下载的下限）',
    dAnon.code === 2001 && !dAnon.isRealScore, 'code=' + dAnon.code);

  /* ---------- ⑨b 更严的三档：**查看**同样被拦（档位对查看也生效） ---------- */
  await setVis(adminTok, fid, 'favorite');
  const mAnonFav = await meta(null, fid);
  ok('favorite 档 · 匿名：viewable=false，且原因说明「要先登录」',
    mAnonFav.data.viewable === false && /登录/.test(mAnonFav.data.viewReason || ''),
    'viewReason=' + mAnonFav.data.viewReason);
  const vAnonFav = await view(null, fid);
  ok('favorite 档 · 匿名取内容被拒（5003 + 中文原因）',
    vAnonFav.code === 5003 && /收藏/.test(vAnonFav.message) && !vAnonFav.isRealScore,
    'code=' + vAnonFav.code + ' ' + vAnonFav.message);
  /* ★ 已登录但未收藏者也看不了 —— 证明「查看」确实按档位判，
     而不是被登录层顺手兜住的（那样档位其实没生效，只是所有人一并被拒）。 */
  ok('favorite 档 · 已登录但未收藏者：查看也被拒且是 5003（非 2001）',
    (await view(demoTok, fid)).code === 5003);

  await setVis(adminTok, fid, 'author');
  ok('author 档 · 匿名：viewable=false（连看都不行）',
    (await meta(null, fid)).data.viewable === false);
  ok('author 档 · 匿名取内容被拒', (await view(null, fid)).code === 5003);
  ok('★ author 档 · 作者本人仍可查看（别把作者自己锁在门外）',
    (await view(adminTok, fid)).code === 0);

  /* ================= ⑩ /meta 字段面 ================= */
  ok('/meta 不返回 filePath（服务端磁盘相对路径不该给前端）',
    !('filePath' in mViewer.data) && !('file_path' in mViewer.data),
    '字段=' + Object.keys(mViewer.data).join(','));
  ok('/meta 同时给出两个解锁动作字段（前端据此决定给哪个按钮）',
    'needsFollow' in mViewer.data && 'needsFavorite' in mViewer.data);
  ok('★ /meta 的查看与下载**两套口径**都在（前端据此分两条路渲染：viewable→画谱，downloadable→下载按钮）',
    'viewable' in mViewer.data && 'viewReason' in mViewer.data
      && 'downloadable' in mViewer.data && 'reason' in mViewer.data);

  /* ================= 复位 ================= */
  ok('收尾：分级复位为 login', (await setVis(adminTok, fid, 'login')).code === 0);

  console.log(`\n${fail === 0 ? '★ 乐谱下载分级冒烟全部通过' : '✗ 有失败项'} (${pass}/${pass + fail})`);
  console.log(`ℹ 本次新建附件 id=${fid}（无删除接口，留一行测试数据）。清理：`);
  console.log(`  DELETE FROM score_file WHERE id=${fid};  -- 并删除 uploads/score/${(up.data && up.data.filePath || '').split('/').pop()}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('ERR', e.message); process.exit(2); });
