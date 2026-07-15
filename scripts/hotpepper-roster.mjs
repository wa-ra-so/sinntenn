// ホットペッパーグルメAPIから対象県の「全掲載店」を取得し、掲載台帳
// data/hotpepper-roster*.json を更新するスクリプト。1日3回Actionsから実行される想定。
//
// 台帳には店舗IDごとに firstSeenAt/lastSeenAt（掲載確認日）に加えて、
// reservable（ネット予約可否）と reservableCheckedAt を記録する。
//
// ネット予約可否はグルメサーチAPIにフィールドが無いため、店舗ページ本体を取得し
// <title> タグの「＜ネット予約可＞」表記の有無で判定する（実ページで確認済み。
// 予約可の店はタイトルに付き、不可の店には付かない）。全店（数千件）を毎回
// チェックすると重いため、未チェック・チェックが古い店から順に1回の実行につき
// RESERVE_CHECK_BATCH 件だけ確認するローテーション方式（1日3回実行）。
//
// 注意: ローテーションのため「予約できなくなった正確な日」はわからない。
// 記録できるのは lastReservableAt（予約可能を最後に確認した日）〜
// reservationLostAt（予約不可を検出した日）という"幅"のみ
// （チェック間隔は千葉県で約2〜3日あるため、実際の変化はこの間のどこか）。
//
// 「予約できなくなった店」＝ reservable が true→false に変わった店、または
// 掲載自体が終了した店（true だった場合のみ）。reservationLostAt に検出日時を
// 記録し、data/hotpepper-reservation-lost*.json に軽量抽出する。
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
// attack.html が読む軽量版（予約できなくなった店のみの抽出。台帳本体は大きいため）
const LOST_PATH = path.join(__dirname, '..', 'data', ACTIVE_PREF.dataFile.replace(/^stores/, 'hotpepper-reservation-lost'));

const HOTPEPPER_API_KEY = process.env.HOTPEPPER_API_KEY || '';
const API_BASE = 'https://webservice.recruit.co.jp/hotpepper';
const PAGE_SIZE = 100;          // APIの最大件数
const MAX_PAGES = 300;          // 暴走防止（100件×300=3万件まで）
const PAGE_INTERVAL_MS = 200;   // ページ間の待機（API負荷への配慮）
const KEEP_DAYS = 400;          // 掲載終了店を台帳に残す日数（掃除用）

// ネット予約チェックのローテーション設定（全店を毎日は見ず、少しずつ回す）
const RESERVE_CHECK_BATCH = +(process.env.RESERVE_CHECK_BATCH || 800);
const RESERVE_CHECK_CONCURRENCY = 5;
const RESERVE_PAGE_TIMEOUT_MS = 15000;
const RESERVE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

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
          url: (s.urls && s.urls.pc) || `https://www.hotpepper.jp/str${s.id}/`,
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

