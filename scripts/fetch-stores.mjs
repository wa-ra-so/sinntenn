// 新規開店情報（予約業態）を Google ニュース検索RSS 等から収集し、
// data/ 配下の県別JSONを更新するスクリプト。GitHub Actions から1日3回実行される想定。
// 対象の県は --pref=chiba|tokyo|kanagawa|saitama で指定（省略時は千葉県）。
// ホットペッパー掲載チェックは Actions シークレット HOTPEPPER_API_KEY 設定時のみ実行。
// （シークレットを削除・再作成後、再実行トリガー）
//
// 依存パッケージなし（Node 20+ の組み込み fetch のみ使用）。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PREFECTURES, getPrefFromArgv } from './prefectures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// このプロセスの収集対象県（import時は千葉がデフォルトになるが、
// 県依存の関数はすべて pref 引数で上書きできる）
const ACTIVE_PREF = getPrefFromArgv();
const OUT_PATH = path.join(__dirname, '..', 'data', ACTIVE_PREF.dataFile);

// ── 収集対象ジャンル（予約ニーズの高い飲食業態。チェーンは後段で除外） ──
const GENRE_GROUPS = [
  { label: '居酒屋・ダイニング系', keywords: ['居酒屋', 'ダイニング', 'バル', 'レストラン', 'ビストロ'] },
  { label: '専門料理系',           keywords: ['焼肉', '寿司', '割烹', '懐石', '会席', '中華', '韓国料理', 'イタリアン', 'フレンチ'] },
  { label: 'カフェ系',             keywords: ['カフェ', 'スナック', '創作料理'] },
  // バーはカフェと同一クエリだとGoogleニュースの検索結果件数上限内でカフェ記事に
  // 埋もれて拾えなくなるため、独立クエリに分離する（ユーザー指摘: バーの掲載が弱い）
  { label: 'バー系',               keywords: ['バー'] },
];

const OPEN_SIGNAL = ['オープン', '新規開店', 'グランドオープン', 'プレオープン'];
// オープン前の求人告知（オープニングスタッフ募集）からも新店を検出する
const HIRE_SIGNAL = ['オープニングスタッフ', 'オープニング募集', 'オープニングスタッフ募集'];

// ── 除外ワード（犯罪・事件ニュースや飲食店以外の業態を弾く） ──
// Googleニュース検索は記事本文にもマッチするため、「千葉県」が本文に出るだけの
// 他県の事件記事などが混入する。タイトルにこれらの語を含む記事は収集対象外。
const EXCLUDE_KEYWORDS = [
  // 事件・犯罪・行政処分系
  '逮捕', '容疑', '摘発', '書類送検', '起訴', '判決', '求刑', '被告', '実刑', '有罪', '無罪',
  '強盗', '殺人', '傷害', '窃盗', '詐欺', '恐喝', '脅迫', '暴行', '売春', '買春', 'わいせつ',
  '違法', '無許可', '立ち入り調査', '営業停止', '行政処分', '風営法', '食中毒', '火災', '放火',
  'ぼったくり', '法外請求',
  // 倒産・破綻系の経済ニュース（新店情報ではない）
  '破綻', '倒産', '民事再生', '自己破産', '負債', '閉店ラッシュ', '全東信',
  // 飲食店の新店提案対象外の業態
  'ガールズバー', 'キャバクラ', 'キャバ嬢', 'ホストクラブ', 'セクキャバ', 'ラウンジ嬢',
  'メンズエステ', 'パチンコ', 'パチスロ', '風俗',
  // 芸能・エンタメ系の写真ギャラリー記事（ジャンルキーワードへの緩い一致で混入することがある。
  // 例:「イタリア車」が「イタリアン」に緩く一致し、無関係な芸能ニュースが県名一致だけで通過した）
  '画像・写真',
  // 既存店の周年記念イベント（新規開店ではない。「オープン」に一致するが実際は既存店の記事）
  '周年記念',
  // 飲食店以外の店舗・施設のオープン記事
  '東京インテリア',
  // 収集元サイトの構造変化等で混入した破損データ（求人情報と無関係な天気情報等が混ざったゴミデータ）
  '竜巻注意情報',
  // ラーメン店（ユーザー方針で対象外＝ニュース・求人とも一律除外。2026-07-15）。
  // 麺類専門店を特定できる語のみを列挙し、中華料理店・蕎麦店などの他業態を巻き込まないようにする
  // （「二郎」は「宏二郎丸」等の店名に、「家系」「中華」単独は他業態に誤爆するため入れない）
  'ラーメン', 'らーめん', 'らぁ麺', 'らあめん', 'ラー麺', '中華そば', '油そば', 'まぜそば', 'つけ麺',
  // ライセンスキャラクターの期間限定コラボカフェ（東京・大阪等を巡回するイベント形式で、
  // 単体の新規開店店舗ではない。「〇〇カフェが東京・大阪で開催決定！」型の定型文で判定）
  '開催決定',
];

