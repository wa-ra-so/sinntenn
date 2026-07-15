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
  hasExcludeKeyword, isChibaRelevant, isPrefRelevant, isChain, isNonFoodJob, detectArea,
  isOpeningJobTitle, connectorJobToItem,
} from './fetch-stores.mjs';
import { PREFECTURES } from './prefectures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  '市川市に定食チェーン「大戸屋ごはん処」がオープン',
  '株式会社グルメ杵屋 オープニングスタッフ募集（「店舗スタッフ」/未経験OK）',
  '「しゃぶしゃぶ温野菜 稲毛山王店」オープニングスタッフ募集',
  'スシローが千葉市中央区に新店舗をオープン',
  // タイトルに千葉要素が無い他県ニュース（本文だけ「千葉県」のケース）
  '池袋駅東口に大型居酒屋がオープン',
  '横浜・関内に話題のイタリアンレストランが開店',
  // 2026-07-15 東京に混入（「イタリア車」がジャンル検索「イタリアン」に緩く一致した無関係な芸能ニュース）
  '画像・写真 | 今田耕司、"東京で初めて購入した車"明かす「イタリア車が好きで…」 1枚目',
  // 2026-07-15 全県精査で検出（既存店の周年記念イベント。「オープン」に一致するが新規開店ではない）
  '【埼玉県川口市】関東のホークスファンが集う「餃子居酒屋 モモタロ」オープン1周年記念ウィーク開催',
  // 2026-07-15 東京に混入（飲食店ではない家具店のプレオープン記事）
  '【追加情報】『東京インテリア』5/29プレオープン開催！チラシ＆現地の様子も紹介',
  // 2026-07-15 千葉に混入（求人サイトの構造変化等による破損データ。天気情報が混ざったゴミ）
  '佐倉 市 求人 TEL 0222477887 仙台市名坂店 TEL 0223735665 仙台 千葉県竜巻注意情報',
  // 2026-07-15 全県精査で検出（大手チェーン。記事内で店舗数が明示されている）
  '【東京都中野区】「すし銚子丸」が「パークシティ中野」にオープン！持ち帰り専用コーナーを設置',
  '【全国200店舗】東京で行列の居酒屋『新時代』が大宮に2店舗目を出店 2026年6月27日(土)グランドオープン',
  '【焼きたてのかるび】6月22日(月)埼玉県朝霞市に38店舗目をオープン！',
  '【埼玉県4号店オープン！】自分で仕上げる、牛肉100%のハンバーグが自慢！関西発祥のファミリーレストラン「トマト＆オニオン 北本店」が5月24日（日）埼玉県北本市にオープン！',
  'アパホテル株式会社 オープニングスタッフ募集（日勤フロントスタッフ）',
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
  '株式会社Ryumake オープニングスタッフ募集（「イルミネーション・イベント施工スタッフ」あなたの手で街に彩…）',
  // 2026-07-14 神奈川に混入（会社名が介護施設・職種が看護師）
  '「介護老人福祉施設 わかたけ新子安」オープニングスタッフ募集（正看護師・社会保険完備の職場で看護師/准看護師）',
  // 2026-07-15 千葉・埼玉に混入（倉庫・仕分け・ピッキング系の軽作業求人）
  '株式会社ジェイウェイブ オープニングスタッフ募集（倉庫内で検品やデータ登録）',
  '株式会社ホットスタッフ成田 オープニングスタッフ募集（日払いOKで即日収入/梱包/「成田市」「時給1,600円〜」…）',
  '株式会社ワン&オンリーキャスティング オープニングスタッフ募集（仕分け・シール貼り 単発 サクッと登録 スキマ時間で出勤 日…）',
  '株式会社トーコー オープニングスタッフ募集（お菓子のピッキング作業）',
  // 2026-07-15 東京に混入（リハビリ特化型デイサービス「レコードブック」の求人）
  '「レコードブック浅草」オープニングスタッフ募集（トレーナー 無資格可 オープニングスタッフ）',
  '「レコードブック浅草」オープニングスタッフ募集（デイサービスの運動指導員 無資格可 オープニングスタッフ）',
  // 2026-07-15 千葉に混入（放課後等デイサービスの求人）
  '「クラップ ジュニア」オープニングスタッフ募集（児童発達支援管理責任者/放課後等デイサービス/未経験OK/昇…）',
  // 2026-07-15 全県精査で検出（飲食店以外の小売・サービス業の求人が「オープニングスタッフ募集」に混入）
  '健康コミュニケーションズ株式会社 オープニングスタッフ募集（携帯販売/PRスタッフ/イベントスタッフ スマホ好き必見 1…）',
  '株式会社スタッフサービス オープニングスタッフ募集（営業・販売/ファッション・コスメ関連 複数名の大募集 残業ほ…）',
  '株式会社ブラスト オープニングスタッフ募集（整体師）',
  '株式会社テンポスホールディングス オープニングスタッフ募集（飲食店用品の販売スタッフ 未経験OK）',
  '株式会社テンポスバスターズ 五反田店 オープニングスタッフ募集（飲食店向けの商品販売・接客 オープニングスタッフ）',
  '「てらぴぁぽけっと成瀬駅前教室」オープニングスタッフ募集（言語聴覚士/児童発達支援施設/未経験OK/昇給あり/賞与あり…）',
  'イフスコヘルスケア株式会社 オープニングスタッフ募集（調理師/「調理師」調理師or栄養士免許を活かせるオープニング…）',
  '株式会社HITOWA フードサービスカンパニー オープニングスタッフ募集（給食スタッフ/キッチン/調理・栄養関連 調理STAFF募集 …）',
  '「エーアイアールグループ」オープニングスタッフ募集（ルームアドバイザー/クリエイト蒲田「新店舗で心機一転スタート…）',
  '「ヤオコー 大宮市場店」オープニングスタッフ募集（スーパーマーケットのレジスタッフ/オープニングスタッフ）',
  '株式会社平山 オープニングスタッフ募集（機械オペレーター/2交代/トラックの足回り部品/即入寮・即入…）',
  '株式会社アルパジャパン オープニングスタッフ募集（オープニングスタッフ 食品スーパー鮮魚加工Staff/川口柳…）',
  '株式会社若菜 オープニングスタッフ募集（オープニング公立中学校での調理師・栄養士）',
  'ランスタッド株式会社 オープニングスタッフ募集（販売/世界的ジュエリーブランドでワンランク上のホスピタリティ…）',
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
// 他県のエリア判定・関連性判定
check(detectArea('新宿にビストロがオープン', PREFECTURES.tokyo) === '新宿区', 'エリア判定: 新宿→新宿区（東京）');
check(detectArea('吉祥寺の焼肉店', PREFECTURES.tokyo) === '武蔵野市', 'エリア判定: 吉祥寺→武蔵野市（東京）');
check(detectArea('武蔵小杉にバル開店', PREFECTURES.kanagawa) === '川崎市中原区', 'エリア判定: 武蔵小杉→川崎市中原区（神奈川）');
check(detectArea('大宮駅前に居酒屋', PREFECTURES.saitama) === 'さいたま市大宮区', 'エリア判定: 大宮→さいたま市大宮区（埼玉）');
check(isPrefRelevant('池袋に大型居酒屋がオープン', PREFECTURES.tokyo), '関連性: 池袋は東京都で掲載される');
check(!isPrefRelevant('横浜・関内に話題のイタリアンレストランが開店', PREFECTURES.tokyo), '関連性: 横浜の記事は東京都で除外される');
check(isPrefRelevant('横浜・関内に話題のイタリアンレストランが開店', PREFECTURES.kanagawa), '関連性: 横浜の記事は神奈川県で掲載される');

