// 一時診断: APIの千葉県掲載店数(5,228)とサイト検索の件数(約4,670)の差の原因調査。
// APIのジャンル別内訳と、サイトのエリアページに表示される件数を突き合わせる。
// 用が済んだら削除する（本番コードではない）。
const KEY = process.env.HOTPEPPER_API_KEY || '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function apiGet(pathname, params) {
  const qs = new URLSearchParams({ key: KEY, format: 'json', ...params });
  const res = await fetch(`https://webservice.recruit.co.jp/hotpepper/${pathname}/v1/?${qs}`, { signal: AbortSignal.timeout(15000) });
  const json = await res.json();
  return json.results || {};
}

// 1) 千葉の大エリア・サービスエリアコード
const la = await apiGet('large_area', {});
const chiba = (la.large_area || []).find(a => (a.name || '').includes('千葉'));
console.log('large_area:', JSON.stringify(chiba));

// 2) API 総件数
const total = await apiGet('gourmet', { large_area: chiba.code, count: '1' });
console.log(`API総件数: ${total.results_available}`);

// 3) ジャンル別内訳
const gm = await apiGet('genre', {});
let sum = 0;
for (const g of gm.genre || []) {
  const r = await apiGet('gourmet', { large_area: chiba.code, genre: g.code, count: '1' });
  const n = +r.results_available || 0;
  sum += n;
  console.log(`  ${g.code} ${g.name}: ${n}`);
  await sleep(150);
}
console.log(`ジャンル別合計: ${sum}`);

// 4) サイトのエリアページの表示件数（サービスエリアコードから）
const sa = chiba.service_area && chiba.service_area.code;
for (const url of [`https://www.hotpepper.jp/${sa}/`, `https://www.hotpepper.jp/${chiba.code}/`]) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    console.log(`\n=== ${url} → HTTP ${res.status} ===`);
    if (!res.ok) continue;
    const html = await res.text();
    const title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1];
    console.log('title:', title);
    // 「◯件」表記の周辺を出す
    const hits = [...html.matchAll(/.{0,60}[\d,]{3,7}件.{0,20}/g)].slice(0, 15);
    for (const h of hits) console.log('  …' + h[0].replace(/\s+/g, ' '));
  } catch (e) {
    console.log(`${url} error: ${e.message}`);
  }
}
