/**
 * 审核记录（操作日志）接口冒烟 —— 纯 HTTP，不 spawn 外部进程、不直连数据库。
 *
 * 覆盖：
 *   ① 权限三态：未登录 / 普通用户 / 管理员
 *   ② 落库：管理员做一次「改帖子状态」（下架→恢复，可逆）后，日志里**新增**了对应记录
 *   ③ 失败也记：对不存在的帖子 id 操作，落一条 success=0 且带 errorMsg 的记录
 *   ④ 三个筛选：action 精确 / success 成败 / keyword 模糊匹配用户名与 URI
 *   ⑤ 排序稳定：created_at DESC + id DESC（同秒多条也不会翻页重复/漏行）
 *   ⑥ /api/admin/logs/actions 从数据反查操作类型
 *
 * 为什么断言「增量」而不是「总数」：库里可能已有历史日志（别的冒烟留下的），
 * 断总数会随环境漂移。这里改用「操作前后的最大 id」作水位线，只断言水位线之上新增了什么。
 *
 * 前置：后端 8080 已启动。用法：node tools/admin_log_smoke.js
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
  return r.code === 0 ? r.data.token : null;
}
/* 取当前日志水位线（最新一条的 id）。空表返回 0。 */
async function watermark(token) {
  const r = await req('GET', '/api/admin/logs?page=1&size=1', undefined, token);
  const rows = (r.data && r.data.records) || [];
  return rows.length ? Number(rows[0].id) : 0;
}
/* 复合筛选取列表（返回 records 数组） */
async function logs(token, qs) {
  const r = await req('GET', '/api/admin/logs?page=1&size=50' + (qs ? '&' + qs : ''), undefined, token);
  return { code: r.code, message: r.message, total: r.data && r.data.total, rows: (r.data && r.data.records) || [] };
}

