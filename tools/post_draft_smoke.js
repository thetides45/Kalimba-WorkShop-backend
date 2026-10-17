/* 草稿（status=3）与「非正常态放行」的验收冒烟 —— 2026-10-14
 *
 * 前置：后端 8080 在跑（`mvn -o spring-boot:run -Dspring-boot.run.arguments=--server.port=8080`）。
 * 账号：demo / 123456（普通作者）、admin / 123456（管理员）。
 *
 * ⚠️ 发帖接口有**限流 5 次/分钟**（PostService.create 里的 rateLimiter），
 *    所以本脚本只新建 **2 篇**帖子（A 草稿线、B 状态线），其余断言都靠改状态复用。
 *
 * 覆盖：
 *   ① 新建草稿 → status=3
 *   ② 匿名读草稿详情 → 3001（不是 403 —— 不泄露「这里存在一篇草稿」）
 *   ③ 列表口径：作者看得到自己的草稿；**匿名即使带上 ?userId= 也看不到**
 *   ④ 搜索 / 热榜都不含草稿
 *   ⑤ 管理员能看到草稿
 *   ⑥ 作者侧状态接口的边界：只收 1/3（传 0/2 一律 1001）
 *   ⑦ 草稿 → 发布 → 匿名可见；已发布 → 转草稿 → 匿名又不可见
 *   ⑧ 匿名改状态 → 2001；非作者改别人帖子 → 1004
 *   ⑨ 下架帖（2）**作者不能自行恢复** → 1004
 *   ⑩ 待审帖（0）作者现在也能点进去（顺带修掉的既有 bug）
 *   ⑪ 草稿可删：走的就是 DELETE /api/posts/{id}
 *   收尾：删掉本脚本造的所有测试帖。
 */
const API = 'http://localhost:8080';

let pass = 0, fail = 0, skip = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (detail ? '   [' + detail + ']' : '')); }
}
function sk(name, why) { skip++; console.log('⊘ ' + name + '  （' + why + '）'); }

