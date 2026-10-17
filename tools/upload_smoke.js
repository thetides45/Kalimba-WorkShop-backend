/**
 * 乐谱上传 + 曲谱分类字段落库自测。
 * 用法：后端已启动后，node tools/upload_smoke.js
 *
 * 环境变量（可选）：
 *   KAL_SCORE_MARKER  塞进 title 的随机串，供 file_access_smoke.js 做「内容泄露」探针。
 *                     与格式名解耦 —— 格式一换，写死的 marker 会变成**真空通过**（见那边的注释）。
 *                     不传则本脚本自己生成一个，并在结尾把串联命令打印出来。
 */
const BASE = 'http://localhost:8080';

async function main() {
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'demo', password: '123456' }),
  })).json();
  const token = login.data.token;

  /* ⚠️ 夹具必须用**内核导出格式**（2026-10-13 起唯一真源）：
     顶层字段 + rows/items + source 为简谱原文。
     旧 kalimba-score 格式已无任何生成方（正主随 Vue SPA 于 2026-10-07 归档），
     拿它当夹具等于在测一份现实中不存在的数据。 */
  const MARKER = process.env.KAL_SCORE_MARKER || ('probe-' + Math.random().toString(36).slice(2, 10));
  const score = JSON.stringify({
    format: 'kalimba-tab', version: 1,
    title: '天空之城 ' + MARKER,
    key: { name: 'C', pc: 0 }, meter: [4, 4], tempo: 88,
    tuning: { key: 'k17', notes: [], len: 17 },
    mode: 'movable', direction: 'up', transpose: 0,
    unit: 0.25, rowsPerMeasure: 2, beatsPerMeasure: 4, nMeasures: 1,
    totalBeats: 7, usedCols: [0, 1, 2],
    rows: [{ idx: 0, rest: false, items: [{ col: 0, midi: 60, label: '1', dur: 1, voice: 0, bad: false }] }],
    source: '1 2 3 5 3 2 1',
  });
  const blob = new Blob([score], { type: 'application/json' });

  const fd = new FormData();
  fd.append('file', blob, 'sky-city.json');
  const url = BASE + '/api/files/score?tuningType=k17&keyName=C&difficulty=easy&musicGenre=anime';
  const res = await fetch(url, { method: 'POST', headers: { 'sa-token': token }, body: fd });
  const d = await res.json();

  console.log('上传结果 code=', d.code, ' fileId=', d.data && d.data.id);
  if (d.data) {
    console.log('  tuningType =', d.data.tuningType);
    console.log('  keyName    =', d.data.keyName);
    console.log('  difficulty =', d.data.difficulty);
    console.log('  musicGenre =', d.data.musicGenre);
    console.log('  format     =', d.data.format, ' ← 期望 kalimba-tab');
    console.log('  version    =', d.data.version, ' ← 期望 1（内核 JSON 里是数字、无引号）');
    console.log('  fileName   =', d.data.fileName);
    const pass = d.code === 0 && d.data.tuningType === 'k17' && d.data.keyName === 'C'
      && d.data.difficulty === 'easy' && d.data.musicGenre === 'anime'
      && d.data.format === 'kalimba-tab' && d.data.version === '1';
    console.log(pass ? '★ 乐谱上传 + 曲谱分类 + 信封字段 全部正确' : '✗ 有字段不符');
    if (d.data.filePath) {
      console.log('  → 串联静态旁路断言（file_access_smoke 的 ③ 需要内容里真实存在的串）：');
      console.log(`    KAL_SCORE_PATH=${d.data.filePath} KAL_SCORE_MARKER=${MARKER} node tools/file_access_smoke.js`);
    }
    process.exit(pass ? 0 : 1);
  }
  console.error('✗ 上传没有返回 data，无法继续');
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(2); });