export function hasExcludeKeyword(title) {
  if (EXCLUDE_KEYWORDS.some(w => title.includes(w))) return true;
  // 「東京のカフェ６選」等、複数店舗を紹介するまとめ記事は単体の新店情報ではないため除外
  if (/[0-9０-９]+選/.test(title)) return true;
  return false;
}

// タイトルに対象県の要素（県名または県内の市区町村・駅名）が無い記事は、
// 本文だけに県名が出てくる他県ニュースの可能性が高いため除外する
export function isPrefRelevant(title, pref = ACTIVE_PREF) {
  return title.includes(pref.short) || detectArea(title, pref) !== '';
}

// 後方互換（テスト等から利用）: 千葉県固定の関連性判定
export function isChibaRelevant(title) {
  return isPrefRelevant(title, PREFECTURES.chiba);
}

// ── 大手チェーン（既にネット予約導入済み・優先度が低いため除外） ──
const CHAIN_BLOCKLIST = [
  'マクドナルド', 'モスバーガー', 'バーガーキング', 'ロッテリア', 'ケンタッキー', 'KFC',
  'ミスタードーナツ', 'スターバックス', 'スタバ', 'ドトール', 'タリーズ', 'エクセルシオール',
  'サンマルクカフェ', 'コメダ珈琲', '星乃珈琲', '上島珈琲',
  'すき家', '吉野家', '松屋', 'なか卯', '餃子の王将', '日高屋', '丸亀製麺', 'はなまるうどん', '大戸屋',
  'グルメ杵屋', '杵屋うどん',
  '富士そば', 'てんや', 'かっぱ寿司', 'スシロー', 'くら寿司', 'はま寿司', 'がってん寿司', '銚子丸',
  'ペッパーランチ', 'ステーキのどん', 'いきなりステーキ',
  'サイゼリヤ', 'ガスト', 'バーミヤン', 'ジョナサン', 'デニーズ', 'ロイヤルホスト', 'ジョイフル', 'ココス',
  'すかいらーく', 'ペルティカ', 'トマト＆オニオン',
  'びっくりドンキー', '鳥貴族', '磯丸水産', '白木屋', '笑笑', '魚民', '土間土間', '千年の宴',
  '塚田農場', 'わたみん家', '和民', '庄や', 'つぼ八', '日本海庄や', '新時代', '焼きたてのかるび',
  'しゃぶしゃぶ温野菜', '温野菜', '焼肉きんぐ', '丸源ラーメン', 'ゆず庵', '牛角', 'しゃぶ葉',
  'セブンイレブン', 'ファミリーマート', 'ローソン', 'ユニクロ', '無印良品', 'イオン', 'ドン・キホーテ',
  'ヤオコー', 'アパホテル',
  '山岡家', '町田商店', '豚山', '元祖油堂', 'Zoff', 'ゾフ', 'はかた商店',
  // 複数ブランドを展開する大手外食グループ（子ブランド名なしで求人票に親会社名だけ
  // 書かれるケースがあり、個別ブランド名の登録だけでは弾けない）
  '物語コーポレーション', 'WDI',
  // モスバーガーの新業態「MOSH」（本部プレスリリース。既存の「モスバーガー」表記に一致しない）
  'MOSH',
];

const FEED_TTL_DAYS = 60; // 何日分の情報を一覧に残すか
const FETCH_TIMEOUT_MS = 15000;

function buildQueries() {
  const openPart = `(${OPEN_SIGNAL.join(' OR ')})`;
  const hirePart = `(${HIRE_SIGNAL.join(' OR ')})`;
  const openQueries = GENRE_GROUPS.map(g => ({
    label: `${g.label}（開店ニュース）`,
    query: `${ACTIVE_PREF.name} ${openPart} (${g.keywords.join(' OR ')})`,
    signal: 'opening',
  }));
  const hireQueries = GENRE_GROUPS.map(g => ({
    label: `${g.label}（オープニング求人）`,
    query: `${ACTIVE_PREF.name} ${hirePart} (${g.keywords.join(' OR ')})`,
    signal: 'hiring',
  }));
  return [...openQueries, ...hireQueries];
}

function decodeEntities(str) {
  return str
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function stripTags(str) {
  return decodeEntities(str.replace(/<[^>]*>/g, '')).trim();
}

function parseRssItems(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
    const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1];
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1];
    const source = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1];
    if (!title || !link) continue;
    items.push({
      rawTitle: stripTags(title),
      link: stripTags(link),
      pubDate: pubDate ? stripTags(pubDate) : null,
      source: source ? stripTags(source) : null,
    });
  }
  return items;
}

async function fetchWithTimeout(url, ms, userAgent) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': userAgent || 'Mozilla/5.0 (compatible; ChibaShintenBot/1.0)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

