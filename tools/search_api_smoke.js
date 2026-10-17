/**
 * 综合搜索接口冒烟测试（GET /api/search）—— 纯 HTTP，不直连数据库。
 * 覆盖：标题命中 / 正文命中 / 标签名命中 / 作者昵称命中 / type 过滤 / 空关键词 /
 *       无命中 / size 上限 / 只返回 status=1 / 热搜词计数 / 免登录可达。
 *
 * 说明：本机环境下 Node 不能 spawn 外部程序（EBUSY），所以「下架帖搜不到」改用管理端接口
 * 临时下架再恢复（可逆）；热搜用真实关键词做**增量**断言，避免往 search_log 写测试脏词。
 * 用法：先跑起后端（8080），再 node tools/search_api_smoke.js
 */
const BASE = 'http://localhost:8080';

let pass = 0, fail = 0;
function ok(label, cond, extra = '') {
  const p = !!cond;
  p ? pass++ : fail++;
  console.log(`${p ? '✓' : '✗'} ${label}${extra ? '  [' + extra + ']' : ''}`);
  return p;
}
async function send(method, path, body, token) {
  const headers = {};
  if (token) headers['sa-token'] = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`非 JSON 响应：${method} ${path} → HTTP ${res.status}，body=${text.slice(0, 160)}`); }
}
async function get(path, extra = '') {
  return send('GET', path + extra);
}
const q = (kw, extra = '') =>
  `/api/search?keyword=${encodeURIComponent(kw)}${extra}`;

