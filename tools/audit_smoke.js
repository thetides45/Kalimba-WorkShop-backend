/**
 * 审核链路冒烟测试（WBS 4.7/4.8）。
 * 覆盖：敏感词拦截、举报防重、审核状态流转、处置通知、管理端权限。
 * 用法：node tools/audit_smoke.js   （前置：后端 8080 已启动）
 * 退出码 0=全绿。
 */
const BASE = 'http://localhost:8080';

async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['sa-token'] = token;
  const res = await fetch(BASE + path, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ...data };
}

const results = [];
function check(label, cond, extra = '') {
  const pass = !!cond;
  results.push(pass);
  console.log(`${pass ? '✓' : '✗'} ${label}${extra ? '  [' + extra + ']' : ''}`);
}

async function main() {
  // 登录
  const demo = await req('POST', '/api/auth/login', { username: 'demo', password: '123456' });
  const admin = await req('POST', '/api/auth/login', { username: 'admin', password: '123456' });
  check('登录 demo/admin', demo.code === 0 && admin.code === 0);
  const td = demo.data.token, ta = admin.data.token;

  // 1. 敏感词拦截
  const bad = await req('POST', '/api/posts', { title: '加微信领福利', content: '快来看' }, td);
  check('敏感词标题被拦（3002）', bad.code === 3002, `code=${bad.code}`);
  const bad2 = await req('POST', '/api/posts', { title: '正常标题', content: '正文里有赌博两个字试试' }, td);
  check('敏感词正文被拦（3002）', bad2.code === 3002, `code=${bad2.code}`);

  // 2. 正常发帖
  const title = '审核冒烟测试帖' + Date.now();
  const created = await req('POST', '/api/posts', { title, content: '审核链路测试正文' }, td);
  check('正常发帖成功', created.code === 0 && created.data && created.data.id, `id=${created.data && created.data.id}`);
  const postId = created.data && created.data.id;

  // 3. 举报 + 防重
  const rep1 = await req('POST', '/api/reports', { targetType: 'post', targetId: String(postId), reason: '测试举报' }, td);
  check('举报提交成功', rep1.code === 0, `code=${rep1.code}`);
  const rep2 = await req('POST', '/api/reports', { targetType: 'post', targetId: String(postId), reason: '再举报一次' }, td);
  check('重复举报被拦（4002）', rep2.code === 4002, `code=${rep2.code}`);
  const repBad = await req('POST', '/api/reports', { targetType: 'unknown', targetId: String(postId) }, td);
  check('非法 targetType 被拦（1001）', repBad.code === 1001, `code=${repBad.code}`);

  // 4. 管理端权限：demo 访问 admin 接口应被拒
  const deny = await req('GET', '/api/admin/stats', undefined, td);
  check('非管理员访问管理端被拒（6001）', deny.code === 6001, `code=${deny.code}`);

  // 5. 管理端:待审列表 + 举报列表
  const pending = await req('GET', '/api/admin/posts/pending', undefined, ta);
  check('管理端待审列表可达', pending.code === 0, `code=${pending.code}`);
  const reports = await req('GET', '/api/admin/reports?status=0', undefined, ta);
  check('管理端举报列表可达', reports.code === 0 && reports.data, `code=${reports.code}`);
  const reportId = reports.data && reports.data.records && reports.data.records[0] && reports.data.records[0].id;

  // 6. 下架帖子
  const down = await req('PUT', '/api/admin/posts/' + postId + '/status?status=2', undefined, ta);
  check('管理员下架帖子', down.code === 0, `code=${down.code}`);

  // 7. 下架后：详情 404、列表不含
  const detail = await req('GET', '/api/posts/' + postId);
  check('下架后帖子详情不可见（3001）', detail.code === 3001, `code=${detail.code}`);
  const list = await req('GET', '/api/posts?keyword=' + encodeURIComponent(title));
  check('下架后帖子不在列表', list.code === 0 && (!list.data || list.data.total === 0), `total=${list.data && list.data.total}`);

  // 8. 处置通知：作者收到下架通知
  const notif = await req('GET', '/api/notifications?page=1&size=20', undefined, td);
  const hasDown = notif.code === 0 && notif.data && notif.data.records &&
    notif.data.records.some((n) => n.type === 'system' && n.content && n.content.includes('已被下架'));
  check('作者收到下架系统通知（含 content）', !!hasDown);

  // 9. 处理举报 → 举报人收到通知
  if (reportId) {
    const handle = await req('PUT', '/api/admin/reports/' + reportId + '?status=1', undefined, ta);
    check('处理举报', handle.code === 0, `code=${handle.code}`);
    const notif2 = await req('GET', '/api/notifications?page=1&size=20', undefined, td);
    const hasHandled = notif2.code === 0 && notif2.data && notif2.data.records &&
      notif2.data.records.some((n) => n.type === 'system' && n.content && n.content.includes('举报'));
    check('举报人收到处理通知', !!hasHandled);
  } else {
    check('处理举报（无待处理举报，跳过）', false, 'reportId 未取到');
  }

  const fail = results.filter((r) => !r).length;
  console.log('\n========================================');
  console.log(`审核链路：${results.length} 项，通过 ${results.length - fail}，失败 ${fail}`);
  console.log(fail === 0 ? '★ 全部通过' : '✗ 有失败');
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => { console.error('脚本异常:', e); process.exitCode = 2; });
