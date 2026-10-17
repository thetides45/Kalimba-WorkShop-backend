/**
 * 用户模块接口冒烟 —— 纯 HTTP，不 spawn 外部进程、不直连数据库。
 *
 * 覆盖（2026-10-02 补齐用户中心后端的第一档改动）：
 *   ① profile 字段完整性：intro / fanType / postCount / followerCount / followingCount / isFollowing
 *   ② 三格统计是**真数据**：postCount 与 GET /api/posts?userId= 的 total 互相印证（同一真源，防两处漂移）
 *   ③ 匿名可访问公开主页，且 isFollowing 不因未登录而报错
 *   ④ 改资料往返：昵称 / 简介 / 琴型（**全程可逆**，finally 里还原）
 *   ⑤ 部分更新语义：只发 nickname 时不得把 intro 清空（等价于「旧客户端只发 nickname+avatar」的调用方式）
 *   ⑥ 参数校验：fanType 非 17/21、intro 超 60、昵称超 20 一律拒
 *   ⑦ 未登录改资料被拒
 *   ⑧ GET /api/posts?userId= 真的按作者筛（此前是「拉一页全站再前端 filter」的假过滤）
 *   ⑨ 改资料会进「审核记录」（@OpLog 生效）
 *
 * 前置：后端 8080 已启动。用法：node tools/user_api_smoke.js
 */
const BASE = process.env.KAL_API || 'http://localhost:8080';

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
    throw new Error(`非 JSON 响应：${method} ${path} → HTTP ${res.status}，body=${text.slice(0, 160)}`);
  }
}
async function login(username, password) {
  const r = await req('POST', '/api/auth/login', { username, password });
  return r.code === 0 ? r.data : null;
}
const q = encodeURIComponent;