(async () => {
  /* ================= ① 权限三态 ================= */
  const anon = await req('GET', '/api/admin/logs');
  ok('未登录访问审核记录被拒', anon.code !== 0, 'code=' + anon.code);

  const userTok = await login('demo', '123456');
  ok('普通用户可登录', !!userTok);
  if (userTok) {
    const asUser = await req('GET', '/api/admin/logs', undefined, userTok);
    ok('普通用户访问审核记录被拒（角色校验）', asUser.code !== 0, 'code=' + asUser.code + ' ' + asUser.message);
  }

  const adminTok = await login('admin', '123456');
  ok('管理员可登录', !!adminTok);
  if (!adminTok) { console.log('\n✗ 无法登录管理员，后续断言跳过'); process.exit(1); }

  /* ================= ② 结构与字段 ================= */
  const list0 = await logs(adminTok);
  ok('审核记录列表可用', list0.code === 0 && Array.isArray(list0.rows), 'total=' + list0.total);
  if (list0.rows.length) {
    const x = list0.rows[0];
    const need = ['id', 'action', 'method', 'uri', 'success', 'createdAt'];
    const missing = need.filter((k) => !(k in x));
    ok('日志行字段齐全（id/action/method/uri/success/createdAt）', missing.length === 0,
      missing.length ? '缺 ' + missing.join(',') : JSON.stringify({ action: x.action, success: x.success }));
  } else {
    skip('日志行字段检查', '库里还没有任何日志（后续动作会写入）');
  }

  const before = await watermark(adminTok);

  /* ================= ③ 成功操作落库（可逆：下架 → 恢复） ================= */
  const plist = await req('GET', '/api/posts?page=1&size=1');
  const target = ((plist.data && plist.data.records) || [])[0];
  ok('公开帖列表可取一条用于操作', !!target, target ? '#' + target.id : '无');
  if (target) {
    let done = false;
    try {
      const off = await req('PUT', `/api/admin/posts/${target.id}/status?status=2`, undefined, adminTok);
      ok('帖子下架接口可用（同时应产生日志）', off.code === 0);

      const afterOff = await logs(adminTok, 'action=' + encodeURIComponent('管理-改帖子状态'));
      const fresh = afterOff.rows.filter((r) => Number(r.id) > before);
      ok('下架操作写入了「管理-改帖子状态」日志', fresh.length >= 1, '新增 ' + fresh.length + ' 条');
      if (fresh.length) {
        const top = fresh[0];
        ok('日志记到了操作者用户名（admin 快照）', top.username === 'admin', 'username=' + top.username);
        ok('日志记为成功', top.success === 1, 'success=' + top.success);
        ok('日志记到了具体对象（URI 含帖子 id）', String(top.uri).indexOf('/posts/' + target.id) >= 0,
          top.method + ' ' + top.uri);
        ok('日志记到了耗时（@OpLog 默认 timing=true）', typeof top.durationMs === 'number',
          'durationMs=' + top.durationMs);
      }

      const on = await req('PUT', `/api/admin/posts/${target.id}/status?status=1`, undefined, adminTok);
      ok('帖子恢复接口可用（可逆动作已完成）', on.code === 0);
      done = true;
    } finally {
      if (!done) {
        /* 中途失败也要复位，避免把帖子停在「下架」状态 */
        await req('PUT', `/api/admin/posts/${target.id}/status?status=1`, undefined, adminTok).catch(() => {});
      }
    }
  }

  /* ================= ④ 失败也落库 ================= */
  const ghost = await req('PUT', '/api/admin/posts/999999999/status?status=2', undefined, adminTok);
  ok('对不存在的帖子操作返回业务错误', ghost.code !== 0, 'code=' + ghost.code);
  const failRows = await logs(adminTok, 'success=0');
  ok('success=0 过滤生效（全部为失败）', failRows.code === 0 && failRows.rows.every((r) => r.success === 0),
    '失败记录 ' + failRows.rows.length + ' 条');
  const ghostLog = failRows.rows.filter((r) => Number(r.id) > before && String(r.uri).indexOf('999999999') >= 0);
  ok('失败的操作也写入了日志且带失败原因', ghostLog.length >= 1,
    ghostLog.length ? 'errorMsg=' + ghostLog[0].errorMsg : '未找到对应失败日志');

  /* ================= ⑤ 筛选 ================= */
  const actRows = await logs(adminTok, 'action=' + encodeURIComponent('管理-改帖子状态'));
  ok('action 精确筛选生效',
    actRows.code === 0 && actRows.rows.length > 0 && actRows.rows.every((r) => r.action === '管理-改帖子状态'),
    '命中 ' + actRows.rows.length + ' 条');

  const kwUser = await logs(adminTok, 'keyword=admin');
  ok('keyword 可按操作者用户名模糊匹配',
    kwUser.code === 0 && kwUser.rows.length > 0 && kwUser.rows.every((r) => String(r.username || '').indexOf('admin') >= 0),
    '命中 ' + kwUser.rows.length + ' 条');

  const kwUri = await logs(adminTok, 'keyword=' + encodeURIComponent('/api/admin/posts'));
  ok('keyword 可按接口路径模糊匹配',
    kwUri.code === 0 && kwUri.rows.length > 0 && kwUri.rows.every((r) => String(r.uri).indexOf('/api/admin/posts') >= 0),
    '命中 ' + kwUri.rows.length + ' 条');

  const combo = await logs(adminTok, 'action=' + encodeURIComponent('管理-改帖子状态') + '&success=1');
  ok('action + success 组合筛选生效',
    combo.code === 0 && combo.rows.every((r) => r.action === '管理-改帖子状态' && r.success === 1),
    '命中 ' + combo.rows.length + ' 条');

  /* ================= ⑥ 排序稳定 / 翻页不重不漏 ================= */
  const p1 = await logs(adminTok, '');
  const ids = p1.rows.map((r) => Number(r.id));
  const desc = ids.every((v, i) => i === 0 || ids[i - 1] >= v);
  ok('列表按 id 倒序（created_at DESC + id DESC 的体现）', ids.length === 0 || desc,
    ids.slice(0, 5).join(' > '));

  const s1 = await req('GET', '/api/admin/logs?page=1&size=1', undefined, adminTok);
  const s2 = await req('GET', '/api/admin/logs?page=2&size=1', undefined, adminTok);
  const id1 = ((s1.data && s1.data.records) || [])[0];
  const id2 = ((s2.data && s2.data.records) || [])[0];
  if (id1 && id2) {
    ok('翻页不重复（size=1 时第 1、2 页 id 不同）', Number(id1.id) !== Number(id2.id),
      `p1=${id1.id} p2=${id2.id}`);
    ok('翻页顺序正确（第 1 页 id 更大 = 更新）', Number(id1.id) > Number(id2.id));
  } else {
    skip('翻页断言', '日志条数不足 2 条');
  }

  /* ================= ⑦ 操作类型清单（从数据反查） ================= */
  const acts = await req('GET', '/api/admin/logs/actions', undefined, adminTok);
  ok('操作类型清单可用且是数组', acts.code === 0 && Array.isArray(acts.data), '类型数=' + (acts.data || []).length);
  ok('清单包含刚写入的「管理-改帖子状态」', Array.isArray(acts.data) && acts.data.includes('管理-改帖子状态'),
    JSON.stringify((acts.data || []).slice(0, 4)));

  const anonActs = await req('GET', '/api/admin/logs/actions');
  ok('操作类型清单同样受管理员校验保护', anonActs.code !== 0, 'code=' + anonActs.code);

  console.log(`\n${fail === 0 ? '★ 审核记录冒烟全部通过' : '✗ 有失败项'} (${pass}/${pass + fail}${skipped ? '，跳过 ' + skipped : ''})`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('ERR', e.message); process.exit(2); });