// 2026-07-15 全県精査で確認（「周年」を含むが施設自体の周年に伴う新規カフェ開業＝除外してはいけない。
// 「周年記念」は既存店のイベント告知に使われる言い回しで、こちらとは区別できる）
check(!hasExcludeKeyword('東京スカイツリー／開業14周年当日に屋上カフェテラス5月22日オープン'),
  '除外ワード誤爆検知: 施設の周年に伴う新規カフェ開業は除外されない（「周年記念」ではないため）');

// ── オープニング求人タイトル判定（Indeed実データ由来のケース） ──
const OPENING_TITLES = [
  '【立ち飲み屋】オープニングスタッフ',
  '8月オープン 話題のダイニング ホール・キッチン',
  '8月オープン。スイーツづくりを楽しむセントラルキッチンクルー',
  '近日オープンのカフェ ホールスタッフ',
];
const NOT_OPENING_TITLES = [
  '駅チカレストランのキッチンスタッフ',      // 既存店の通常求人
  'オムライス専門店のホール|yellow 千葉',   // 既存店の通常求人
  'オープンキッチンでの調理補助',            // 「オープン」を含むが新店ではない
  '7月リニューアルオープンの居酒屋スタッフ', // 改装は新店ではない
];
for (const t of OPENING_TITLES) {
  check(isOpeningJobTitle(t), `オープニング求人が誤って除外: ${t}`);
}
for (const t of NOT_OPENING_TITLES) {
  check(!isOpeningJobTitle(t), `通常求人がオープニング扱い: ${t}`);
}

