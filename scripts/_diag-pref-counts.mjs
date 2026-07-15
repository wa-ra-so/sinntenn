// 一時診断: 東京・神奈川・埼玉のホットペッパー掲載店数と大エリアコードを確認する。
// 用が済んだら削除する（本番コードではない）。
import { PREFECTURES } from './prefectures.mjs';

const KEY = process.env.HOTPEPPER_API_KEY || '';

async function apiGet(pathname, params) {
  const qs = new URLSearchParams({ key: KEY, format: 'json', ...params });
  const res = await fetch(`https://webservice.recruit.co.jp/hotpepper/${pathname}/v1/?${qs}`, { signal: AbortSignal.timeout(15000) });
  const json = await res.json();
  return json.results || {};
}

const la = await apiGet('large_area', {});

for (const id of ['tokyo', 'kanagawa', 'saitama']) {
  const pref = PREFECTURES[id];
  const areas = (la.large_area || []).filter(a => (a.name || '').includes(pref.short));
  let total = 0;
  const parts = [];
  for (const a of areas) {
    const r = await apiGet('gourmet', { large_area: a.code, count: '1' });
    const n = +r.results_available || 0;
    total += n;
    parts.push(`${a.name}(${a.code})=${n}`);
  }
  console.log(`${pref.name}: 合計 ${total} 店  [${parts.join(', ')}]`);
}