// 店舗ページの <title> にある「＜ネット予約可＞」表記の有無でネット予約可否を判定する。
// 取得失敗時は null（不明）を返し、既存の状態を壊さないようにする。
async function checkReservable(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': RESERVE_UA },
      signal: AbortSignal.timeout(RESERVE_PAGE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/<title>([^<]*)<\/title>/i);
    if (!m) return null;
    return m[1].includes('ネット予約可');
  } catch {
    return null;
  }
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

  // 台帳へマージ: 今回見えた店は掲載情報とlastSeenAtを更新、見えなかった店はそのまま残す
  const shops = { ...prev.shops };
  let added = 0;
  for (const [id, s] of current) {
    if (!shops[id]) {
      shops[id] = { ...s, firstSeenAt: stamp, lastSeenAt: stamp };
      added++;
    } else {
      // reservable系フィールドは維持しつつ、掲載情報だけ更新
      shops[id] = { ...shops[id], ...s, lastSeenAt: stamp };
    }
  }

  // ── ネット予約可否チェック（ローテーション） ──
  // 掲載中の店のうち、未チェック・チェックが古い順に一定数だけ確認する
  const listedIds = Object.keys(shops).filter(id => shops[id].lastSeenAt === stamp);
  const checkQueue = listedIds
    .slice()
    .sort((a, b) => Date.parse(shops[a].reservableCheckedAt || 0) - Date.parse(shops[b].reservableCheckedAt || 0))
    .slice(0, RESERVE_CHECK_BATCH);
  console.log(`[info] ネット予約チェック対象: ${checkQueue.length} 件（掲載中 ${listedIds.length} 件中）`);

  const reservationLostNow = [];
  let checkedOk = 0;
  let checkFailed = 0;
  await mapWithConcurrency(checkQueue, RESERVE_CHECK_CONCURRENCY, async (id) => {
    const s = shops[id];
    const result = await checkReservable(s.url);
    if (result === null) { checkFailed++; return; }
    checkedOk++;
    const wasReservable = s.reservable;
    shops[id] = { ...s, reservable: result, reservableCheckedAt: stamp };
    if (result === true) {
      shops[id].lastReservableAt = stamp; // 「予約可能を最後に確認した日」を更新
      if (s.reservationLostAt) delete shops[id].reservationLostAt; // 再びネット予約可能に戻った
    } else if (wasReservable === true) {
      // s.lastReservableAt は前回チェック時点で既に「予約可能を最後に確認した日」
      // として記録済み（今回は false なので更新しない）。実際に変わったのはこの日から
      // 今回検出した stamp までのどこか
      shops[id].reservationLostAt = stamp;
      reservationLostNow.push({ id, ...shops[id] });
    }
    // wasReservable が undefined（初回チェック）で result が false の場合は
    // 「元々ネット予約なし」の可能性が高く、予約"できなくなった"わけではないため対象外
  });
  console.log(`[info] ネット予約チェック結果: 成功 ${checkedOk} / 失敗 ${checkFailed}`);
  if (reservationLostNow.length > 0) {
    console.log(`[info] 今回新たにネット予約不可を検出: ${reservationLostNow.length} 店`);
    for (const s of reservationLostNow) {
      const range = s.lastReservableAt ? `${s.lastReservableAt.slice(0, 10)} 〜 ${s.reservationLostAt.slice(0, 10)}` : `〜${s.reservationLostAt.slice(0, 10)}`;
      console.log(`  - ${s.name}（${s.area || s.address}） ${range} ${s.url}`);
    }
  }

  // 掲載終了店（台帳から消えた店）は、予約可だった場合のみ「予約できなくなった」に計上する
  const newlyDelisted = Object.entries(shops).filter(([, s]) =>
    s.lastSeenAt === prev.updatedAt && prev.updatedAt !== '' && prev.updatedAt !== stamp);
  const newlyDelistedLost = [];
  for (const [id, s] of newlyDelisted) {
    if (s.reservable === true) {
      shops[id] = { ...s, reservable: false, reservationLostAt: stamp };
      reservationLostNow.push({ id, ...shops[id] });
      newlyDelistedLost.push(shops[id]);
    }
  }
  if (newlyDelistedLost.length > 0) {
    console.log(`[info] 今回新たに掲載終了（予約可だった店）: ${newlyDelistedLost.length} 店`);
    for (const s of newlyDelistedLost) {
      const range = s.lastReservableAt ? `${s.lastReservableAt.slice(0, 10)} 〜 ${s.reservationLostAt.slice(0, 10)}` : `〜${s.reservationLostAt.slice(0, 10)}`;
      console.log(`  - ${s.name}（${s.area || s.address}） ${range} ${s.url}`);
    }
  }

  // 掲載終了から一定日数を過ぎた店は台帳から掃除（ファイル肥大防止）
  const keepCutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  let pruned = 0;
  for (const [id, s] of Object.entries(shops)) {
    if (s.lastSeenAt !== stamp && Date.parse(s.lastSeenAt || 0) < keepCutoff) {
      delete shops[id];
      pruned++;
    }
  }

  const reservationLostAll = Object.entries(shops)
    .filter(([, s]) => !!s.reservationLostAt)
    .map(([id, s]) => ({ id, ...s }))
    .sort((a, b) => (a.reservationLostAt < b.reservationLostAt ? 1 : -1));

  await mkdir(path.dirname(ROSTER_PATH), { recursive: true });
  await writeFile(ROSTER_PATH, JSON.stringify({
    updatedAt: stamp,
    pref: ACTIVE_PREF.id,
    activeCount: current.size,
    reservationLostCount: reservationLostAll.length,
    shops,
  }, null, 1));
  // アタックリスト画面（attack.html）用の軽量抽出
  await writeFile(LOST_PATH, JSON.stringify({
    updatedAt: stamp,
    pref: ACTIVE_PREF.id,
    activeCount: current.size,
    items: reservationLostAll,
  }, null, 1));
  console.log(`[info] 台帳更新: 掲載中 ${current.size} / 新規 ${added} / 予約不可(累計) ${reservationLostAll.length} / 掃除 ${pruned}`);
  console.log(`[info] wrote ${ROSTER_PATH} / ${LOST_PATH}`);
}

main().catch(err => {
  console.error('[error]', err.message || err);
  process.exit(1);
});
