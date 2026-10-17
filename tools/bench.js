/**
 * HTTP 基准压测（纯 HTTP，Node 内置模块，零依赖，不 spawn 外部进程）。
 *
 * 用途：给「后端到底什么水平」一个**可复现的真实数字**，而不是拍脑袋。
 * 输出：每个场景的 请求数 / QPS / P50 / P90 / P95 / P99 / max / 错误率 / 平均响应体量。
 *
 * ⚠️ 本项目**所有业务错误都是 HTTP 200 + body 里的 code**，所以错误率必须按 code 统计，
 *    只看 HTTP 状态码会得到「0% 错误」这种假象（这一条踩过好几次了）。
 *
 * 用法：
 *   node tools/bench.js                       # 默认场景，并发 1 与 20
 *   node tools/bench.js --conc=1,20,50        # 指定并发梯度
 *   node tools/bench.js --n=300               # 每个场景每档并发的请求数
 *   KAL_API=http://localhost:8080 node tools/bench.js
 *
 * 数据安全：写场景用**自己建的临时帖**（作者=admin 且点赞者=admin，
 * 后端 notify() 对「自己给自己」不发通知），跑完删帖，净变化为零。
 */
const API = process.env.KAL_API || 'http://localhost:8080';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith('--' + k + '='));
  return hit ? hit.split('=')[1] : d;
};
const CONC = String(arg('conc', '1,20')).split(',').map(Number).filter((x) => x > 0);
const N = Number(arg('n', '300'));
const WARM = Number(arg('warm', '20'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint()) / 1e6;   // ms，高精度

async function req(method, path, body, token) {
  const headers = {};
  if (token) headers['sa-token'] = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(API + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, len: Buffer.byteLength(text, 'utf8'), json };
}

async function login(u, p) {
  const r = await req('POST', '/api/auth/login', { username: u, password: p });
  return r.json && r.json.code === 0 ? r.json.data.token : null;
}

/** 一次「业务成功」的判定：本项目业务错误在 body.code 里。 */
function bizOk(r) {
  if (r.status < 200 || r.status >= 300) return false;
  if (r.json && typeof r.json.code === 'number') return r.json.code === 0;
  return true;                       // 二进制/裸响应（如附件下载）只看 HTTP
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

/**
 * 跑一个场景：固定并发 c，共 n 个请求（不抛错，错误率单独统计）。
 * 用「c 个 worker 各自拉活」的方式，真实反映并发下的吞吐。
 */
async function runScenario(name, c, n, fn) {
  const lat = [];
  let errs = 0, bytes = 0;
  const codes = new Map();          // 错误码分布：光看「错误率」不知道错在哪，也分不清是服务端问题还是测试设计问题
  let cursor = 0;
  const t0 = now();
  await Promise.all(Array.from({ length: c }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= n) return;
      const s = now();
      let ok = false, len = 0, code = 'n/a';
      try {
        const r = await fn(i);
        ok = bizOk(r);
        len = r.len || 0;
        code = (r.json && typeof r.json.code === 'number') ? r.json.code : ('HTTP ' + r.status);
      } catch (e) { ok = false; code = 'EXC:' + (e && e.message); }
      lat.push(now() - s);
      if (!ok) { errs++; codes.set(code, (codes.get(code) || 0) + 1); }
      bytes += len;
    }
  }));
  const wall = (now() - t0) / 1000;
  const sorted = lat.slice().sort((a, b) => a - b);
  return {
    name, conc: c, n: lat.length, wall,
    qps: lat.length / wall,
    min: sorted[0], p50: pct(sorted, 50), p90: pct(sorted, 90),
    p95: pct(sorted, 95), p99: pct(sorted, 99), max: sorted[sorted.length - 1],
    errRate: lat.length ? errs / lat.length : 0,
    avgBytes: lat.length ? Math.round(bytes / lat.length) : 0,
    codes: [...codes.entries()].sort((a, b) => b[1] - a[1])
  };
}

function fmtRow(r) {
  const f = (x) => x.toFixed(1).padStart(7);
  return `  ${String(r.conc).padStart(3)} | ${String(r.n).padStart(5)} | ${r.qps.toFixed(0).padStart(7)} |`
    + ` ${f(r.p50)} |${f(r.p90)} |${f(r.p95)} |${f(r.p99)} |${f(r.max)} |`
    + ` ${(r.errRate * 100).toFixed(2).padStart(5)}% | ${String(r.avgBytes).padStart(6)}`;
}

const HEAD = '  并发 |  请求 |     QPS |    P50 |    P90 |    P95 |    P99 |    max | 错误率 | 平均字节';