export function detectArea(title, pref = ACTIVE_PREF) {
  for (const area of pref.areas) {
    if (title.includes(area)) return area;
  }
  for (const key of pref.aliasKeys) {
    if (title.includes(key)) return pref.aliases[key];
  }
  return '';
}

export function detectGenres(title) {
  const all = GENRE_GROUPS.flatMap(g => g.keywords);
  return [...new Set(all.filter(k => title.includes(k)))];
}

export function isChain(title) {
  return CHAIN_BLOCKLIST.some(name => title.includes(name));
}

// Googleニュースのタイトルは「見出し - 出典サイト名」形式のことが多い
function splitTitleSource(rawTitle, sourceField) {
  if (sourceField) return { title: rawTitle.replace(new RegExp(`\\s*-\\s*${escapeRe(sourceField)}$`), '').trim(), source: sourceField };
  const m = rawTitle.match(/^(.*)\s-\s([^-]+)$/);
  if (m) return { title: m[1].trim(), source: m[2].trim() };
  return { title: rawTitle, source: '' };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// Googleニュースのリンクは実記事へのリダイレクトなので、社給アカウント等でnews.google.comが
// ブロックされていても開けるよう、収集時に実記事URLへ解決してから保存する
async function resolveArticleUrl(url) {
  if (!url || !url.includes('news.google.com')) return url;
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': BROWSER_USER_AGENT },
    });
    if (res.body) { try { await res.body.cancel(); } catch {} }
    return (res.url && !res.url.includes('news.google.com')) ? res.url : url;
  } catch {
    return url;
  }
}

