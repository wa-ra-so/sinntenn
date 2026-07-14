// ホットペッパーグルメAPIから対象県の「全掲載店」を取得し、掲載台帳
// data/hotpepper-roster*.json を更新するスクリプト。毎朝Actionsから実行される想定。
//
// 台帳には店舗IDごとに firstSeenAt（初めて掲載を確認した日時）と
// lastSeenAt（最後に掲載を確認した日時）を記録する。lastSeenAt が最新実行
// （updatedAt）より古い店は「掲載終了店」＝ホットペッパー予約ができなくなった店で、
// scripts/list-delisted.mjs でアタックリストとして一覧できる。
//
// 注意: グルメサーチAPIにネット予約可否のフィールドは無いため、
// 「予約できなくなった」は「掲載自体が終了した」ことで判定する。
//
// 使い方: HOTPEPPER_API_KEY=xxx node scripts/hotpepper-roster.mjs --pref=chiba
// 依存パッケージなし（Node 20+ の組み込み fetch のみ使用）。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPrefFromArgv } from './prefectures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACTIVE_PREF = getPrefFromArgv();
// stores.json → hotpepper-roster.json / stores-tokyo.json → hotpepper-roster-tokyo.json
const ROSTER_PATH = path.join(__dirname, '..', 'data', ACTIVE_PREF.dataFile.replace(/^stores/, 'hotpepper-roster'));

const HOTPEPPER_API_KEY = process.env.HOTPEPPER_API_KEY || '';
const API_BASE = 'https://webservice.recruit.co.jp/hotpepper';
const PAGE_SIZE = 100;          // APIの最大件数
const MAX_PAGES = 300;          // 暴走防止（100件×300=3万件まで）
const PAGE_INTERVAL_MS = 200;   // ページ間の待機（API負荷への配慮）
const DELISTED_KEEP_DAYS = 400; // 掲載終了店を台帳に残す日数（掃除用）

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function apiGet(pathname, params) {
  const qs = new URLSearchParams({ key: HOTPEPPER_API_KEY, format: 'json', ...params });
  const res = await fetch(`${API_BASE}/${pathname}/v1/?${qs}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`hotpepper ${pathname} HTTP ${res.status}`);
  const json = await res.json();
  if (json.results && json.results.error) {
    const e = [].concat(json.results.error)[0] || {};
    throw new Error(`hotpepper ${pathname} API error ${e.code || ''}: ${e.message || 'unknown'}`);
  }
  return json.results || {};
}

// 県名から大エリアコード（Z0XX）を動的に解決する（コードのハードコードを避ける）
async function resolveLargeArea(pref) {
  const results = await apiGet('large_area', {});
  const list = (results.large_area || []).filter(a => (a.name || '').includes(pref.short));
  if (list.length === 0) throw new Error(`large_area not found for ${pref.name}`);
  return list.map(a => ({ code: a.code, name: a.name }));
}

// 対象県の全掲載店をページングで取得
async function fetchAllShops(largeAreas) {
  const shops = new Map(); // id -> shop
  for (const area of largeAreas) {
    let start = 1;
    for (let page = 0; page < MAX_PAGES; page++) {
      const results = await apiGet('gourmet', {
        large_area: area.code, count: String(PAGE_SIZE), start: String(start),
      });
      const batch = results.shop || [];
      const available = +results.results_available || 0;
      for (const s of batch) {
        if (!s.id) continue;
        shops.set(s.id, {
          name: s.name || '',
          address: s.address || '',
          genre: (s.genre && s.genre.name) || '',
          area: (s.small_area && s.small_area.name) || (s.middle_area && s.middle_area.name) || '',
        });
      }
      start += batch.length;
      if (batch.length === 0 || start > available) break;
      await sleep(PAGE_INTERVAL_MS);
    }
    console.log(`[info] ${area.name}(${area.code}): 累計 ${shops.size} 店`);
  }
  return shops;
}

async function loadRoster() {
  try {
    const json = JSON.parse(await readFile(ROSTER_PATH, 'utf-8'));
    return {
      updatedAt: json.updatedAt || '',
      shops: json.shops && typeof json.shops === 'object' ? json.shops : {},
    };
  } catch {
    return { updatedAt: '', shops: {} };
  }
}

async function main() {
  if (!HOTPEPPER_API_KEY) {
    console.log('[info] HOTPEPPER_API_KEY not set; skipping roster update');
    return;
  }
  const stamp = new Date().toISOString();
  const prev = await loadRoster();
  const prevActive = Object.values(prev.shops).filter(s => s.lastSeenAt === prev.updatedAt).length;

  const largeAreas = await resolveLargeArea(ACTIVE_PREF);
  console.log(`[info] ${ACTIVE_PREF.name} の大エリア: ${largeAreas.map(a => `${a.name}=${a.code}`).join(', ')}`);
  const current = await fetchAllShops(largeAreas);
  console.log(`[info] 現在の掲載店数: ${current.size}（前回 ${prevActive}）`);

  // 安全弁: 取得数が前回の半分未満ならAPI不調とみなし、台帳を更新しない
  // （大量の店を誤って「掲載終了」と判定しないため）
  if (current.size === 0 || (prevActive > 0 && current.size < prevActive * 0.5)) {
    throw new Error(`fetched ${current.size} shops (prev ${prevActive}); aborting roster update`);
  }

  // 台帳へマージ: 今回見えた店は lastSeenAt を更新、見えなかった店はそのまま残す
  const shops = { ...prev.shops };
  let added = 0;
  for (const [id, s] of current) {
    if (!shops[id]) {
      shops[id] = { ...s, firstSeenAt: stamp, lastSeenAt: stamp };
      added++;
    } else {
      shops[id] = { ...shops[id], ...s, lastSeenAt: stamp };
    }
  }

  // 今回の実行で新たに掲載終了になった店をログに出す（毎朝のActionsログで確認できる）
  const newlyDelisted = Object.entries(shops)
    .filter(([, s]) => s.lastSeenAt === prev.updatedAt && prev.updatedAt !== '' && prev.updatedAt !== stamp)
    .map(([id, s]) => ({ id, ...s }));
  if (newlyDelisted.length > 0) {
    console.log(`[info] 今回新たに掲載終了: ${newlyDelisted.length} 店`);
    for (const s of newlyDelisted) {
      console.log(`  - ${s.name}（${s.area || s.address}） https://www.hotpepper.jp/str${s.id}/`);
    }
  }

  // 掲載終了から一定日数を過ぎた店は台帳から掃除（ファイル肥大防止）
  const keepCutoff = Date.now() - DELISTED_KEEP_DAYS * 24 * 60 * 60 * 1000;
  let pruned = 0;
  for (const [id, s] of Object.entries(shops)) {
    if (s.lastSeenAt !== stamp && Date.parse(s.lastSeenAt || 0) < keepCutoff) {
      delete shops[id];
      pruned++;
    }
  }

  const delistedTotal = Object.values(shops).filter(s => s.lastSeenAt !== stamp).length;
  await mkdir(path.dirname(ROSTER_PATH), { recursive: true });
  await writeFile(ROSTER_PATH, JSON.stringify({
    updatedAt: stamp,
    pref: ACTIVE_PREF.id,
    activeCount: current.size,
    delistedCount: delistedTotal,
    shops,
  }, null, 1));
  console.log(`[info] 台帳更新: 掲載中 ${current.size} / 新規 ${added} / 掲載終了(累計) ${delistedTotal} / 掃除 ${pruned}`);
  console.log(`[info] wrote ${ROSTER_PATH}`);
}

main().catch(err => {
  console.error('[error]', err.message || err);
  process.exit(1);
});
