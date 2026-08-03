// Indeed公式コネクタ（Claude MCP）で収集した求人を data/ 配下の県別JSONにマージする。
// GitHub ActionsからのIndeedスクレイピングは403でブロックされるため、
// Claudeセッション（毎朝のルーティン）がコネクタで検索した結果をこのスクリプトで取り込む。
//
//   node scripts/merge-indeed.mjs <raw-jobs.json> [stores.json のパス] [--pref=tokyo]
//
// --pref を省略すると千葉県。第2引数を省略すると data/<県のdataFile> を更新する。
// ルーティンから main のデータに対してマージする場合は取り出したファイルのパスを渡す。
//
// <raw-jobs.json> は次の形式の配列:
//   [{ "title": "求人タイトル", "company": "社名/店名", "location": "習志野市 津田沼",
//      "postedOn": "June 30, 2026", "url": "https://to.indeed.com/xxxx" }, ...]
//
// フィルタは fetch-stores.mjs の connectorJobToItem に集約してある（基準は毎朝の収集と同一）。
// マージ後は必ず `node scripts/test-filters.mjs --audit` で監査すること。
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectorJobToItem, normalizeForDedupe } from './fetch-stores.mjs';
import { getPrefFromArgv } from './prefectures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pref = getPrefFromArgv();
const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
const rawPath = positional[0];
const DATA_PATH = positional[1] || path.join(__dirname, '..', 'data', pref.dataFile);

if (!rawPath) {
  console.error('usage: node scripts/merge-indeed.mjs <raw-jobs.json> [stores.json のパス] [--pref=tokyo]');
  process.exit(1);
}

const jobs = JSON.parse(await readFile(rawPath, 'utf-8'));
if (!Array.isArray(jobs)) {
  console.error('raw-jobs.json は配列である必要があります');
  process.exit(1);
}

let data;
try {
  data = JSON.parse(await readFile(DATA_PATH, 'utf-8'));
} catch {
  // 新設県の初回はデータファイルが無いので空で始める
  data = { generatedAt: null, ttlDays: 60, runLog: [], itemCount: 0, hotpepper: {}, market: {}, items: [] };
}
if (!Array.isArray(data.items)) {
  console.error(`${DATA_PATH} に items がありません（破損？）— 中断します`);
  process.exit(1);
}

const ttlDays = data.ttlDays || 60;
const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;

// linkだけでなく正規化タイトルでも重複判定する。Indeedのview-job URLもトラッキング
// パラメータ違いで同じ求人が別linkとして再取得されることがあり、以前はlink一致だけの
// 重複判定だと見逃していた（正規化タイトルでは判定していたが、単に捨てるだけで
// linkを更新していなかった）。fetch-stores.mjs の main() と同じ upsert 方式に揃え、
// 同一内容が新しいlinkで再出現したら新しい方に差し替えつつ、初出日時
// （firstSeenAt）は古い方を引き継ぐ（リンク切れ対策を兼ねる）
const merged = new Map();   // link -> item
const byTitle = new Map();  // 正規化タイトル -> そのタイトルで現在mergedに入っているlink
for (const it of data.items) {
  merged.set(it.link, it);
  byTitle.set(normalizeForDedupe(it.title), it.link);
}

let added = 0, filteredOut = 0, dup = 0, stale = 0;
for (const job of jobs) {
  const item = connectorJobToItem(job, pref);
  if (!item) { filteredOut++; continue; }
  const d = item.pubDate ? Date.parse(item.pubDate) : NaN;
  if (Number.isFinite(d) && d < cutoff) { stale++; continue; }
  if (merged.has(item.link)) { dup++; continue; }
  const norm = normalizeForDedupe(item.title);
  const dupLink = byTitle.get(norm);
  if (dupLink && merged.has(dupLink)) {
    const prevItem = merged.get(dupLink);
    merged.delete(dupLink);
    const firstSeenAt = prevItem.firstSeenAt < item.firstSeenAt ? prevItem.firstSeenAt : item.firstSeenAt;
    merged.set(item.link, { ...item, firstSeenAt });
    byTitle.set(norm, item.link);
    dup++;
    console.log(`  ~ ${item.title} [${item.area}]（同一内容・リンク更新）`);
    continue;
  }
  merged.set(item.link, item);
  byTitle.set(norm, item.link);
  added++;
  console.log(`  + ${item.title} [${item.area}]`);
}

data.items = [...merged.values()];
data.items.sort((a, b) => {
  const da = Date.parse(a.pubDate || a.firstSeenAt) || 0;
  const db = Date.parse(b.pubDate || b.firstSeenAt) || 0;
  return db - da;
});
data.items = data.items.slice(0, 300);
data.itemCount = data.items.length;
if (!data.generatedAt) data.generatedAt = new Date().toISOString();
if (Array.isArray(data.runLog)) {
  // 同ラベルの古いエントリを差し替え（毎日実行してもログが増殖しないように）
  const label = `Indeedコネクタ（オープニングスタッフ 飲食店 ${pref.name}）`;
  data.runLog = data.runLog.filter(r => r.label !== label);
  data.runLog.push({ label, ok: true, count: added, mergedAt: new Date().toISOString() });
}

await writeFile(DATA_PATH, JSON.stringify(data, null, 2) + '\n', 'utf-8');
console.log(`[${pref.name}] 追加 ${added} 件 / フィルタ除外 ${filteredOut} 件 / 重複 ${dup} 件 / 期限切れ ${stale} 件 → 計 ${data.itemCount} 件`);