async function mapWithConcurrency(list, limit, fn) {
  let idx = 0;
  async function worker() {
    while (idx < list.length) {
      const i = idx++;
      await fn(list[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
}

const RESOLVE_CONCURRENCY = 8;

// ── 店名・開店日の抽出（index.html（新店リサーチ）と同一ロジックを維持すること） ──
function extractStoreName(title) {
  const quotes = [...title.matchAll(/[「『]([^」』]{1,30})[」』]/g)].map(m => m[1]);
  if (quotes.length === 0) return '';
  const beforeOpen = title.match(/[「『]([^」』]{1,30})[」』][^「『]{0,20}(?:が|を)?[^「『]{0,15}オープン/);
  return (beforeOpen ? beforeOpen[1] : quotes[0]).trim();
}

function normalizeStoreName(name) {
  return name.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

// ── ホットペッパー掲載チェック（リクルートWebサービスAPI） ──
// APIキーは https://webservice.recruit.co.jp/ で無料発行し、
// リポジトリのActionsシークレット HOTPEPPER_API_KEY に設定する。
// 未設定の場合このステップはスキップされる。
const HOTPEPPER_API_KEY = process.env.HOTPEPPER_API_KEY || '';
const HP_RECHECK_DAYS = 7; // 未掲載店の再チェック間隔（開店後に掲載される場合があるため）
const HP_CONCURRENCY = 3;

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

async function checkHotpepper(storeName, area) {
  try {
    let shops = await queryHotpepper(area ? `${storeName} ${area}` : storeName);
    let hit = matchShop(shops, storeName);
    if (!hit && area) {
      shops = await queryHotpepper(storeName);
      hit = matchShop(shops, storeName);
    }
    return {
      listed: !!hit,
      url: hit ? ((hit.urls && hit.urls.pc) || '') : '',
      shopName: hit ? hit.name : '',
      // 掲載店は営業の下調べ用に店舗詳細も保存（電話・訪問前の確認に使う）
      address: hit ? (hit.address || '') : '',
      access: hit ? (hit.mobile_access || hit.access || '') : '',
      genre: hit && hit.genre ? (hit.genre.name || '') : '',
      budget: hit && hit.budget ? (hit.budget.name || hit.budget.average || '') : '',
      capacity: hit ? (hit.capacity || '') : '',
      open: hit ? (hit.open || '') : '',
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.warn(`[warn] hotpepper check failed for ${storeName}: ${err}`);
    return null;
  }
}

// ── 商圏データ（エリア×ジャンルのホットペッパー掲載店舗数） ──
// 「このエリアの同ジャンルはHP掲載○件＝ネット予約競争が既に始まっている」という
// 提案トークの数字として店舗詳細に表示する。件数は緩やかにしか変わらないため7日ごとに更新。
const MARKET_RECHECK_DAYS = 7;

async function queryHotpepperCount(keyword) {
  const url = `https://webservice.recruit.co.jp/hotpepper/gourmet/v1/?key=${HOTPEPPER_API_KEY}` +
    `&keyword=${encodeURIComponent(keyword)}&format=json&count=1`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`hotpepper HTTP ${res.status}`);
  const json = await res.json();
  const n = json.results && json.results.results_available;
  return Number.isFinite(+n) ? +n : null;
}

async function enrichMarket(items, prevMap) {
  const map = { ...prevMap };
  if (!HOTPEPPER_API_KEY) return map;
  const combos = new Set();
  for (const it of items) {
    if (!it.area) continue;
    const genre = (it.genres && it.genres[0]) || '';
    if (!genre) continue;
    combos.add(`${it.area}|${genre}`);
  }
  const recheckCutoff = Date.now() - MARKET_RECHECK_DAYS * 24 * 60 * 60 * 1000;
  const targets = [...combos].filter(key => {
    const prev = map[key];
    return !prev || Date.parse(prev.checkedAt || 0) < recheckCutoff;
  });
  console.log(`[info] market check: ${targets.length} area×genre combos (of ${combos.size})`);
  await mapWithConcurrency(targets, HP_CONCURRENCY, async (key) => {
    const [area, genre] = key.split('|');
    try {
      const count = await queryHotpepperCount(`${area} ${genre}`);
      if (count != null) map[key] = { count, checkedAt: new Date().toISOString() };
    } catch (err) {
      console.warn(`[warn] market check failed for ${key}: ${err}`);
    }
  });
  // 一覧に存在しなくなった組み合わせは掃除する
  for (const key of Object.keys(map)) {
    if (!combos.has(key)) delete map[key];
  }
  return map;
}

// items から店舗（店名抽出できたもの）を集め、掲載状況マップを更新して返す
async function enrichHotpepper(items, prevMap) {
  const map = { ...prevMap };
  if (!HOTPEPPER_API_KEY) {
    console.log('[info] HOTPEPPER_API_KEY not set; skipping listing check');
    return map;
  }
  const stores = new Map(); // normKey -> { name, area }
  for (const it of items) {
    const name = extractStoreName(it.title);
    if (!name) continue;
    const key = normalizeStoreName(name);
    if (!stores.has(key)) stores.set(key, { name, area: it.area || '' });
    else if (!stores.get(key).area && it.area) stores.get(key).area = it.area;
  }
  const recheckCutoff = Date.now() - HP_RECHECK_DAYS * 24 * 60 * 60 * 1000;
  const targets = [...stores.entries()].filter(([key]) => {
    const prev = map[key];
    if (!prev) return true;
    if (prev.listed) return !('address' in prev); // 掲載確認済みは再チェック不要（店舗詳細が未取得の旧データは再取得）
    return Date.parse(prev.checkedAt || 0) < recheckCutoff; // 未掲載は定期的に再チェック
  });
  console.log(`[info] hotpepper check: ${targets.length} stores (of ${stores.size})`);
  await mapWithConcurrency(targets, HP_CONCURRENCY, async ([key, s]) => {
    const result = await checkHotpepper(s.name, s.area);
    if (result) map[key] = { storeName: s.name, ...result };
  });
  // 一覧から消えた店のエントリは掃除する
  for (const key of Object.keys(map)) {
    if (!stores.has(key)) delete map[key];
  }
  return map;
}

// ── 求人ボックス（オープニングスタッフ求人）収集 ──
// Googleニュースはタウンワーク等の求人サイトの掲載を拾えないため、
// オープン前店舗の検出用に求人ボックスの検索結果から直接収集する。
// 検索結果の各求人カードには data-func-show-arg 属性に構造化JSON
// （title / company / workArea / updatedAt / url / allFeatureTags）が埋まっている。
const KYUJINBOX_HOST = 'https://xn--pckua2a7gp15o89zb.com'; // 求人ボックス.com
const KYUJINBOX_SEARCHES = [
  `オープニングスタッフ-飲食店の仕事-${ACTIVE_PREF.name}`,
];

// 求人検索は「飲食店」で絞っていても事務・コールセンター等の求人が混ざるため、職種名で弾く
const NONFOOD_JOB_KEYWORDS = [
  'コールセンター', 'テレフォンオペレーター', '事務', '受付', 'データ入力', 'データ登録',
  '清掃', '介護', '看護', '警備', '軽作業', '工場', 'ドライバー', '配送', '引越', 'コンビニ',
  '施工', 'イルミネーション', '倉庫', '検品', '仕分け', '梱包', 'ピッキング',
  'デイサービス', '運動指導員', 'レコードブック',
  // 飲食店以外の小売・サービス業（求人ボックス等の求人集約サイトから混入）
  '携帯', 'ジュエリー', '整体師', 'ルームアドバイザー', '機械オペレーター',
  '食品スーパー', 'スーパーマーケット', 'ファッション・コスメ', 'テンポス', 'リカバリーウェ',
  '美容師', '美容室', 'ネイリスト', 'エステティシャン',
  // 医療・福祉・教育系施設（飲食店ではない給食・療育・保育系求人）
  '言語聴覚士', '児童発達支援', '給食', '栄養士', '保育園', '保育士',
  // 派遣・人材紹介（派遣系。求人票の勤務先が飲食店でも「派遣会社の募集」で店舗特定できない）
  '派遣', '紹介所',
  // アパレル（衣料小売。飲食店ではない）
  'アパレル',
  // ※ホテルはユーザー判断で対象に含める（除外しない）。派遣・人材紹介系のホテル求人は
  //   「紹介所」等で別途弾かれる（例: 品川配ぜん人紹介所）
  // 飲食店ではない業種（判断確認済み）
  '株式会社サーズ', '和幸株式会社', 'カネカ食品', '株式会社ジュンバタンメラ',
  // 株式会社TCG＝シャープ特約店の家電飛び込み営業「アドバイザー」求人（飲食店ではない）
  '株式会社TCG',
  // アリックス株式会社＝ひなあられ等の豆菓子メーカー（工場製造補助求人。飲食店ではない）
  'アリックス株式会社',
  // 株式会社トーコー＝工場・軽作業系の人材派遣会社（「ピッキング」以外の職種でも
  // 様々な工場求人を掲載しており、キーワード一致だけでは弾けないため社名で除外）
  '株式会社トーコー',
];

export function isNonFoodJob(jobTitle) {
  return NONFOOD_JOB_KEYWORDS.some(w => jobTitle.includes(w));
}

function parseKyujinboxJobs(html) {
  const jobs = [];
  const re = /data-func-show-arg='([^']+)'/g;
  let m;
  while ((m = re.exec(html))) {
    try {
      const outer = JSON.parse(m[1]);
      if (!outer.json) continue;
      jobs.push(JSON.parse(outer.json));
    } catch { /* 構造が変わったカードはスキップ */ }
  }
  return jobs;
}

function truncate(str, max) {
  return str.length > max ? str.slice(0, max) + '…' : str;
}

// 求人タイトルが「新規オープンの店」の募集かどうか。
// 「7月オープン」「近日オープン」型も拾うが、「リニューアルオープン」「オープンキッチン」は拾わない
export function isOpeningJobTitle(jobTitle) {
  if (/オープニング|新規\s*オープン|新規\s*OPEN|NEW\s*OPEN|完全新規/i.test(jobTitle)) return true;
  return /(\d{1,2}月|近日|今[春夏秋冬])[にの]?(グランド)?オープン/.test(jobTitle);
}

// タグ欄はサイト側の都合で配列/文字列が揺れる（東京の検索結果で文字列が観測された）
function toTagArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v) return [v];
  return [];
}

// 美容業界専門の求人サイト（掲載元がここに一致する求人は、職種名の書き方に関わらず
// ほぼ確実に美容師・ネイリスト等の美容系求人＝飲食店ではないため、掲載元名で丸ごと除外する。
// 「美容師」等のキーワード一致に頼るより確実（求人票の言い回しに左右されない）
const NONFOOD_SITE_NAMES = ['リジョブ'];

// 掲載元サイト自体を理由に除外する求人（飲食業種の判定ではなく営業リードとしての方針判断）。
// 「食べログ求人」経由の求人は、その店舗が既に食べログの求人サービスを利用している＝
// 既存の食べログ顧客である可能性が高く、新規開拓リードとして不要なため除外する（2026-07-23）
export const EXCLUDED_SOURCE_SITE_NAMES = ['食べログ求人'];

export function kyujinboxToItem(job) {
  const jobTitle = (job.title || '').trim();
  const company = (job.company || '').trim();
  const workArea = job.workArea || '';
  if (!company || !workArea.includes(ACTIVE_PREF.name)) return null;
  const siteName = (job.siteName || '').trim();
  if (NONFOOD_SITE_NAMES.includes(siteName)) return null;
  if (EXCLUDED_SOURCE_SITE_NAMES.includes(siteName)) return null;
  // 求人サイトが求人カードに「オープニング」タグを付けていても、タイトル自体が
  // 「リニューアルオープン」（改装・既存店の再オープン）の場合は新規開店ではないため、
  // タグの有無に関わらず必ず除外する（タグ判定がisOpeningJobTitleのリニューアル除外を
  // バイパスしてしまい、はなまるうどん・すき家（ゼンショー系列）等の改装求人が混入していた）
  if (/リニューアル/.test(jobTitle)) return null;
  const tags = [...toTagArray(job.allFeatureTags), ...toTagArray(job.featureTagSp)];
  const isOpening = tags.includes('オープニング') || isOpeningJobTitle(jobTitle);
  if (!isOpening) return null;
  const combined = `${company} ${jobTitle}`;
  // 監査と同一基準: 会社名が介護施設等のケースがあるため、職種名だけでなく会社名も含めて判定
  if (isNonFoodJob(combined)) return null;
  if (isChain(combined) || hasExcludeKeyword(combined)) return null;
  // 会社名（株式会社等）でなく店舗名らしければ「」で囲み、店名抽出（extractStoreName）を効かせる
  const isCorporate = /株式会社|有限会社|合同会社|\(株\)|（株）/.test(company);
  const title = isCorporate
    ? `${company} オープニングスタッフ募集（${truncate(jobTitle, 30)}）`
    : `「${truncate(company, 30)}」オープニングスタッフ募集（${truncate(jobTitle, 30)}）`;
  const area = detectArea(workArea) || detectArea(combined);
  // 監査と同一基準: エリア不明かつタイトルに県要素なし（勤務地が「県名のみ」等）は掲載しない
  if (!area && !isPrefRelevant(title)) return null;
  let pubDate = null;
  if (job.updatedAt) {
    const d = new Date(job.updatedAt.replace(' ', 'T') + '+09:00');
    if (!Number.isNaN(d.getTime())) pubDate = d.toUTCString();
  }
  return {
    title,
    link: job.url || '',
    source: job.siteName ? `求人ボックス（${job.siteName}）` : '求人ボックス',
    pubDate,
    area,
    genres: detectGenres(combined),
    signal: 'hiring',
    firstSeenAt: new Date().toISOString(),
  };
}

async function collectKyujinbox() {
  const items = [];
  const runLog = [];
  for (const search of KYUJINBOX_SEARCHES) {
    const url = `${KYUJINBOX_HOST}/${encodeURIComponent(search)}`;
    try {
      const html = await fetchWithTimeout(url, FETCH_TIMEOUT_MS, BROWSER_USER_AGENT);
      const jobs = parseKyujinboxJobs(html);
      const converted = jobs.map(kyujinboxToItem).filter(Boolean);
      runLog.push({ label: `求人ボックス（${search}）`, query: url, ok: true, count: converted.length });
      items.push(...converted);
    } catch (err) {
      runLog.push({ label: `求人ボックス（${search}）`, query: url, ok: false, error: String(err && err.message || err) });
      console.warn(`[warn] kyujinbox failed: ${search} — ${err}`);
    }
  }
  return { items, runLog };
}

// ── Indeed（オープニングスタッフ求人）収集 ──
// 検索結果ページの埋め込みJSON（window.mosaic.providerData "mosaic-provider-jobcards"）から
// jobkey / タイトル / 社名 / 勤務地 / 掲載日を抽出する。
// Indeedはbot対策が強く、Actionsランナーからはブロックされる場合がある（その場合はスキップ）。
// ※タウンワークは検索ページがセッションCookie必須のため単体収集は見送り。
//   タウンワーク掲載分の多くは求人ボックス経由で収集される。
const INDEED_SEARCH_URL = 'https://jp.indeed.com/jobs?q=' +
  encodeURIComponent('オープニングスタッフ 飲食店') + '&l=' + encodeURIComponent(ACTIVE_PREF.name);
const INDEED_LABEL = `Indeed（オープニングスタッフ 飲食店 ${ACTIVE_PREF.name}）`;

// text[from]（'{'）から対応する'}'までを、文字列リテラルを考慮して切り出す
function extractJsonObject(text, from) {
  let depth = 0, inStr = false, esc = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return text.slice(from, i + 1); }
  }
  return null;
}