(async () => {
  /* ================= ① 公开主页字段完整性（匿名） ================= */
  const anon = await req('GET', '/api/users/2');
  ok('匿名可访问公开主页（白名单）', anon.code === 0, 'code=' + anon.code);
  const u = anon.data || {};
  const need = ['id', 'username', 'nickname', 'avatar', 'intro', 'fanType',
    'postCount', 'followerCount', 'followingCount', 'isFollowing'];
  const missing = need.filter((k) => !(k in u));
  ok('主页字段齐全（含简介/琴型/三格统计/关注态）', missing.length === 0,
    missing.length ? '缺 ' + missing.join(',') : JSON.stringify({
      intro: u.intro, fanType: u.fanType, postCount: u.postCount,
      followerCount: u.followerCount, followingCount: u.followingCount, isFollowing: u.isFollowing
    }));
  ok('匿名时 isFollowing 恒为 false（不是报错）', u.isFollowing === false);
  ok('绝不返回 passwordHash', !('passwordHash' in u) && !('password_hash' in u));
  ok('简介已是真数据（不是写死的空串）', typeof u.intro === 'string' && u.intro.length > 0,
    'intro=' + JSON.stringify(u.intro));

  const ghost = await req('GET', '/api/users/999999999');
  ok('不存在的用户返回业务错误', ghost.code !== 0, 'code=' + ghost.code);

  /* ================= ② 三格统计与帖子接口互证 ================= */
  const postsOf2 = await req('GET', '/api/posts?page=1&size=50&userId=2');
  ok('按作者取帖可用', postsOf2.code === 0 && Array.isArray(postsOf2.data.records),
    'total=' + (postsOf2.data && postsOf2.data.total));
  const rowsOf2 = (postsOf2.data && postsOf2.data.records) || [];
  ok('按作者取帖：每条都属于该作者',
    rowsOf2.every((p) => String(p.userId) === '2'), rowsOf2.length + ' 条');
  ok('匿名看他人主页只给已发布（无 status=0/2）',
    rowsOf2.every((p) => p.status === 1), JSON.stringify(rowsOf2.map((p) => p.status)));
  ok('★ postCount 与「按作者取帖」的 total 一致（同一真源）',
    Number(u.postCount) === Number(postsOf2.data.total),
    `profile.postCount=${u.postCount} vs posts.total=${postsOf2.data.total}`);

  const nothing = await req('GET', '/api/posts?userId=999999999');
  ok('不存在的作者返回空列表而非报错',
    nothing.code === 0 && Number(nothing.data.total) === 0, 'total=' + (nothing.data && nothing.data.total));

  /* ================= ④⑤⑥⑦ 改资料（可逆） ================= */
  const demo = await login('demo', '123456');
  ok('demo 可登录', !!demo);
  if (!demo) { console.log('\n✗ 无法登录 demo，改资料相关断言跳过'); process.exit(1); }
  const tok = demo.token;

  const before = (await req('GET', '/api/users/' + demo.userId)).data;
  const snapshot = { nickname: before.nickname, intro: before.intro, fanType: before.fanType };
  console.log(`  （基线：昵称=${snapshot.nickname} 简介=${JSON.stringify(snapshot.intro)} 琴型=${snapshot.fanType}）`);

  let restored = false;
  const restore = async () => {
    if (restored) return;
    restored = true;
    await req('PUT', '/api/users/me', snapshot, tok).catch(() => {});
  };

  try {
    /* 未登录改资料被拒 */
    const noAuth = await req('PUT', '/api/users/me', { nickname: 'x'.repeat(3) });
    ok('未登录改资料被拒', noAuth.code !== 0, 'code=' + noAuth.code);

    /* 完整往返 */
    const NEW_INTRO = '冒烟专用简介 · 自动还原';
    const up = await req('PUT', '/api/users/me',
      { nickname: snapshot.nickname, intro: NEW_INTRO, fanType: 21 }, tok);
    ok('改简介 / 琴型接口可用', up.code === 0, up.message);

    const after = (await req('GET', '/api/users/' + demo.userId)).data;
    ok('简介写入并读回一致', after.intro === NEW_INTRO, JSON.stringify(after.intro));
    ok('琴型由 17 改为 21 成功', after.fanType === 21, 'fanType=' + after.fanType);

    /* 部分更新：只发 nickname，intro 不得被清空 */
    const partial = await req('PUT', '/api/users/me', { nickname: snapshot.nickname }, tok);
    ok('只发 nickname 的部分更新成功（旧式只发部分字段的调用兼容）', partial.code === 0);
    const after2 = (await req('GET', '/api/users/' + demo.userId)).data;
    ok('★ 部分更新不清空未提交的字段（intro 仍在）', after2.intro === NEW_INTRO,
      'intro=' + JSON.stringify(after2.intro));
    ok('部分更新不动琴型', after2.fanType === 21, 'fanType=' + after2.fanType);

    /* 参数校验 */
    const badFan = await req('PUT', '/api/users/me', { fanType: 18 }, tok);
    ok('琴型非 17/21 被拒', badFan.code !== 0, 'code=' + badFan.code + ' ' + badFan.message);
    const longIntro = await req('PUT', '/api/users/me', { intro: '介'.repeat(61) }, tok);
    ok('简介超过 60 字被拒', longIntro.code !== 0, 'code=' + longIntro.code);
    const longNick = await req('PUT', '/api/users/me', { nickname: '名'.repeat(21) }, tok);
    ok('昵称超过 20 字被拒', longNick.code !== 0, 'code=' + longNick.code);

    /* ⑨ 改资料进审核记录 */
    const admin = await login('admin', '123456');
    if (admin && admin.token) {
      const logs = await req('GET', '/api/admin/logs?page=1&size=20&action=' + q('更新个人资料'), undefined, admin.token);
      const rows = (logs.data && logs.data.records) || [];
      ok('改资料已进「审核记录」（@OpLog 生效）',
        logs.code === 0 && rows.length > 0 && rows[0].username === 'demo',
        rows.length ? rows[0].username + ' ' + rows[0].method + ' ' + rows[0].uri : '无记录');
    } else {
      skip('审核记录断言', 'admin 登录失败');
    }
  } finally {
    await restore();
  }

  /* 还原校验（放在 finally 之后：restore 已执行） */
  const back = (await req('GET', '/api/users/' + demo.userId)).data;
  ok('★ 测试已完整还原（可重入）',
    back.nickname === snapshot.nickname && back.intro === snapshot.intro && back.fanType === snapshot.fanType,
    `昵称=${back.nickname} 简介=${JSON.stringify(back.intro)} 琴型=${back.fanType}`);

  console.log(`\n${fail === 0 ? '★ 用户模块冒烟全部通过' : '✗ 有失败项'} (${pass}/${pass + fail}${skipped ? '，跳过 ' + skipped : ''})`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('ERR', e.message); process.exit(2); });
