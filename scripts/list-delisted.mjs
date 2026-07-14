// 掲載台帳（data/hotpepper-roster*.json）から「ホットペッパーの掲載が終了した店」
// ＝HP予約ができなくなった店をアタックリストとして出力する。
//
// 使い方:
//   node scripts/list-delisted.mjs --pref=chiba            # 直近90日に掲載終了した店を表示
//   node scripts/list-delisted.mjs --pref=chiba --days=30  # 期間を変更
//   node scripts/list-delisted.mjs --pref=chiba --csv=attack-list.csv  # CSVも書き出す
//
// APIキー不要（台帳を読むだけ）。台帳は scripts/hotpepper-roster.mjs が毎朝更新する。
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPrefFromArgv } from './prefectures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACTIVE_PREF = getPrefFromArgv();
const ROSTER_PATH = path.join(__dirname, '..', 'data', ACTIVE_PREF.dataFile.replace(/^stores/, 'hotpepper-roster'));

function getArg(name, fallback) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}
const DAYS = Math.max(1, +getArg('days', '90') || 90);
const CSV_PATH = getArg('csv', '');

function fmtDate(iso) {
  return (iso || '').slice(0, 10);
}

async function main() {
  let roster;
  try {
    roster = JSON.parse(await readFile(ROSTER_PATH, 'utf-8'));
  } catch {
    console.error(`[error] 台帳がありません: ${ROSTER_PATH}`);
    console.error('  まず scripts/hotpepper-roster.mjs を実行して台帳を作成してください。');
    process.exit(1);
  }
  const { updatedAt = '', shops = {} } = roster;
  const cutoff = Date.now() - DAYS * 24 * 60 * 60 * 1000;

  // 掲載終了 = 最新実行で見えなかった店（lastSeenAt が updatedAt より古い）
  const delisted = Object.entries(shops)
    .filter(([, s]) => s.lastSeenAt !== updatedAt && Date.parse(s.lastSeenAt || 0) >= cutoff)
    .map(([id, s]) => ({
      id,
      name: s.name,
      address: s.address,
      genre: s.genre,
      area: s.area,
      listedSince: fmtDate(s.firstSeenAt),
      delistedOn: fmtDate(s.lastSeenAt), // 最後に掲載を確認した日（この直後に終了）
      url: `https://www.hotpepper.jp/str${id}/`,
    }))
    .sort((a, b) => (a.delistedOn < b.delistedOn ? 1 : -1));

  console.log(`■ ${ACTIVE_PREF.name} ホットペッパー掲載終了店（直近${DAYS}日 / 台帳更新: ${fmtDate(updatedAt)}）`);
  console.log(`  該当: ${delisted.length} 店\n`);
  for (const s of delisted) {
    console.log(`・${s.name}${s.genre ? `（${s.genre}）` : ''}`);
    console.log(`   ${s.address}`);
    console.log(`   掲載終了: ${s.delistedOn} ごろ / 旧ページ: ${s.url}`);
  }

  if (CSV_PATH) {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [
      ['店名', 'ジャンル', 'エリア', '住所', '掲載終了日(推定)', '旧ホットペッパーURL'].map(esc).join(','),
      ...delisted.map(s => [s.name, s.genre, s.area, s.address, s.delistedOn, s.url].map(esc).join(',')),
    ];
    // Excelで文字化けしないようBOM付きUTF-8で出力
    await writeFile(CSV_PATH, '\uFEFF' + rows.join('\r\n'));
    console.log(`\n[info] CSVを書き出しました: ${CSV_PATH}`);
  }
}

main().catch(err => {
  console.error('[error]', err.message || err);
  process.exit(1);
});