function parseIndeedJobs(html) {
  const marker = 'window.mosaic.providerData["mosaic-provider-jobcards"]';
  const at = html.indexOf(marker);
  if (at === -1) return [];
  const jsonStart = html.indexOf('{', at);
  if (jsonStart === -1) return [];
  const raw = extractJsonObject(html, jsonStart);
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    const results = data && data.metaData && data.metaData.mosaicProviderJobCardsModel
      && data.metaData.mosaicProviderJobCardsModel.results;
    return Array.isArray(results) ? results : [];
  } catch {
    return [];
  }
}

function indeedToItem(job) {
  if (!job.jobkey) return null;
  const jobTitle = (job.displayTitle || job.title || '').trim();
  const company = (typeof job.company === 'string' ? job.company : (job.companyName || '')).trim();
  const loc = job.formattedLocation || '';
  if (!jobTitle || !company) return null;
  if (!isOpeningJobTitle(jobTitle)) return null;
  // 監査と同一基準: 会社名が介護施設等のケースがあるため、職種名だけでなく会社名も含めて判定
  if (isNonFoodJob(`${company} ${jobTitle}`)) return null;
  const combined = `${company} ${jobTitle} ${loc}`;
  if (isChain(combined) || hasExcludeKeyword(combined)) return null;
  const area = detectArea(loc) || detectArea(combined);
  if (!loc.includes(ACTIVE_PREF.short) && !area) return null; // 対象県外の求人を除外
  const isCorporate = /株式会社|有限会社|合同会社|\(株\)|（株）/.test(company);
  const title = isCorporate
    ? `${company} オープニングスタッフ募集（${truncate(jobTitle, 30)}）`
    : `「${truncate(company, 30)}」オープニングスタッフ募集（${truncate(jobTitle, 30)}）`;
  // 監査と同一基準: エリア不明かつタイトルに県要素なし（勤務地が「県名のみ」等）は掲載しない
  if (!area && !isPrefRelevant(title)) return null;
  let pubDate = null;
  if (typeof job.pubDate === 'number') {
    const d = new Date(job.pubDate);
    if (!Number.isNaN(d.getTime())) pubDate = d.toUTCString();
  }
  return {
    title,
    link: `https://jp.indeed.com/viewjob?jk=${job.jobkey}`,
    source: 'Indeed',
    pubDate,
    area,
    genres: detectGenres(combined),
    signal: 'hiring',
    firstSeenAt: new Date().toISOString(),
  };
}

