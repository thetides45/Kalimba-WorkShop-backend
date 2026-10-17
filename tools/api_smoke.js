#!/usr/bin/env node
/**
 * 前后端联调自测脚本（针对已启动的后端 http://localhost:8080）。
 * 覆盖：认证 / 分类字典 / 发帖 / 列表 / 互动 / 通知，按链路顺序打印结果。
 * 用法：node tools/api_smoke.js
 */
const BASE = 'http://localhost:8080';

async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['sa-token'] = token;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ...data };
}

function ok(r, label) {
  const pass = r.code === 0;
  console.log(`${pass ? '✓' : '✗'} ${label}  -> code=${r.code} ${r.message || ''}${pass ? '' : ' ' + JSON.stringify(r)}`);
  return pass;
}

async function main() {
  let allOk = true;

  // 1. 分类字典（公开）
  const cat = await req('GET', '/api/meta/categories');
  allOk &= ok(cat, '分类字典（含纯音乐）');
  if (cat.data) {
    console.log(`     postTags=${cat.data.postTags.length}  tuningTypes=${cat.data.tuningTypes.length}  keyNames=${cat.data.keyNames.length}  difficulties=${cat.data.difficulties.length}  musicGenres=${cat.data.musicGenres.length}`);
    console.log('     musicGenres 含纯音乐:', cat.data.musicGenres.some(g => g.code === 'pure'));
  }

  // 2. 登录 demo
  const login = await req('POST', '/api/auth/login', { username: 'demo', password: '123456' });
  allOk &= ok(login, '登录 demo/123456');
  const token = login.data && login.data.token;

  // 3. 登录 admin
  const admin = await req('POST', '/api/auth/login', { username: 'admin', password: '123456' });
  allOk &= ok(admin, '登录 admin（role=admin）');
  console.log('     admin role =', admin.data && admin.data.role);

  // 4. 发帖（带曲谱分类）
  const post = await req('POST', '/api/posts', {
    title: '《天空之城》卡林巴谱',
    content: '第一次发帖，测试曲谱分类。',
    tagIds: [7, 10],
  }, token);
  allOk &= ok(post, '发布帖子');
  const postId = post.data && post.data.id;
  console.log('     postId =', postId);

  // 5. 帖子列表（公开）
  const list = await req('GET', '/api/posts?page=1&size=10');
  allOk &= ok(list, '帖子列表');
  console.log('     total =', list.data && list.data.total);

  // 6. 帖子详情
  const detail = await req('GET', '/api/posts/' + postId);
  allOk &= ok(detail, '帖子详情（浏览量+1）');
  console.log('     viewCount =', detail.data && detail.data.viewCount);

  // 7. 点赞
  const like = await req('POST', '/api/posts/' + postId + '/likes', undefined, token);
  allOk &= ok(like, '点赞');
  const like2 = await req('POST', '/api/posts/' + postId + '/likes', undefined, token);
  const passDup = like2.code === 4001;
  console.log(`${passDup ? '✓' : '✗'} 重复点赞幂等拦截  -> code=${like2.code}（应 4001）`);
  allOk &= passDup;

  // 8. 收藏
  const fav = await req('POST', '/api/posts/' + postId + '/favorite', undefined, token);
  allOk &= ok(fav, '收藏');

  // 9. 评论
  const comment = await req('POST', '/api/posts/' + postId + '/comments', { content: '好谱，收藏了！' }, token);
  allOk &= ok(comment, '发表评论');

  // 10. 通知列表（demo 自己发帖，点赞/评论是自己，不产生通知，但列表接口要通）
  const notif = await req('GET', '/api/notifications', undefined, token);
  allOk &= ok(notif, '通知列表');

  // 11. 未登录访问受保护接口（应 2001）
  const unauth = await req('GET', '/api/notifications');
  const passUnauth = unauth.code === 2001;
  console.log(`${passUnauth ? '✓' : '✗'} 未登录访问受保护接口  -> code=${unauth.code}（应 2001）`);
  allOk &= passUnauth;

  console.log('\n========================================');
  console.log(allOk ? '★ 联调全部通过' : '✗ 存在失败，见上方 ✗ 项');
  process.exit(allOk ? 0 : 1);
}

main().catch(e => { console.error('联调脚本异常:', e); process.exit(2); });
