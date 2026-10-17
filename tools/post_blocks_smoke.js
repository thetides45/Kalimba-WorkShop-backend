/* 正文块（路线 B）验收冒烟 —— 2026-10-16
 *
 * 前置：后端 8080 在跑。账号：demo / 123456。
 *
 * 覆盖：
 *   ① 合法块（text / image / divider / score）能存能取，字段与类型原样往返
 *   ② 夹带的未知字段被**丢弃**（白名单是"逐块重建"，不是"原样透传"）
 *   ③ 未知 type 被拒（1001）
 *   ④ image.url 非 /uploads/img/ 开头被拒 —— 外链、javascript:、data: 三种都试
 *   ⑤ 超长文本块、超量块数、score 的 fileId 非数字 → 都拒
 *   ⑥ 含 <script> 的文本**被当纯文本正常存下**（不报错、也不被转义掉——安全交给前端渲染）
 *   ⑦ update 的语义：不带 blocks = 不改动；带 [] = 清空
 *   ⑧ 老帖子（blocks 为 NULL）detail 里 blocks 为空
 *
 * 收尾：删掉测试帖。
 */
const API = 'http://localhost:8080';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (detail ? '   [' + detail + ']' : '')); }
}
async function req(method, path, body, token) {
  const h = {};
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h['sa-token'] = token;
  const r = await fetch(API + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t) } catch (e) {}
  return { http: r.status, code: j ? j.code : null, message: j ? j.message : '', data: j ? j.data : null };
}
const parseBlocks = (raw) => { try { return JSON.parse(raw) } catch (e) { return null } };

