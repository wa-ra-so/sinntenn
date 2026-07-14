// ホットペッパー掲載店の中から、以前は予約可能だったのに
// 現在は予約できなくなった店舗をリストアップするスクリプト。
// 使用例: node scripts/detect-unavailable-reservations.mjs [--pref=chiba]
//
// 依存パッケージなし（Node 20+ の組み込み fetch のみ使用）。
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PREFECTURES, getPrefFromArgv } from './prefectures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACTIVE_PREF = getPrefFromArgv();
const DATA_PATH = path.join(__dirname, '..', 'data', ACTIVE_PREF.dataFile);
const HOTPEPPER_API_KEY = process.env.HOTPEPPER_API_KEY || '';

// fetch-stores.mjs から流用
function normalizeStoreName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[　\s]+/g, ' ')
    .trim();
}

async function queryHotpepper(keyword) {
  const url = `https://webservice.recruit.co.jp/hotpepper/gourmet/v1/?key=${HOTPEPPER_API_KEY}` +
    `&keyword=${encodeURIComponent(keyword)}&format=json&count=30`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`hotpepper HTTP ${res.status}`);
  const json = await res.json();
  return (json.results && json.results.shop) || [];
}

function matchShop(shops, storeName) {
  const norm = normalizeStoreName(storeName);
  return shops.find(s => {
    const sn = normalizeStoreName(s.name || '');
    const inPref = (s.address || '').includes(ACTIVE_PREF.name);
    return inPref && (sn.includes(norm) || norm.includes(sn));
  }) || null;
}

async function checkCurrentStatus(storeName, area) {
  try {
    let shops = await queryHotpepper(area ? `${storeName} ${area}` : storeName);
    let hit = matchShop(shops, storeName);
    if (!hit && area) {
      shops = await queryHotpepper(storeName);
      hit = matchShop(shops, storeName);
    }
    if (!hit) return null;
    return {
      shopName: hit.name,
      reserve: hit.reserve !== false && hit.reserve !== undefined,
      coupon: hit.coupon !== false && hit.coupon !== undefined,
      url: (hit.urls && hit.urls.pc) || '',
    };
  } catch (err) {
    console.warn(`[warn] API check failed for ${storeName}: ${err.message}`);
    return null;
  }
}

async function main() {
  if (!HOTPEPPER_API_KEY) {
    console.error('[error] HOTPEPPER_API_KEY environment variable is not set');
    process.exit(1);
  }

  console.log(`[info] Loading ${ACTIVE_PREF.name} data from ${DATA_PATH}`);
  const json = JSON.parse(await readFile(DATA_PATH, 'utf-8'));
  const { hotpepper: hpMap = {}, items = [] } = json;

  // 過去に reserve:true だった掲載店を集める
  const prevReservable = Object.entries(hpMap)
    .filter(([, v]) => v.reserve === true && v.listed === true)
    .map(([normKey, v]) => ({
      normKey,
      storeName: v.storeName,
      shopName: v.shopName,
      address: v.address,
      checkedAt: v.checkedAt,
    }));

  console.log(`[info] Found ${prevReservable.length} stores that previously had reserve capability`);

  if (prevReservable.length === 0) {
    console.log('[info] No stores with previous reserve capability found');
    return;
  }

  // 現在の状態をチェック（並列実行で遅くならないよう適度に制限）
  const unavailable = [];
  const CONCURRENCY = 2;
  let checked = 0;

  for (let i = 0; i < prevReservable.length; i += CONCURRENCY) {
    const batch = prevReservable.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(({ storeName, address }) =>
        checkCurrentStatus(storeName, address ? address.split(/\s+/)[0] : '')
      )
    );

    for (let j = 0; j < batch.length; j++) {
      const store = batch[j];
      const current = results[j];
      checked++;

      if (!current) {
        console.log(`[?] ${store.storeName} - API チェック失敗`);
      } else if (current.reserve === false) {
        unavailable.push({
          storeName: store.storeName,
          currentShopName: current.shopName,
          previouslyReserved: true,
          nowReserve: false,
          currentCoupon: current.coupon,
          url: current.url,
          previousChecked: store.checkedAt,
        });
        console.log(`[✓] ${store.storeName} (現在:${current.shopName}) - 予約不可に変更`);
      } else {
        console.log(`[○] ${store.storeName} (現在:${current.shopName}) - 予約可能（変わらず）`);
      }
    }
  }

  // 結果表示
  console.log(`\n──────────────────────────────────────`);
  console.log(`チェック完了: ${checked} / ${prevReservable.length} 店舗`);
  console.log(`予約不可に変更: ${unavailable.length} 店舗`);
  console.log(`──────────────────────────────────────\n`);

  if (unavailable.length > 0) {
    console.log('📋 予約が不可になった店舗リスト:');
    unavailable.forEach((s) => {
      console.log(`  • ${s.storeName}`);
      console.log(`    ホットペッパー掲載: ${s.currentShopName}`);
      console.log(`    URL: ${s.url}`);
      console.log(`    クーポン: ${s.currentCoupon ? '○' : '✗'}`);
      console.log('');
    });

    console.log('\n📊 CSV形式:');
    console.log('店名,ホットペッパー掲載店名,URL,クーポン');
    unavailable.forEach((s) => {
      const row = [
        `"${s.storeName.replace(/"/g, '""')}"`,
        `"${s.currentShopName.replace(/"/g, '""')}"`,
        s.url,
        s.currentCoupon ? 'YES' : 'NO',
      ].join(',');
      console.log(row);
    });
  }
}

main().catch(err => {
  console.error('[error]', err);
  process.exit(1);
});