async function req(method, path, body, token) {
  const h = {};
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h['sa-token'] = token;
  const r = await fetch(API + path, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
  return { http: r.status, code: json ? json.code : null, message: json ? json.message : '', data: json ? json.data : null };
}
async function login(u, p) {
  const r = await req('POST', '/api/auth/login', { username: u, password: p });
  return r.code === 0 ? r.data.token : null;
}
const TAG = 'ZZ草稿冒烟-' + Date.now();

(async () => {
  const demo = await login('demo', '123456');
  const admin = await login('admin', '123456');
  if (!demo) { console.error('登录 demo 失败，后端没起？'); process.exit(1); }
  ok('demo / admin 登录成功', !!demo && !!admin);

  const created = [];

  /* ============ 帖 A：草稿线 ============ */
  const ca = await req('POST', '/api/posts', {
    title: TAG + '-A', content: '草稿链路的测试正文', tagIds: [], cover: null, scoreFileId: null, draft: true
  }, demo);
  ok('① 新建草稿成功', ca.code === 0, 'code=' + ca.code + ' ' + ca.message);
  const idA = ca.data && ca.data.id;
  if (idA) created.push(idA);
  ok('① status = 3（草稿）', ca.data && Number(ca.data.status) === 3, 'status=' + (ca.data && ca.data.status));

  if (idA) {
    ok('② 匿名读草稿详情被拒 3001', (await req('GET', '/api/posts/' + idA)).code === 3001);

    const anonList = await req('GET', '/api/posts?page=1&size=50');
    const anonIds = ((anonList.data && anonList.data.records) || []).map((p) => String(p.id));
    ok('③ 匿名列表不含草稿', !anonIds.includes(String(idA)));

    /* ★ 关键：userId 是公开查询参数，不能因为「传了就放行」 */
    const anonByUser = await req('GET', '/api/posts?page=1&size=50&userId=2');
    const anonByUserIds = ((anonByUser.data && anonByUser.data.records) || []).map((p) => String(p.id));
    ok('③ ★ 匿名带 ?userId=2 仍然看不到草稿', !anonByUserIds.includes(String(idA)),
      '拿到 ' + anonByUserIds.length + ' 条');

    const mine = await req('GET', '/api/posts?page=1&size=50&userId=2', undefined, demo);
    const mineIds = ((mine.data && mine.data.records) || []).map((p) => String(p.id));
    ok('③ 作者自己的列表里**有**草稿', mineIds.includes(String(idA)));

    const dA = await req('GET', '/api/posts/' + idA, undefined, demo);
    ok('② 作者能读自己的草稿', dA.code === 0 && Number(dA.data.status) === 3,
      'code=' + dA.code + ' status=' + (dA.data && dA.data.status));

    const dAdmin = await req('GET', '/api/posts/' + idA, undefined, admin);
    ok('⑤ 管理员也能读草稿', dAdmin.code === 0, 'code=' + dAdmin.code);

    const srch = await req('GET', '/api/search?keyword=' + encodeURIComponent(TAG) + '&type=post&page=1&size=20');
    const hitIds = ((srch.data && srch.data.posts && srch.data.posts.list) || []).map((p) => String(p.id));
    ok('④ 搜索搜不到草稿', !hitIds.includes(String(idA)), '命中 ' + hitIds.length + ' 条');

    const hot = await req('GET', '/api/hot');
    const hotIds = ((hot.data && (hot.data.list || hot.data.records)) || []).map((p) => String(p.id));
    ok('④ 热榜不含草稿', !hotIds.includes(String(idA)), '榜单 ' + hotIds.length + ' 条');

    /* ---- 作者侧状态接口的边界 ---- */
    ok('⑥ 传 status=2（下架）被拒 1001', (await req('PUT', '/api/posts/' + idA + '/status?status=2', undefined, demo)).code === 1001);
    ok('⑥ 传 status=0（待审）被拒 1001', (await req('PUT', '/api/posts/' + idA + '/status?status=0', undefined, demo)).code === 1001);
    ok('⑧ 匿名改状态被拒 2001', (await req('PUT', '/api/posts/' + idA + '/status?status=1')).code === 2001);

    const pub = await req('PUT', '/api/posts/' + idA + '/status?status=1', undefined, demo);
    ok('⑦ 草稿 → 发布 成功', pub.code === 0, 'code=' + pub.code + ' ' + pub.message);
    ok('⑦ 发布后 status = 1', pub.data && Number(pub.data.status) === 1, 'status=' + (pub.data && pub.data.status));
    ok('⑦ 发布后匿名可见', (await req('GET', '/api/posts/' + idA)).code === 0);

    const back = await req('PUT', '/api/posts/' + idA + '/status?status=3', undefined, demo);
    ok('⑦ 已发布 → 转回草稿 成功', back.code === 0 && Number(back.data.status) === 3);
    ok('⑦ 转草稿后匿名又不可见 3001', (await req('GET', '/api/posts/' + idA)).code === 3001);
  }

  /* ============ 帖 B：下架 / 待审线 ============ */
  const cb = await req('POST', '/api/posts', {
    title: TAG + '-B', content: '状态线的测试正文', tagIds: [], cover: null, scoreFileId: null
  }, demo);
  ok('新建普通帖（未带 draft）→ status=1', cb.code === 0 && Number(cb.data.status) === 1,
    'code=' + cb.code + ' status=' + (cb.data && cb.data.status));
  const idB = cb.data && cb.data.id;
  if (idB) created.push(idB);

  if (idB) {
    const down = await req('PUT', '/api/admin/posts/' + idB + '/status?status=2', undefined, admin);
    ok('管理员可把帖子改为下架(2)', down.code === 0, 'code=' + down.code + ' ' + down.message);
    ok('⑨ ★ 下架帖作者**不能**自行恢复 → 1004',
      (await req('PUT', '/api/posts/' + idB + '/status?status=1', undefined, demo)).code === 1004);

    const pend = await req('PUT', '/api/admin/posts/' + idB + '/status?status=0', undefined, admin);
    ok('管理员可把帖子改为待审(0)', pend.code === 0);
    const dB = await req('GET', '/api/posts/' + idB, undefined, demo);
    ok('⑩ ★ 作者能读自己的**待审**帖（修掉的既有 bug）', dB.code === 0 && Number(dB.data.status) === 0,
      'code=' + dB.code + ' status=' + (dB.data && dB.data.status));
    ok('⑩ 待审帖匿名仍 3001', (await req('GET', '/api/posts/' + idB)).code === 3001);

    /* 非作者（demo）改别人的帖子 → 1004 */
    const others = await req('GET', '/api/posts?page=1&size=50');
    const other = ((others.data && others.data.records) || []).find((p) => String(p.userId) !== '2');
    if (other) {
      const r = await req('PUT', '/api/posts/' + other.id + '/status?status=3', undefined, demo);
      ok('⑧ ★ 非作者改别人的帖子 → 1004', r.code === 1004,
        '帖 #' + other.id + '(user_id=' + other.userId + ') code=' + r.code);
    } else {
      sk('⑧ 非作者改别人的帖子 → 1004', '库里没有 demo 之外的帖子可试');
    }
  }

  /* ============ ⑪ 草稿可删 ============ */
  if (idA) {
    const del = await req('DELETE', '/api/posts/' + idA, undefined, demo);
    ok('⑪ 作者可删自己的草稿', del.code === 0, 'code=' + del.code + ' ' + del.message);
    ok('⑪ 删除后详情 3001', (await req('GET', '/api/posts/' + idA)).code === 3001);
    const i = created.indexOf(idA); if (i > -1) created.splice(i, 1);   // 已删，收尾不用再删
  }

  /* ============ 收尾：清掉测试帖 ============ */
  let cleaned = 0;
  for (const id of created) {
    const r = await req('DELETE', '/api/posts/' + id, undefined, demo);
    if (r.code === 0) cleaned++;
  }
  console.log('\n收尾：清理测试帖 ' + cleaned + '/' + created.length + ' 条（标题前缀 ' + TAG + '）');

  console.log('\n' + (fail ? '✗ 有 ' + fail + ' 项不符' : '★ 全部通过') +
    '   （通过 ' + pass + ' / 失败 ' + fail + (skip ? ' / 跳过 ' + skip : '') + '）');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