// ── Indeedコネクタ形式の変換（merge-indeed.mjs 用） ──
const kept = connectorJobToItem({
  title: '【立ち飲み屋】オープニングスタッフ', company: '株式会社　山商',
  location: '習志野市 津田沼', postedOn: 'June 30, 2026', url: 'https://to.indeed.com/test1',
});
check(kept && kept.area === '習志野市' && kept.signal === 'hiring',
  'コネクタ変換: 千葉のオープニング求人が掲載される');
check(connectorJobToItem({
  title: '大戸屋(和食レストラン)のオープニングディナー店舗スタッフ', company: '株式会社大戸屋',
  location: '市川市 市川', postedOn: 'May 01, 2026', url: 'https://to.indeed.com/test2',
}) === null, 'コネクタ変換: 大手チェーン（大戸屋）が除外される');
check(connectorJobToItem({
  title: 'オープニングスタッフ募集 カフェホール', company: '株式会社テスト',
  location: 'さいたま市 大宮', postedOn: 'June 30, 2026', url: 'https://to.indeed.com/test3',
}) === null, 'コネクタ変換: 千葉県外の求人が除外される');
const saitamaKept = connectorJobToItem({
  title: 'オープニングスタッフ募集 カフェホール', company: '株式会社テスト',
  location: 'さいたま市 大宮', postedOn: 'June 30, 2026', url: 'https://to.indeed.com/test3',
}, PREFECTURES.saitama);
check(saitamaKept && saitamaKept.area.startsWith('さいたま市'),
  'コネクタ変換: さいたまの求人は埼玉県で掲載される');
check(connectorJobToItem({
  title: 'オープニングスタッフ（コールセンター）', company: '株式会社テスト',
  location: '千葉市 中央', postedOn: 'June 30, 2026', url: 'https://to.indeed.com/test4',
}) === null, 'コネクタ変換: 飲食以外の職種が除外される');
check(connectorJobToItem({
  title: 'オープニングスタッフ募集 カフェホール', company: '株式会社テスト',
  location: '埼玉県', postedOn: 'June 30, 2026', url: 'https://to.indeed.com/test5',
}, PREFECTURES.saitama) === null, 'コネクタ変換: 勤務地が県名のみ（市区町村不明）は掲載しない（監査と同一基準）');

const total = MUST_EXCLUDE.length + MUST_KEEP.length + MUST_EXCLUDE_JOBS.length + MUST_KEEP_JOBS.length + 2
  + 7 + OPENING_TITLES.length + NOT_OPENING_TITLES.length + 6 + 1;
console.log(`${total - failures}/${total} 件パス`);

// ── 公開データの監査（--audit 時のみ、全県分） ──
if (process.argv.includes('--audit')) {
  for (const pref of Object.values(PREFECTURES)) {
    const dataPath = path.join(__dirname, '..', 'data', pref.dataFile);
    console.log(`── data/${pref.dataFile} 監査（${pref.name}） ──`);
    let json;
    try {
      json = JSON.parse(await readFile(dataPath, 'utf-8'));
    } catch (err) {
      // 新設県の初回はファイルが無いためスキップ（千葉は既存なので通常ここに来ない）
      console.warn(`[warn] 監査スキップ: ${err.message}`);
      continue;
    }
    const items = Array.isArray(json.items) ? json.items : [];
    let bad = 0;
    for (const it of items) {
      const problems = [];
      if (hasExcludeKeyword(it.title)) problems.push('除外ワード');
      if (isChain(it.title)) problems.push('大手チェーン');
      if (it.signal === 'hiring' && isNonFoodJob(it.title)) problems.push('飲食以外の求人');
      if (!it.area && !isPrefRelevant(it.title, pref)) problems.push(`${pref.short}要素なし`);
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
  }
}

if (failures > 0) {
  console.error(`\nテスト失敗: ${failures} 件`);
  process.exit(1);
}
console.log('\nすべてのテストにパスしました');