// Indeed公式コネクタ（Claude MCP）経由で取得した求人を既存アイテム形式へ変換する。
// スクレイピング版 indeedToItem と同じフィルタ・タイトル生成規則を適用すること。
// job: { title, company, location, postedOn, url } （merge-indeed.mjs 参照）
export function connectorJobToItem(job, pref = ACTIVE_PREF) {
  const jobTitle = (job.title || '').trim();
  const company = (job.company || '').trim();
  const loc = (job.location || '').trim();
  const link = (job.url || '').trim();
  if (!jobTitle || !company || !link) return null;
  if (!isOpeningJobTitle(jobTitle)) return null;
  // 監査と同一基準: 会社名が介護施設等のケースがあるため、職種名だけでなく会社名も含めて判定
  if (isNonFoodJob(`${company} ${jobTitle}`)) return null;
  const combined = `${company} ${jobTitle} ${loc}`;
  if (isChain(combined) || hasExcludeKeyword(combined)) return null;
  // 勤務地は「川崎市 中原区」のように分かち書きされるため、スペースを除去して区レベルまで判定する
  const area = detectArea(loc.replace(/\s+/g, ''), pref) || detectArea(combined, pref);
  if (!loc.includes(pref.short) && !area) return null; // 対象県外の求人を除外
  const isCorporate = /株式会社|有限会社|合同会社|\(株\)|（株）/.test(company);
  const title = isCorporate
    ? `${company} オープニングスタッフ募集（${truncate(jobTitle, 30)}）`
    : `「${truncate(company, 30)}」オープニングスタッフ募集（${truncate(jobTitle, 30)}）`;
  // 監査と同一基準: エリア不明かつタイトルに県要素なし（勤務地が「県名のみ」等）は掲載しない
  if (!area && !isPrefRelevant(title, pref)) return null;
  let pubDate = null;
  if (job.postedOn) {
    const d = new Date(job.postedOn);
    if (!Number.isNaN(d.getTime())) pubDate = d.toUTCString();
  }
  return {
    title,
    link,
    source: 'Indeed',
    pubDate,
    area,
    genres: detectGenres(combined),
    signal: 'hiring',
    firstSeenAt: new Date().toISOString(),
  };
}