(async () => {
  // 0. 免登录可达
  const anon = await get(q('天空'));
  ok('免登录可访问 /api/search', anon.code === 0, 'code=' + anon.code);

  // 1. 标题命中
  const byTitle = await get(q('天空'));
  const tp = byTitle.data.posts;
  ok('标题命中：返回帖子', tp && tp.total >= 1, `total=${tp && tp.total}`);
  ok('命中标注含 title',
    tp.records.length > 0 && tp.records[0].matchedIn.includes('title'),
    JSON.stringify(tp.records[0] && tp.records[0].matchedIn));
  ok('帖子带 author（非 null）',
    tp.records.length > 0 && tp.records[0].author && tp.records[0].author.nickname,
    JSON.stringify(tp.records[0] && tp.records[0].author && tp.records[0].author.nickname));
  ok('帖子带已解析 tags 数组',
    tp.records.length > 0 && Array.isArray(tp.records[0].tags),
    `tags=${tp.records.length ? tp.records[0].tags.length : 0}`);

  // 2. 正文命中（关键词只出现在 content，不在 title）
  const byContent = await get(q('测试曲谱分类'));
  const cp = byContent.data.posts;
  ok('正文命中：返回帖子', cp && cp.total >= 1, `total=${cp && cp.total}`);
  ok('命中标注含 content',
    cp.records.length > 0 && cp.records[0].matchedIn.includes('content'),
    JSON.stringify(cp.records[0] && cp.records[0].matchedIn));

  // 3. 标签名命中（「翻弹」只存在于 tag 表，不在任何 title/content）
  const byTag = await get(q('翻弹'));
  const gp = byTag.data.posts;
  ok('标签名命中：返回帖子', gp && gp.total >= 1, `total=${gp && gp.total}`);
  ok('命中标注含 tag',
    gp.records.length > 0 && gp.records[0].matchedIn.includes('tag'),
    JSON.stringify(gp.records[0] && gp.records[0].matchedIn));
  ok('标签分组返回该标签',
    byTag.data.tags.some((t) => t.name === '翻弹'),
    JSON.stringify(byTag.data.tags.map((t) => t.name)));

  // 4. 作者昵称命中（「演示」只在 user.nickname）
  const byUser = await get(q('演示'));
  const up = byUser.data.posts;
  ok('作者命中：帖子分组非空', up && up.total >= 1, `total=${up && up.total}`);
  ok('命中标注含 user',
    up.records.length > 0 && up.records[0].matchedIn.includes('user'),
    JSON.stringify(up.records[0] && up.records[0].matchedIn));
  ok('用户分组返回演示用户',
    byUser.data.users.some((u) => u.nickname.includes('演示')),
    JSON.stringify(byUser.data.users.map((u) => u.nickname)));

  // 5. 用户名命中（zhangsan）
  const byName = await get(q('zhangsan'));
  ok('按用户名命中用户',
    byName.data.users.some((u) => u.username === 'zhangsan'),
    JSON.stringify(byName.data.users.map((u) => u.username)));

  // 6. 标签分组：搜「教」命中「教程」
  const byTagName = await get(q('教'), '&type=tag');
  ok('type=tag 只返回标签分组',
    byTagName.data.tags.some((t) => t.name === '教程')
      && byTagName.data.posts.total === 0
      && byTagName.data.users.length === 0,
    JSON.stringify(byTagName.data.tags.map((t) => t.name)));

  // 7. type=user 只查用户
  const userOnly = await get(q('演示'), '&type=user');
  ok('type=user 时帖子分组为空', userOnly.data.posts.total === 0 && userOnly.data.users.length >= 1,
    `posts=${userOnly.data.posts.total} users=${userOnly.data.users.length}`);

  // 8. type=post 只查帖子
  const postOnly = await get(q('天空'), '&type=post');
  ok('type=post 时用户/标签分组为空',
    postOnly.data.posts.total >= 1 && postOnly.data.users.length === 0 && postOnly.data.tags.length === 0,
    `posts=${postOnly.data.posts.total}`);

  // 9. 空关键词 → 全空（且不报错）
  const blank = await get('/api/search?keyword=');
  ok('空关键词返回空结果', blank.code === 0 && blank.data.posts.total === 0
    && blank.data.users.length === 0 && blank.data.tags.length === 0, 'code=' + blank.code);
  const noParam = await get('/api/search');
  ok('缺省 keyword 不报错', noParam.code === 0, 'code=' + noParam.code);

  // 10. 无命中
  const none = await get(q('zzz绝对不存在的关键词xyz'));
  ok('无命中时三组皆空', none.data.posts.total === 0 && none.data.users.length === 0 && none.data.tags.length === 0);

  // 11. size 上限（防拖库）
  const big = await get(q('天空', '&size=9999'));
  ok('size 被限制在 50 以内', big.data.posts.size <= 50, 'size=' + big.data.posts.size);

  // 12. 只返回 status=1：临时把一条帖下架 → 搜不到 → 再恢复（全程走接口，可逆）
  const login = await send('POST', '/api/auth/login', { username: 'admin', password: '123456' });
  const adminTok = login.code === 0 ? login.data.token : null;
  const pub = await get('/api/posts?page=1&size=1');
  const target = ((pub.data && pub.data.records) || [])[0];
  if (adminTok && target) {
    /* 后端 PageResult 的字段是 records（前端 api.js 才转成 list），id 是数字，统一转字符串比对 */
    const idsOf = (r) => (((r.data.posts || {}).records) || []).map((p) => String(p.id));
    try {
      const before = await get(q(target.title, '&size=50'));
      ok('下架前该帖出现在搜索结果中', idsOf(before).indexOf(String(target.id)) >= 0, 'id=' + target.id);

      const off = await send('PUT', `/api/admin/posts/${target.id}/status?status=2`, undefined, adminTok);
      ok('管理端下架接口可用', off.code === 0);

      const hidden = await get(q(target.title, '&size=50'));
      ok('下架帖从搜索结果中消失', idsOf(hidden).indexOf(String(target.id)) < 0, 'ids=' + JSON.stringify(idsOf(hidden)));
    } finally {
      await send('PUT', `/api/admin/posts/${target.id}/status?status=1`, undefined, adminTok);
    }
  } else {
    ok('管理端 token 与待测帖子均可用', false, `token=${!!adminTok} post=${!!target}`);
  }

  // 13. 热搜词：用真实关键词做增量断言（不制造脏词）
  const hotKw = '天空';
  const hotCount = (list) => { const hit = (list || []).find((x) => x.keyword === hotKw); return hit ? hit.count : 0; };
  const hot0 = await get('/api/search/hot?days=7&limit=50');
  ok('热搜接口可用且返回数组', hot0.code === 0 && Array.isArray(hot0.data), 'code=' + hot0.code);
  ok('热搜项含 keyword/count 字段',
    hot0.data.length === 0 || ('keyword' in hot0.data[0] && 'count' in hot0.data[0]),
    JSON.stringify(hot0.data[0] || null));
  const base = hotCount(hot0.data);

  await get(q(hotKw));            // 第 1 次新搜索
  await get(q(hotKw));            // 第 2 次新搜索
  const hot1 = await get('/api/search/hot?days=7&limit=50');
  ok('两次新搜索后热搜计数 +2', hotCount(hot1.data) === base + 2, `${base} → ${hotCount(hot1.data)}`);

  await get(q(hotKw, '&page=2'));    // 翻页：不该计数
  await get(q(hotKw, '&type=user')); // 切分组：不该计数
  const hot2 = await get('/api/search/hot?days=7&limit=50');
  ok('翻页 / 切分组不重复计数', hotCount(hot2.data) === base + 2, `${base} → ${hotCount(hot2.data)}`);

  console.log(`\n${fail === 0 ? '★ 搜索接口冒烟全部通过' : '✗ 有失败项'} (${pass}/${pass + fail})`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('ERR', e.message); process.exit(2); });
