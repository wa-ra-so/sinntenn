// 収集フィルタの自動テスト＋公開データの監査。
// GitHub Actions で毎回実行され、失敗するとワークフローが止まる（不適切な掲載を防ぐ）。
//
//   node scripts/test-filters.mjs          … フィルタの単体テストのみ
//   node scripts/test-filters.mjs --audit  … 単体テスト＋ data/stores.json の全件監査
//
// テストケースには「過去に実際に混入したタイトル」を残しておくこと（再発防止）。
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hasExcludeKeyword, isChibaRelevant, isChain, isNonFoodJob, detectArea,
} from './fetch-stores.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, '..', 'data', 'stores.json');

// ── 除外されるべきタイトル（掲載されたらNG） ──
const MUST_EXCLUDE = [
  // 過去に実際に混入した事件・経済ニュース
  '東京・池袋 ガールズバー売春強要事件 店長の男に懲役8年を求刑（ANNニュース）',
  '兵庫県警が西宮でガールズバーなどの立ち入り調査',
  '1259億破綻「全東信」で夜の街が悲鳴！クレカ停止と売上未入金で連鎖倒産危機',
  // 事件・犯罪系のバリエーション
  '千葉市の居酒屋で従業員を暴行した疑いで店長を逮捕',
  '船橋市のバー経営者を詐欺容疑で書類送検',
  '柏市の焼肉店で食中毒 営業停止処分',
  // 対象外業態
  '千葉駅前にキャバクラ「ナイトピア」がグランドオープン',
  '松戸駅前のパチンコ店が改装オープン',
  '船橋にガールズバーが新規開店',
  // 大手チェーン
  '物語コーポレーション／千葉県浦安市に「焼肉きんぐ マーヴ浦安店」6月30日オープン',
  '「しゃぶしゃぶ温野菜 稲毛山王店」オープニングスタッフ募集',
  'スシローが千葉市中央区に新店舗をオープン',
  // タイトルに千葉要素が無い他県ニュース（本文だけ「千葉県」のケース）
  '池袋駅東口に大型居酒屋がオープン',
  '横浜・関内に話題のイタリアンレストランが開店',
];

// ── 掲載されるべきタイトル（除外されたらNG＝フィルタの誤爆検知） ──
const MUST_KEEP = [
  '船橋市三山2丁目に居酒屋「芯」がオープン',
  '【千葉県初出店】「焼鳥 蕎麦 二尺五寸」マーヴ浦安店を2026年6月30日(火)オープンいたします。',
  '千葉県「佐倉市立美術館」にカフェがオープン！多彩なメニューをラインナップ',
  'クラフトビール専門カフェが成田空港にオープン　搭乗前に地ビール飲み比べ',
  '津田沼駅前に韓国料理店がグランドオープン',
  '「おでん屋たけし 船橋駅南口店」オープニングスタッフ募集（和食, 居酒屋/店長・店長候補）',
];

// ── 飲食以外の職種求人（求人収集で弾かれるべき） ──
const MUST_EXCLUDE_JOBS = [
  '株式会社ミライル オープニングスタッフ募集（コールセンター「テレフォンオペレーター」）',
  '株式会社ミライル オープニングスタッフ募集（一般事務・OA事務）',
  'オープニングスタッフ募集（倉庫内軽作業・データ入力）',
];
const MUST_KEEP_JOBS = [
  '「海鮮和食 魚まみれ 仲々 小林店」オープニングスタッフ募集（ホールスタッフ・サービススタッフ/居酒屋）',
  '「Koala Tree Cafe and Dining」オープニングスタッフ募集（調理師・調理スタッフ/カフェ）',
];

// ニュース記事がフィルタを通過するか（fetch-stores.mjs の main() と同じ判定順）
function passesNewsFilters(title) {
  return !isChain(title) && !hasExcludeKeyword(title) && isChibaRelevant(title);
}

let failures = 0;
function check(ok, label) {
  if (ok) return;
  failures++;
  console.error(`  ✗ ${label}`);
}

console.log('── フィルタ単体テスト ──');
for (const t of MUST_EXCLUDE) {
  check(!passesNewsFilters(t), `除外されるべきタイトルが通過: ${t}`);
}
for (const t of MUST_KEEP) {
  check(passesNewsFilters(t), `掲載されるべきタイトルが除外: ${t}`);
}
for (const t of MUST_EXCLUDE_JOBS) {
  check(isNonFoodJob(t), `飲食以外の求人が通過: ${t}`);
}
for (const t of MUST_KEEP_JOBS) {
  check(!isNonFoodJob(t), `飲食の求人が誤って除外: ${t}`);
}
// エリア判定の基本動作
check(detectArea('船橋駅前に居酒屋オープン') === '船橋市', 'エリア判定: 船橋→船橋市');
check(detectArea('津田沼にカフェ開店') === '習志野市', 'エリア判定: 津田沼→習志野市');

const total = MUST_EXCLUDE.length + MUST_KEEP.length + MUST_EXCLUDE_JOBS.length + MUST_KEEP_JOBS.length + 2;
console.log(`${total - failures}/${total} 件パス`);

// ── 公開データの監査（--audit 時のみ） ──
if (process.argv.includes('--audit')) {
  console.log('── data/stores.json 監査 ──');
  try {
    const json = JSON.parse(await readFile(DATA_PATH, 'utf-8'));
    const items = Array.isArray(json.items) ? json.items : [];
    let bad = 0;
    for (const it of items) {
      const problems = [];
      if (hasExcludeKeyword(it.title)) problems.push('除外ワード');
      if (isChain(it.title)) problems.push('大手チェーン');
      if (it.signal === 'hiring' && isNonFoodJob(it.title)) problems.push('飲食以外の求人');
      if (!it.area && !isChibaRelevant(it.title)) problems.push('千葉要素なし');
      if (problems.length) {
        bad++;
        console.error(`  ✗ [${problems.join('・')}] ${it.title}`);
      }
    }
    if (bad > 0) {
      failures += bad;
      console.error(`${bad} 件の不適切な掲載を検出`);
    } else {
      console.log(`全 ${items.length} 件クリーン`);
    }
  } catch (err) {
    console.warn(`[warn] data/stores.json を監査できませんでした: ${err.message}`);
  }
}

if (failures > 0) {
  console.error(`\nテスト失敗: ${failures} 件`);
  process.exit(1);
}
console.log('\nすべてのテストにパスしました');