(async () => {
  const demo = await login('demo', '123456');
  const admin = await login('admin', '123456');
  if (!demo || !admin) { console.error('✗ 登录失败，无法压测'); process.exit(1); }

  /* 取一个已上架的帖子做详情/评论等只读场景 */
  const list = await req('GET', '/api/posts?page=1&size=1');
  const pid = list.json && list.json.data && list.json.data.records && list.json.data.records[0]
    && list.json.data.records[0].id;
  if (!pid) { console.error('✗ 库里没有帖子，无法压测'); process.exit(1); }

  /* 写场景用自己建的临时帖（作者=admin，点赞者=admin → 后端不会给自己发通知） */
  const tmp = await req('POST', '/api/posts', {
    title: '压测临时帖 ' + Date.now(), content: 'bench.js 创建，跑完删除。', tagIds: [], scoreFileId: null
  }, admin);
  const tmpId = tmp.json && tmp.json.code === 0 ? tmp.json.data.id : null;
  console.log(`  样本：帖子 #${pid}（只读）、临时帖 #${tmpId}（写场景，跑完删）`);

  const scenarios = [
    ['GET /api/posts（列表·分页）', () => req('GET', '/api/posts?page=1&size=10')],
    ['GET /api/posts/{id}（详情）', () => req('GET', `/api/posts/${pid}`)],
    ['GET /api/search（四维聚合）', () => req('GET', '/api/search?keyword=' + encodeURIComponent('天空') + '&type=all')],
    ['GET /api/hot（热榜）', () => req('GET', '/api/hot')],
    ['GET /api/tags（字典）', () => req('GET', '/api/tags')],
    ['GET /api/users/{id}（公开主页）', () => req('GET', '/api/users/2')],
    ['GET /api/notifications（鉴权分页）', () => req('GET', '/api/notifications?page=1&size=20', undefined, demo)],
    ['GET /api/files/{id}（鉴权下载）', () => req('GET', '/api/files/1', undefined, demo)],
  ];
  if (tmpId) {
    /* 写路径 A：编辑帖子（作者=admin，重复写同一份内容 → 幂等，无唯一键冲突）——这是干净的写基准 */
    scenarios.push(['PUT /api/posts/{id}（写·幂等）', () =>
      req('PUT', `/api/posts/${tmpId}`, {
        title: '压测临时帖', content: 'bench.js 创建，跑完删除。', tagIds: [], scoreFileId: null
      }, admin)]);
    /* 写路径 B：并发对**同一条** like 记录 POST/DELETE ——
       ⚠️ 这**故意**会造成 like_record 唯一键冲突（4001），用来暴露「点赞接口在并发下不是幂等语义」
       这个真实事实。它的错误率**不能**当作服务端错误率读，看错误码分布。 */
    scenarios.push(['POST+DELETE /likes（并发同键）', async () => {
      const a = await req('POST', `/api/posts/${tmpId}/likes`, undefined, admin);
      if (!bizOk(a)) return a;
      return req('DELETE', `/api/posts/${tmpId}/likes`, undefined, admin);
    }]);
  }

  const all = [];
  for (const [name, fn] of scenarios) {
    console.log('\n■ ' + name);
    console.log(HEAD);
    /* 预热：让 JIT / 连接池 / InnoDB buffer pool 进入稳态，否则第一档会被冷启动污染 */
    for (let i = 0; i < WARM; i++) { try { await fn(i); } catch (_) {} }
    for (const c of CONC) {
      const r = await runScenario(name, c, N, fn);
      all.push(r);
      console.log(fmtRow(r));
      if (r.codes.length) {
        console.log('        └ 错误码分布：' + r.codes.map(([k, v]) => `${k}×${v}`).join('  '));
      }
    }
  }

  /* ---- 场景：前端「列表页首屏」的真实请求路径（1 次列表 + 每行 1 次作者查询）---- */
  const PAGE = 10;
  const list10 = await req('GET', `/api/posts?page=1&size=${PAGE}`);
  const rows = ((list10.json && list10.json.data && list10.json.data.records) || []).length;
  console.log(`\n■ 列表页首屏（前端实际路径：1 次 /api/posts + ${rows} 次 /api/users/{id} 补作者）`);
  console.log(HEAD);
  for (const c of CONC) {
    const r = await runScenario('list-first-screen', c, Math.max(20, Math.round(N / 4)), async () => {
      const p = await req('GET', `/api/posts?page=1&size=${PAGE}`);
      const recs = (p.json && p.json.data && p.json.data.records) || [];
      let bytes = p.len;
      for (const x of recs) {
        const u = await req('GET', '/api/users/' + x.userId);
        bytes += u.len;
      }
      return { status: p.status, len: bytes, json: p.json };
    });
    all.push({ ...r, name: '列表页首屏（含 N+1）' });
    console.log(fmtRow(r) + `   ← 每次共 ${1 + rows} 个 HTTP 请求`);
  }

  /* ---- 收尾：删临时帖 ---- */
  if (tmpId) {
    await req('DELETE', `/api/posts/${tmpId}/likes`, undefined, admin).catch(() => {});
    const del = await req('DELETE', '/api/posts/' + tmpId, undefined, admin);
    console.log(`\n  收尾：临时帖 #${tmpId} 删除 = ${del.json && del.json.code === 0 ? 'OK' : '失败(code=' + (del.json && del.json.code) + ')'}`);
  }

  console.log('\n（本机单实例 + 本地 MySQL，非生产环境；数字用于**横向对比接口之间**，不代表线上容量）');
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
