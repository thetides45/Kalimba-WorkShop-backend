/**
 * 管理端接口冒烟（/api/admin/**）—— 纯 HTTP，不调用外部进程、不直连数据库。
 *
 * 覆盖：权限三态（匿名 / 普通用户 / 管理员）· 数据统计 · 用户列表与关键词搜索 ·
 *       封禁↔解除 · 帖子下架↔恢复 · **评论下架↔恢复（含级联回复）** ·
 *       **评论列表（B8：关键词 / 状态筛选、作者昵称与帖标题由服务端补齐）** ·
 *       **物理删评论的级联（B17：删一级评论时连带删掉它的回复）** ·
 *       **热榜缓存（B18：重建接口 · 预热后成员数与可见条数一致 · 下架立刻出榜 · 恢复回榜）** ·
 *       待审列表 · 举报列表与状态筛选 · 异常 id 的业务错误码。
 *
 * 为什么不用 mysql 命令造数据：本机环境下 Node 无法 spawn 外部程序（EBUSY），
 * 且测试应断言「可观察行为」。所有写操作都设计成**可逆**（下架→恢复、封禁→解除、
 * 评论自建自删），跑完自动复原，不留脏数据。
 *
 * 用法：先跑起后端（8080），再 node tools/admin_api_smoke.js
 */
const BASE = 'http://localhost:8080';

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
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`非 JSON 响应：${method} ${path} → HTTP ${res.status}，body=${text.slice(0, 160)}`);
  }
}
async function login(username, password) {
  const r = await req('POST', '/api/auth/login', { username, password });
  return r.code === 0 ? r.data.token : null;
}