async function collectIndeed() {
  const items = [];
  const runLog = [];
  try {
    const html = await fetchWithTimeout(INDEED_SEARCH_URL, FETCH_TIMEOUT_MS, BROWSER_USER_AGENT);
    const jobs = parseIndeedJobs(html);
    const converted = jobs.map(indeedToItem).filter(Boolean);
    runLog.push({ label: INDEED_LABEL, query: INDEED_SEARCH_URL, ok: true, count: converted.length });
    items.push(...converted);
  } catch (err) {
    runLog.push({ label: INDEED_LABEL, query: INDEED_SEARCH_URL, ok: false, error: String(err && err.message || err) });
    console.warn(`[warn] indeed failed: ${err}`);
  }
  return { items, runLog };
}

async function collect() {
  const queries = buildQueries();
  const collected = [];
  const runLog = [];

  for (const { label, query, signal } of queries) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ja&gl=JP&ceid=JP:ja`;
    try {
      const xml = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
      const items = parseRssItems(xml);
      runLog.push({ label, query, ok: true, count: items.length });
      for (const it of items) {
        const { title, source } = splitTitleSource(it.rawTitle, it.source);
        collected.push({ title, source, link: it.link, pubDate: it.pubDate, genreGroup: label, signal });
      }
    } catch (err) {
      runLog.push({ label, query, ok: false, error: String(err && err.message || err) });
      console.warn(`[warn] query failed: ${label} — ${err}`);
    }
  }
  return { collected, runLog };
}

export function normalizeForDedupe(title) {
  return title.replace(/\s+/g, '').replace(/[！!？?「」『』【】\[\]（）()]/g, '');
}

async function loadExisting() {
  try {
    const raw = await readFile(OUT_PATH, 'utf-8');
    const json = JSON.parse(raw);
    return {
      items: Array.isArray(json.items) ? json.items : [],
      hotpepper: json.hotpepper && typeof json.hotpepper === 'object' ? json.hotpepper : {},
      market: json.market && typeof json.market === 'object' ? json.market : {},
    };
  } catch {
    return { items: [], hotpepper: {}, market: {} };
  }
}

async function main() {
  const { collected, runLog } = await collect();
  const kyujinbox = await collectKyujinbox();
  const indeed = await collectIndeed();
  runLog.push(...kyujinbox.runLog, ...indeed.runLog);
  const jobItems = [...kyujinbox.items, ...indeed.items];

  const filtered = [];
  const seenLinks = new Set();
  const seenTitles = new Set();
  for (const it of collected) {
    if (!it.title) continue;
    if (isChain(it.title)) continue;
    if (hasExcludeKeyword(it.title)) continue; // 事件・犯罪ニュースや飲食店以外の業態を除外
    if (!isPrefRelevant(it.title)) continue;   // 本文だけに県名が出る他県記事を除外
    if (seenLinks.has(it.link)) continue;
    const norm = normalizeForDedupe(it.title);
    if (seenTitles.has(norm)) continue;
    seenLinks.add(it.link);
    seenTitles.add(norm);
    filtered.push({
      title: it.title,
      link: it.link,
      source: it.source || '',
      pubDate: it.pubDate,
      area: detectArea(it.title),
      genres: detectGenres(it.title),
      signal: it.signal || 'opening',
      firstSeenAt: new Date().toISOString(),
    });
  }

  // 求人サイト（求人ボックス・Indeed）の収集分をマージ（リンク・タイトルで重複排除）
  for (const it of jobItems) {
    if (!it.link || seenLinks.has(it.link)) continue;
    const norm = normalizeForDedupe(it.title);
    if (seenTitles.has(norm)) continue;
    seenLinks.add(it.link);
    seenTitles.add(norm);
    filtered.push(it);
  }

  // Googleニュースのリンクを実記事URLへ解決（社給アカウント等でnews.google.comが
  // 開けない環境でも記事を確認できるようにするため）
  await mapWithConcurrency(filtered, RESOLVE_CONCURRENCY, async (it) => {
    it.link = await resolveArticleUrl(it.link);
  });

  const prev = await loadExisting();
  // 既存データにも新しい除外基準を適用（過去に混入した事件記事等を掃除）
  const existingRaw = prev.items.filter(it =>
    !isChain(it.title) &&
    !hasExcludeKeyword(it.title) &&
    !(it.signal === 'hiring' && isNonFoodJob(it.title)) &&
    !(it.signal === 'hiring' && /リニューアル/.test(it.title)) &&
    !EXCLUDED_SOURCE_SITE_NAMES.some(name => (it.source || '').includes(name)) &&
    (it.area || isPrefRelevant(it.title))
  );
  await mapWithConcurrency(
    existingRaw.filter(it => it.link && it.link.includes('news.google.com')),
    RESOLVE_CONCURRENCY,
    async (it) => { it.link = await resolveArticleUrl(it.link); }
  );
  // area はタイトルから再検出しつつ、求人由来（勤務地から判定済み）の値は保持する
  const existing = existingRaw.map(it => ({ ...it, area: detectArea(it.title) || it.area || '', genres: detectGenres(it.title) }));
  const merged = new Map();
  for (const it of existing) merged.set(it.link, it);
  for (const it of filtered) {
    if (merged.has(it.link)) {
      // 既存分は firstSeenAt を保持
      merged.set(it.link, { ...it, firstSeenAt: merged.get(it.link).firstSeenAt });
    } else {
      merged.set(it.link, it);
    }
  }

  const cutoff = Date.now() - FEED_TTL_DAYS * 24 * 60 * 60 * 1000;
  let items = [...merged.values()].filter(it => {
    const d = it.pubDate ? Date.parse(it.pubDate) : Date.parse(it.firstSeenAt);
    return Number.isFinite(d) ? d >= cutoff : true;
  });
  items.sort((a, b) => {
    const da = Date.parse(a.pubDate || a.firstSeenAt) || 0;
    const db = Date.parse(b.pubDate || b.firstSeenAt) || 0;
    return db - da;
  });
  items = items.slice(0, 300);

  // 全クエリが失敗し、かつ既存データがあった場合は上書きせず既存を維持する
  const anyOk = runLog.some(r => r.ok);
  if (!anyOk && existing.length > 0) {
    console.warn('[warn] all queries failed; keeping existing data/stores.json unchanged');
    return;
  }

  const hotpepper = await enrichHotpepper(items, prev.hotpepper);
  const market = await enrichMarket(items, prev.market);

  const out = {
    generatedAt: new Date().toISOString(),
    ttlDays: FEED_TTL_DAYS,
    runLog,
    itemCount: items.length,
    hotpepper,
    market,
    items,
  };

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf-8');
  console.log(`Wrote ${items.length} items to ${OUT_PATH}`);
}

// 直接実行されたときのみ収集を実行（test-filters.mjs からの import 時は動かさない）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