(async () => {
  const lj = await req('POST', '/api/auth/login', { username: 'demo', password: '123456' });
  if (lj.code !== 0) { console.error('登录失败，后端没起？'); process.exit(1); }
  const token = lj.data.token;
  console.log('登录 demo 成功\n');

  const TITLE = 'ZZ块冒烟-' + Date.now();
  const legal = [
    { type: 'text', text: '第一段正文，含换行\n第二行。' },
    { type: 'divider' },
    { type: 'image', url: '/uploads/img/test-abc.jpg', caption: '一张图' },
    { type: 'score', fileId: '35', title: '小星星' },
    { type: 'text', text: '结尾段。', evilField: 'should-be-dropped', onclick: 'alert(1)' },
  ];

  const ca = await req('POST', '/api/posts', { title: TITLE, content: '纯文本回退用', tagIds: [], blocks: legal }, token);
  ok('① 建帖（带 5 个合法块）成功', ca.code === 0, 'code=' + ca.code + ' ' + ca.message);
  const id = ca.data && ca.data.id;
  if (!id) { console.error('没拿到 id，后续无法继续'); process.exit(1); }

  const d1 = await req('GET', '/api/posts/' + id);
  const b1 = parseBlocks(d1.data && d1.data.blocks);
  ok('① detail 返回 blocks 且能解析成数组', Array.isArray(b1), 'raw=' + String(d1.data && d1.data.blocks).slice(0, 80));
  if (Array.isArray(b1)) {
    ok('① 块数 = 5', b1.length === 5, '实际 ' + b1.length);
    ok('① text 块字段正确', b1[0] && b1[0].type === 'text' && b1[0].text === legal[0].text, JSON.stringify(b1[0]));
    ok('① divider 块正确', b1[1] && b1[1].type === 'divider', JSON.stringify(b1[1]));
    ok('① image 块 url/caption 正确', b1[2] && b1[2].url === legal[2].url && b1[2].caption === '一张图', JSON.stringify(b1[2]));
    ok('① score 块 fileId 归一成字符串', b1[3] && b1[3].type === 'score' && b1[3].fileId === '35', JSON.stringify(b1[3]));
    /* ② 白名单是「逐块重建」——多余字段必须消失 */
    const last = b1[4] || {};
    ok('② ★ 夹带的未知字段被丢弃（evilField / onclick 都不在）',
      last.evilField === undefined && last.onclick === undefined && last.type === 'text' && last.text === '结尾段。',
      JSON.stringify(last));
  }

  /* ---- 以下用 update 测非法输入（create 有 5 次/分钟限流，update 没有） ---- */
  const upd = (blocks) => req('PUT', '/api/posts/' + id, { title: TITLE, content: 'x', tagIds: [], blocks }, token);

  ok('③ 未知 type 被拒 1001', (await upd([{ type: 'video', url: '/x' }])).code === 1001);
  ok('④ 外链图片被拒 1001', (await upd([{ type: 'image', url: 'https://evil.com/a.jpg' }])).code === 1001);
  ok('④ ★ javascript: 伪协议被拒 1001', (await upd([{ type: 'image', url: 'javascript:alert(1)' }])).code === 1001);
  ok('④ data: 伪协议被拒 1001', (await upd([{ type: 'image', url: 'data:image/svg+xml,<svg onload=alert(1)>' }])).code === 1001);
  ok('⑤ 超长文本块被拒 1001', (await upd([{ type: 'text' }]).code === 1001
    ? true : (await upd([{ type: 'text', text: 'x'.repeat(5001) }])).code === 1001));
  ok('⑤ 超量块数（61 个）被拒 1001',
    (await upd(Array.from({ length: 61 }, () => ({ type: 'text', text: 'a' })))).code === 1001);
  ok('⑤ score 的 fileId 非数字被拒 1001', (await upd([{ type: 'score', fileId: 'abc' }])).code === 1001);
  ok('③ 空 type 被拒 1001', (await upd([{ text: '没有 type' }])).code === 1001);

  /* ⑥ <script> 只是文字，能正常存下来 */
  const xss = '<script>alert(1)</script><img src=x onerror=alert(2)>';
  const rx = await upd([{ type: 'text', text: xss }]);
  ok('⑥ 含 <script> 的文本被当纯文本**正常存下**', rx.code === 0, 'code=' + rx.code + ' ' + rx.message);
  const bx = parseBlocks((await req('GET', '/api/posts/' + id)).data.blocks);
  ok('⑥ 存回来仍是同一串文字（没被服务端改写/转义）', Array.isArray(bx) && bx[0] && bx[0].text === xss,
    bx && bx[0] ? JSON.stringify(bx[0].text) : '(空)');

  /* ---- ⑦ update 语义 ---- */
  const kept = parseBlocks((await req('GET', '/api/posts/' + id)).data.blocks);
  await req('PUT', '/api/posts/' + id, { title: TITLE, content: 'x', tagIds: [] }, token);   // 不带 blocks
  const kept2 = parseBlocks((await req('GET', '/api/posts/' + id)).data.blocks);
  ok('⑦ ★ 不带 blocks 的 update → **不改动**原块',
    JSON.stringify(kept) === JSON.stringify(kept2),
    `before=${kept && kept.length} after=${kept2 && kept2.length}`);

  await req('PUT', '/api/posts/' + id, { title: TITLE, content: 'x', tagIds: [], blocks: [] }, token);
  const cleared = (await req('GET', '/api/posts/' + id)).data.blocks;
  ok('⑦ ★ 带空数组 [] 的 update → **清空**块', cleared === null || cleared === '', 'raw=' + JSON.stringify(cleared));

  /* ---- ⑧ 老帖子 ---- */
  const old = await req('GET', '/api/posts/174');
  ok('⑧ 老帖子（未写过 blocks）detail 里 blocks 为空',
    old.code === 0 && (old.data.blocks === null || old.data.blocks === '' || old.data.blocks === undefined),
    'raw=' + JSON.stringify(old.data && old.data.blocks));

  /* ---- ⑨ 错误要能**定位**（2026-10-16 用户反馈：以前只知道"参数不合法"）----
     message 是给人看的（1 基序号），data 是给前端定位的（0 基 index）。 */
  const e1 = await upd([{ type: 'text', text: 'ok' }, { type: 'video' }]);
  ok('⑨ 未知 type：message 指明「第 2 个块」',
    e1.code === 1001 && /第 2 个块/.test(e1.message || ''), `msg="${e1.message}"`);
  ok('⑨ 未知 type：data 给出 field=blocks + index=1（0 基）',
    e1.data && e1.data.field === 'blocks' && e1.data.index === 1, JSON.stringify(e1.data));

  const e2 = await upd([{ type: 'image', url: 'https://evil.com/x.jpg' }]);
  ok('⑨ 外链图片：message 说清原因（站内图床）+ 定位到第 1 个块',
    /第 1 个块/.test(e2.message || '') && /站内图床/.test(e2.message || '')
      && e2.data && e2.data.index === 0, `msg="${e2.message}" data=${JSON.stringify(e2.data)}`);

  const e3 = await upd(Array.from({ length: 61 }, () => ({ type: 'text', text: 'a' })));
  ok('⑨ 块数超限：message 给人看、data 只给 field（不指向具体某块）',
    /最多 60 个/.test(e3.message || '') && e3.data && e3.data.field === 'blocks'
      && e3.data.index === undefined, `msg="${e3.message}" data=${JSON.stringify(e3.data)}`);

  const e4 = await upd([{ type: 'score', fileId: '' }]);
  ok('⑨ 乐谱块没附件：message 提示「先上传乐谱文件」+ 定位到第 1 个块',
    /上传/.test(e4.message || '') && e4.data && e4.data.index === 0,
    `msg="${e4.message}" data=${JSON.stringify(e4.data)}`);

  const del = await req('DELETE', '/api/posts/' + id, undefined, token);
  console.log('\n收尾：删除测试帖 #' + id + ' → code=' + del.code);

  console.log('\n' + (fail ? '✗ 有 ' + fail + ' 项不符' : '★ 全部通过') + '   （通过 ' + pass + ' / 失败 ' + fail + '）');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