(async () => {
  /* ================= 权限三态 ================= */
  const anon = await req('GET', '/api/admin/stats');
  ok('未登录访问管理端被拒', anon.code !== 0, 'code=' + anon.code);

  const userTok = await login('demo', '123456');
  ok('普通用户可登录', !!userTok);
  const asUser = await req('GET', '/api/admin/stats', undefined, userTok);
  ok('普通用户访问管理端被拒（角色校验）', asUser.code !== 0, 'code=' + asUser.code + ' ' + asUser.message);

  const adminTok = await login('admin', '123456');
  ok('管理员可登录', !!adminTok);

  /* ================= 统计 ================= */
  const stats = await req('GET', '/api/admin/stats', undefined, adminTok);
  ok('统计接口可用', stats.code === 0 && stats.data && 'users' in stats.data, JSON.stringify(stats.data));

  /* ================= 用户列表（本轮新增） ================= */
  const users = await req('GET', '/api/admin/users?page=1&size=10', undefined, adminTok);
  const urows = (users.data && users.data.records) || [];
  ok('用户列表可用', users.code === 0 && Array.isArray(urows), 'total=' + (users.data && users.data.total));
  ok('用户行含 role / status 字段',
    urows.length > 0 && 'role' in urows[0] && 'status' in urows[0],
    urows.length ? JSON.stringify({ role: urows[0].role, status: urows[0].status }) : '');
  ok('用户列表不泄露 passwordHash',
    urows.every((u) => !('passwordHash' in u) && !('password_hash' in u)));

  const usersKw = await req('GET', '/api/admin/users?page=1&size=10&keyword=' + encodeURIComponent('zhangsan'), undefined, adminTok);
  const zs = ((usersKw.data && usersKw.data.records) || [])[0];
  ok('用户列表支持按用户名搜', usersKw.code === 0 && !!zs, '命中=' + (zs ? zs.nickname : '无'));

  /* ---- 封禁 / 解除（可逆） ---- */
  if (zs) {
    try {
      const ban = await req('PUT', `/api/admin/users/${zs.id}/status?status=0`, undefined, adminTok);
      ok('封禁接口可用', ban.code === 0);
      const afterBan = await req('GET', '/api/admin/users?page=1&size=10&keyword=zhangsan', undefined, adminTok);
      ok('封禁后列表显示 status=0', afterBan.data.records[0].status === 0);
      const inSearch = await req('GET', '/api/search?keyword=zhangsan&type=user');
      ok('封禁用户不再出现在搜索的用户组', inSearch.data.users.length === 0, 'users=' + inSearch.data.users.length);

      const unban = await req('PUT', `/api/admin/users/${zs.id}/status?status=1`, undefined, adminTok);
      ok('解除封禁接口可用', unban.code === 0);
      const afterUnban = await req('GET', '/api/admin/users?page=1&size=10&keyword=zhangsan', undefined, adminTok);
      ok('解除后恢复 status=1', afterUnban.data.records[0].status === 1);
    } catch (e) {
      /* 中途失败也要把状态复位，避免污染后续测试 */
      if (zs && adminTok) await req('PUT', `/api/admin/users/${zs.id}/status?status=1`, undefined, adminTok).catch(() => {});
      throw e;
    }
  } else {
    skip('用户封禁 / 解除', '库里没有 zhangsan');
  }

  /* ================= 帖子下架 / 恢复（可逆） ================= */
  const list = await req('GET', '/api/posts?page=1&size=1');
  const target = ((list.data && list.data.records) || [])[0];
  ok('公开帖列表可取一条用于状态测试', !!target, target ? '#' + target.id : '无');
  if (target) {
    try {
      const off = await req('PUT', `/api/admin/posts/${target.id}/status?status=2`, undefined, adminTok);
      ok('帖子下架接口可用', off.code === 0);
      const gone = await req('GET', '/api/posts/' + target.id);
      ok('下架后帖子对公开接口不可见', gone.code !== 0, 'code=' + gone.code);

      const on = await req('PUT', `/api/admin/posts/${target.id}/status?status=1`, undefined, adminTok);
      ok('帖子恢复接口可用', on.code === 0);
      const back = await req('GET', '/api/posts/' + target.id);
      ok('恢复后帖子重新可见', back.code === 0, 'code=' + back.code);
    } catch (e) {
      await req('PUT', `/api/admin/posts/${target.id}/status?status=1`, undefined, adminTok).catch(() => {});
      throw e;
    }
  }

  /* ================= 热榜缓存：预热 / 失效 / 过滤 / 重建（缺口 B18） ================= */
  /* 自建一篇测试帖走完整条链路，净变化为零：
       建帖 → 重建缓存 → 浏览（进榜）→ 下架（出榜）→ 恢复（回榜）→ 删帖（出榜）。
     ⚠️ 热榜是**全局共享状态**（整个库共用一个 ZSet），所以断言一律写「本篇在不在」
        和「两个集合是否一致」，**绝不写死条数或名次** —— 别的脚本跑一轮就会改分数。 */
  const hotPost = await req('POST', '/api/posts',
    { title: '热榜断言帖', content: 'B18 热榜缓存断言', tagIds: [7] }, userTok);
  const hid = (hotPost.data && hotPost.data.id) || null;
  ok('建热榜断言帖', hotPost.code === 0 && !!hid, 'id=' + hid);
  /* post-mode=auto 时新帖即 status=1。若将来改成 pre，这条会先红 —— 提醒下面的断言前提变了。 */
  ok('新帖初始 status=1（热榜断言的前提）',
    !!hid && hotPost.data.status === 1, 'status=' + (hotPost.data && hotPost.data.status));
  if (hid) {
    try {
      /* ---------- ① 重建：删键重灌（「键在但内容脏」的正解） ---------- */
      const rbDeny = await req('POST', '/api/admin/hot/rebuild', undefined, userTok);
      ok('非管理员不能重建热榜缓存', rbDeny.code !== 0, 'code=' + rbDeny.code);
      const rb = await req('POST', '/api/admin/hot/rebuild', undefined, adminTok);
      ok('管理员可重建热榜缓存（返回成员数）',
        rb.code === 0 && typeof rb.data === 'number' && rb.data > 0,
        'code=' + rb.code + ' 成员数=' + rb.data);

      /* ---------- ② 预热/回灌生效，且榜与「可见帖集合」完全一致 ---------- */
      const hot1 = await req('GET', '/api/hot?limit=50');
      const rows1 = hot1.data || [];
      ok('重建后热榜非空（历史热度被灌了回来）', hot1.code === 0 && rows1.length > 0, rows1.length + ' 条');
      ok('★ 热榜成员数 == 可见条数（ZSet 里没有孤儿 / 下架帖）',
        rb.data === rows1.length, 'ZSet=' + rb.data + ' 可见=' + rows1.length);
      const scoreOf = (p) => (p.likeCount || 0) * 8 + (p.viewCount || 0);
      const maxScore = rows1.length ? Math.max(...rows1.map(scoreOf)) : 0;
      ok('热榜首条确实是分数最高者（点赞×8+浏览；自洽检查，不依赖具体数据）',
        rows1.length > 0 && scoreOf(rows1[0]) === maxScore,
        '首条 #' + (rows1[0] && rows1[0].id) + ' 分数=' + (rows1[0] && scoreOf(rows1[0])));
      ok('热榜里全部是 status=1（已下架不泄漏）',
        rows1.length > 0 && rows1.every((p) => p.status === 1),
        rows1.filter((p) => p.status !== 1).length + ' 条异常');

      /* ---------- ③ 浏览一次 → 进榜 ---------- */
      await req('GET', '/api/posts/' + hid);
      const hot2 = await req('GET', '/api/hot?limit=50');
      ok('浏览一次后本篇进入热榜', (hot2.data || []).some((p) => p.id === hid),
        'ids=' + (hot2.data || []).map((p) => p.id).join(','));

      /* ---------- ④ 下架 → 立刻出榜（不等任何过期） ---------- */
      const off2 = await req('PUT', `/api/admin/posts/${hid}/status?status=2`, undefined, adminTok);
      ok('本篇下架成功', off2.code === 0);
      const hot3 = await req('GET', '/api/hot?limit=50');
      ok('★ 下架后本篇立刻出榜（sync → drop 生效）',
        !(hot3.data || []).some((p) => p.id === hid),
        'ids=' + (hot3.data || []).map((p) => p.id).join(','));

      /* ---------- ⑤ 恢复 → 回榜（分数由库回填，不是从 0 累加） ---------- */
      const on2 = await req('PUT', `/api/admin/posts/${hid}/status?status=1`, undefined, adminTok);
      ok('本篇恢复成功', on2.code === 0);
      const hot4 = await req('GET', '/api/hot?limit=50');
      ok('★ 恢复后本篇回到热榜（分数由库里的指标回填）',
        (hot4.data || []).some((p) => p.id === hid),
        'ids=' + (hot4.data || []).map((p) => p.id).join(','));

      /* ---------- ⑥ 删帖 → 出榜 ---------- */
      /* ⚠️ 这条只保「用户看不到已删帖」的底线：即使 drop 失效，loadOrdered 回库补全时也会
         因为查不到而丢掉它。drop 那个「不占 reverseRange 名额」的效果在纯 HTTP 下不好构造
         （需要一个高分的已删帖），改由上面 ② 的「ZSet 成员数 == 可见条数」间接守着。 */
      const del2 = await req('DELETE', '/api/posts/' + hid, undefined, userTok);
      ok('删帖成功', del2.code === 0);
      const hot5 = await req('GET', '/api/hot?limit=50');
      ok('删帖后本篇不在热榜', !(hot5.data || []).some((p) => p.id === hid),
        'ids=' + (hot5.data || []).map((p) => p.id).join(','));
    } finally {
      /* 兜底：中途失败也要清掉测试帖，别污染公开列表 */
      await req('DELETE', '/api/posts/' + hid, undefined, userTok).catch(() => {});
    }
  }

  /* ================= 评论下架 / 恢复 / 级联（可逆；缺口 B2） ================= */
  /* 全程用**自建评论**：发「一级评论 + 回复」→ 测 → 物理删掉，净变化为零。
     刻意优先挑 demo **自己发的帖子**：评论自己的帖子不会触发通知
     （CommentService.create 里 toUserId.equals(senderId) 直接 return）；
     退化成别人的帖子时最多会留 2 条通知（notification 表没有删除接口）。 */
  const morePosts = await req('GET', '/api/posts?page=1&size=20');
  const allPosts = (morePosts.data && morePosts.data.records) || [];
  const demoPost = allPosts.find((p) => String((p.author && p.author.id) || p.userId) === '2') || allPosts[0];
  ok('取得一篇用于评论状态测试的帖子', !!demoPost, demoPost ? '#' + demoPost.id : '无');
  if (demoPost && userTok) {
    let ca = null, cb = null;
    try {
      const ra = await req('POST', `/api/posts/${demoPost.id}/comments`, { content: 'B2 冒烟-一级评论' }, userTok);
      ca = ra.data && ra.data.id;
      ok('可发一级评论（为下架测试造数据）', ra.code === 0 && !!ca, 'id=' + ca);

      const rb = await req('POST', `/api/posts/${demoPost.id}/comments`, { content: 'B2 冒烟-回复', parentId: ca }, userTok);
      cb = rb.data && rb.data.id;
      ok('可在其下发回复', rb.code === 0 && !!cb, 'id=' + cb);

      const deny = await req('PUT', `/api/admin/comments/${ca}/status?status=0`, undefined, userTok);
      ok('非管理员不能下架评论', deny.code !== 0, 'code=' + deny.code);

      const off = await req('PUT', `/api/admin/comments/${ca}/status?status=0`, undefined, adminTok);
      ok('评论下架接口可用', off.code === 0);
      const listOff = await req('GET', `/api/posts/${demoPost.id}/comments?page=1&size=100`);
      const leftOff = ((listOff.data && listOff.data.records) || []).map((c) => c.id);
      ok('下架后一级评论从公开列表消失', leftOff.indexOf(ca) < 0);
      ok('下架一级评论时级联下架其回复', cb != null && leftOff.indexOf(cb) < 0, '回复 id=' + cb);

      const on = await req('PUT', `/api/admin/comments/${ca}/status?status=1`, undefined, adminTok);
      ok('评论恢复接口可用', on.code === 0);
      const listOn = await req('GET', `/api/posts/${demoPost.id}/comments?page=1&size=100`);
      const leftOn = ((listOn.data && listOn.data.records) || []).map((c) => c.id);
      ok('恢复后一级评论重新可见', leftOn.indexOf(ca) >= 0);
      ok('恢复一级评论时级联恢复其回复', cb != null && leftOn.indexOf(cb) >= 0, '回复 id=' + cb);

      /* ★ B17：**物理删除**的级联 —— 删掉一级评论，它下面的回复也该一起没。
         与上面「下架」的软删级联是两套机制（那是改 status，这是真删），
         两条路径都各有断言，别只测一条。 */
      const delA = await req('DELETE', `/api/posts/${demoPost.id}/comments/${ca}`, undefined, userTok);
      ok('物理删除一级评论成功', delA.code === 0, 'code=' + delA.code);
      const afterDel = await req('GET', `/api/posts/${demoPost.id}/comments?page=1&size=100`);
      const leftDel = ((afterDel.data && afterDel.data.records) || []).map((c) => c.id);
      ok('★ 物理删一级评论时级联删掉它的回复（B17）',
        leftDel.indexOf(ca) < 0 && leftDel.indexOf(cb) < 0,
        `一级=${leftDel.indexOf(ca) < 0 ? '已删' : '仍在'} 回复=${leftDel.indexOf(cb) < 0 ? '已删' : '仍在'}`);
      ca = null; cb = null;   /* 已被级联一起删掉，finally 不需要再删 */
    } finally {
      /* 收尾：失败路径可能把状态留在「已下架」，先无条件复位；再删掉可能残留的测试评论。
         正常路径上这两条已被上面那步级联删除（并已把 ca/cb 置 null）。 */
      if (ca) await req('PUT', `/api/admin/comments/${ca}/status?status=1`, undefined, adminTok).catch(() => {});
      if (cb) await req('DELETE', `/api/posts/${demoPost.id}/comments/${cb}`, undefined, userTok).catch(() => {});
      if (ca) await req('DELETE', `/api/posts/${demoPost.id}/comments/${ca}`, undefined, userTok).catch(() => {});
    }
  } else {
    skip('评论下架 / 恢复 / 级联', '没有可用帖子或登录态');
  }

  const ghostCmt = await req('PUT', '/api/admin/comments/999999999/status?status=0', undefined, adminTok);
  ok('下架不存在的评论返回业务错误', ghostCmt.code !== 0, 'code=' + ghostCmt.code);

  /* ================= 评论列表（B8：管理端终于能"找到评论"） ================= */
  const cmtList = await req('GET', '/api/admin/comments?page=1&size=5', undefined, adminTok);
  const crows = (cmtList.data && cmtList.data.records) || [];
  ok('评论列表可用（B8）', cmtList.code === 0 && Array.isArray(crows), 'total=' + (cmtList.data && cmtList.data.total));
  ok('评论行含作者昵称与所属帖子标题（服务端补齐，前端零拼接）',
    crows.length > 0 && 'nickname' in crows[0] && 'postTitle' in crows[0],
    crows.length ? JSON.stringify({ nickname: crows[0].nickname, postTitle: crows[0].postTitle }) : '');

  const cmtDeny = await req('GET', '/api/admin/comments?page=1&size=5', undefined, userTok);
  ok('非管理员不能读评论列表', cmtDeny.code !== 0, 'code=' + cmtDeny.code);

  const cmtOff = await req('GET', '/api/admin/comments?page=1&size=20&status=0', undefined, adminTok);
  ok('评论按 status=0（已下架）过滤生效',
    cmtOff.code === 0 && (cmtOff.data.records || []).every((c) => c.status === 0),
    'total=' + (cmtOff.data && cmtOff.data.total));

  const cmtOn = await req('GET', '/api/admin/comments?page=1&size=20&status=1', undefined, adminTok);
  ok('评论按 status=1（正常）过滤生效',
    cmtOn.code === 0 && (cmtOn.data.records || []).every((c) => c.status === 1),
    'total=' + (cmtOn.data && cmtOn.data.total));

  /* 关键词两条路都验（内容 / 作者昵称）。片段从列表首行现取，不硬编码业务词。 */
  if (crows.length) {
    const snippet = String(crows[0].content || '').slice(0, 4);
    const byKw = await req('GET', '/api/admin/comments?page=1&size=20&keyword=' + encodeURIComponent(snippet), undefined, adminTok);
    ok('评论按**内容**关键词筛生效',
      byKw.code === 0 && (byKw.data.records || []).length > 0,
      'kw=' + snippet + ' 命中=' + (byKw.data && byKw.data.records.length));

    const byNick = await req('GET', '/api/admin/comments?page=1&size=20&keyword=' + encodeURIComponent(crows[0].nickname), undefined, adminTok);
    ok('评论按**作者昵称**筛生效（跨表那一路）',
      byNick.code === 0 && (byNick.data.records || []).length > 0,
      'kw=' + crows[0].nickname + ' 命中=' + (byNick.data && byNick.data.records.length));
  }

  const noHit = await req('GET', '/api/admin/comments?page=1&size=20&keyword=' + encodeURIComponent('zzz绝对不存在xyz'), undefined, adminTok);
  ok('评论关键词无命中时返回空列表（而不是报错）',
    noHit.code === 0 && (noHit.data.records || []).length === 0, 'total=' + (noHit.data && noHit.data.total));

  /* ================= 待审列表（只读） ================= */
  const pending = await req('GET', '/api/admin/posts/pending?page=1&size=10', undefined, adminTok);
  ok('待审列表可用且结构正确',
    pending.code === 0 && pending.data && Array.isArray(pending.data.records),
    'total=' + (pending.data && pending.data.total));

  /* ================= 举报列表 + 状态过滤（只读） ================= */
  const allReports = await req('GET', '/api/admin/reports?page=1&size=10', undefined, adminTok);
  ok('举报列表可用', allReports.code === 0 && Array.isArray(allReports.data.records), 'total=' + allReports.data.total);

  const waitReports = await req('GET', '/api/admin/reports?page=1&size=10&status=0', undefined, adminTok);
  ok('举报按 status=0 过滤生效',
    waitReports.code === 0 && waitReports.data.records.every((r) => r.status === 0),
    'total=' + waitReports.data.total);

  const doneReports = await req('GET', '/api/admin/reports?page=1&size=10&status=1', undefined, adminTok);
  ok('举报按 status=1 过滤生效',
    doneReports.code === 0 && doneReports.data.records.every((r) => r.status === 1),
    'total=' + doneReports.data.total);

  /* 处理举报：用不存在的 id 验证端点已接通 + 异常路径正常（不造脏数据） */
  const ghost = await req('PUT', '/api/admin/reports/999999999?status=1', undefined, adminTok);
  ok('处理举报对不存在的 id 返回业务错误', ghost.code !== 0, 'code=' + ghost.code + ' ' + ghost.message);

  const ghostUser = await req('PUT', '/api/admin/users/999999999/status?status=0', undefined, adminTok);
  ok('封禁不存在的用户返回业务错误', ghostUser.code !== 0, 'code=' + ghostUser.code);

  console.log(`\n${fail === 0 ? '★ 管理端接口冒烟全部通过' : '✗ 有失败项'} (${pass}/${pass + fail}${skipped ? '，跳过 ' + skipped : ''})`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('ERR', e.message); process.exit(2); });
