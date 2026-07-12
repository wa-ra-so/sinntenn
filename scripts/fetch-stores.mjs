// 千葉県の新規開店情報（予約業態）を Google ニュース検索RSS から収集し、
// data/stores.json を更新するスクリプト。GitHub Actions から毎朝実行される想定。
// ホットペッパー掲載チェックは Actions シークレット HOTPEPPER_API_KEY 設定時のみ実行。
// （シークレットを削除・再作成後、再実行トリガー）
//
// 依存パッケージなし（Node 20+ の組み込み fetch のみ使用）。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, '..', 'data', 'stores.json');

// ── 収集対象ジャンル（予約ニーズの高い飲食業態。チェーンは後段で除外） ──
const GENRE_GROUPS = [
  { label: '居酒屋・ダイニング系', keywords: ['居酒屋', 'ダイニング', 'バル', 'レストラン', 'ビストロ'] },
  { label: '専門料理系',           keywords: ['焼肉', '寿司', '割烹', '懐石', '会席', '中華', '韓国料理', 'イタリアン', 'フレンチ'] },
  { label: 'カフェ・バー系',       keywords: ['カフェ', 'バー', 'スナック', '創作料理'] },
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
  // 倒産・破綻系の経済ニュース（新店情報ではない）
  '破綻', '倒産', '民事再生', '自己破産', '負債', '閉店ラッシュ', '全東信',
  // 飲食店の新店提案対象外の業態
  'ガールズバー', 'キャバクラ', 'キャバ嬢', 'ホストクラブ', 'セクキャバ', 'ラウンジ嬢',
  'メンズエステ', 'パチンコ', 'パチスロ', '風俗',
];

export function hasExcludeKeyword(title) {
  return EXCLUDE_KEYWORDS.some(w => title.includes(w));
}

// タイトルに千葉県の要素（「千葉」または県内の市区町村・駅名）が無い記事は、
// 本文だけに「千葉県」が出てくる他県ニュースの可能性が高いため除外する
export function isChibaRelevant(title) {
  return title.includes('千葉') || detectArea(title) !== '';
}

// ── 大手チェーン（既にネット予約導入済み・優先度が低いため除外） ──
const CHAIN_BLOCKLIST = [
  'マクドナルド', 'モスバーガー', 'バーガーキング', 'ロッテリア', 'ケンタッキー', 'KFC',
  'ミスタードーナツ', 'スターバックス', 'スタバ', 'ドトール', 'タリーズ', 'エクセルシオール',
  'サンマルクカフェ', 'コメダ珈琲', '星乃珈琲', '上島珈琲',
  'すき家', '吉野家', '松屋', 'なか卯', '餃子の王将', '日高屋', '丸亀製麺', 'はなまるうどん',
  '富士そば', 'てんや', 'かっぱ寿司', 'スシロー', 'くら寿司', 'はま寿司', 'がってん寿司',
  'ペッパーランチ', 'ステーキのどん', 'いきなりステーキ',
  'サイゼリヤ', 'ガスト', 'バーミヤン', 'ジョナサン', 'デニーズ', 'ロイヤルホスト', 'ジョイフル', 'ココス',
  'すかいらーく', 'ペルティカ',
  'びっくりドンキー', '鳥貴族', '磯丸水産', '白木屋', '笑笑', '魚民', '土間土間', '千年の宴',
  '塚田農場', 'わたみん家', '和民', '庄や', 'つぼ八', '日本海庄や',
  'しゃぶしゃぶ温野菜', '温野菜', '焼肉きんぐ', '丸源ラーメン', 'ゆず庵', '牛角', 'しゃぶ葉',
  'セブンイレブン', 'ファミリーマート', 'ローソン', 'ユニクロ', '無印良品', 'イオン', 'ドン・キホーテ',
];

// ── エリアタグ付け用の市区町村（長い名称を優先してマッチ） ──
const CHIBA_AREAS = [
  '千葉市中央区', '千葉市稲毛区', '千葉市美浜区', '千葉市若葉区', '千葉市緑区', '千葉市花見川区',
  '銚子市', '市川市', '船橋市', '館山市', '木更津市', '松戸市', '野田市', '茂原市', '成田市', '佐倉市',
  '東金市', '旭市', '習志野市', '柏市', '勝浦市', '市原市', '流山市', '八千代市', '我孫子市', '鴨川市',
  '鎌ケ谷市', '君津市', '富津市', '浦安市', '四街道市', '袖ケ浦市', '八街市', '印西市', '白井市', '富里市',
  '南房総市', '匝瑳市', '香取市', '山武市', 'いすみ市', '大網白里市',
  '酒々井町', '栄町', '神崎町', '多古町', '東庄町', '九十九里町', '芝山町', '横芝光町',
  '一宮町', '睦沢町', '長生村', '白子町', '長柄町', '長南町', '大多喜町', '御宿町', '鋸南町',
];

// 「市」等の付かない略称・駅名・地名からエリアを推定（長い候補を優先してマッチ）
const AREA_ALIASES = {
  '船橋':'船橋市', '柏':'柏市', '市川':'市川市', '松戸':'松戸市', '習志野':'習志野市', '八千代':'八千代市',
  '我孫子':'我孫子市', '印西':'印西市', '成田':'成田市', '佐倉':'佐倉市', '浦安':'浦安市', '市原':'市原市',
  '流山':'流山市', '野田':'野田市', '鴨川':'鴨川市', '富津':'富津市', '君津':'君津市', '木更津':'木更津市',
  '袖ケ浦':'袖ケ浦市', '袖ヶ浦':'袖ケ浦市', '八街':'八街市', '白井':'白井市', '鎌ケ谷':'鎌ケ谷市', '鎌ヶ谷':'鎌ケ谷市',
  '南房総':'南房総市', '館山':'館山市', '香取':'香取市', 'いすみ':'いすみ市', '匝瑳':'匝瑳市', '旭':'旭市',
  '銚子':'銚子市', '東金':'東金市', '山武':'山武市', '大網白里':'大網白里市', '四街道':'四街道市', '富里':'富里市',
  '中央区':'千葉市中央区', '稲毛区':'千葉市稲毛区', '美浜区':'千葉市美浜区', '若葉区':'千葉市若葉区',
  '緑区':'千葉市緑区', '花見川区':'千葉市花見川区',
  '幕張':'千葉市美浜区', '海浜幕張':'千葉市美浜区', '幕張本郷':'千葉市花見川区',
  '西船橋':'船橋市', '京成船橋':'船橋市', '下総中山':'船橋市', '東船橋':'船橋市', '高根公団':'船橋市', '北習志野':'船橋市',
  '津田沼':'習志野市', '新津田沼':'習志野市', '実籾':'習志野市',
  '八千代台':'八千代市', '勝田台':'八千代市', '東葉勝田台':'八千代市',
  '南柏':'柏市', '新柏':'柏市', '北柏':'柏市', '柏の葉キャンパス':'柏市',
  '五香':'松戸市', '元山':'松戸市', '馬橋':'松戸市', '新松戸':'松戸市', '北松戸':'松戸市', '八柱':'松戸市', '新八柱':'松戸市', '六実':'松戸市',
  '本八幡':'市川市', '妙典':'市川市', '行徳':'市川市', '南行徳':'市川市',
  '新浦安':'浦安市', '舞浜':'浦安市', '東京ディズニーリゾート':'浦安市', '東京ディズニーランド':'浦安市', '東京ディズニーシー':'浦安市',
  '新鎌ケ谷':'鎌ケ谷市',
  '成田空港':'成田市', '成田国際空港':'成田市',
  '天王台':'我孫子市',
  '稲毛':'千葉市稲毛区', '稲毛海岸':'千葉市美浜区', '検見川浜':'千葉市美浜区', '新検見川':'千葉市花見川区',
  '蘇我':'千葉市中央区', '鎌取':'千葉市緑区', '土気':'千葉市緑区', '誉田':'千葉市緑区',
};
const AREA_ALIAS_KEYS = Object.keys(AREA_ALIASES).sort((a, b) => b.length - a.length);

const FEED_TTL_DAYS = 60; // 何日分の情報を一覧に残すか
const FETCH_TIMEOUT_MS = 15000;

function buildQueries() {
  const openPart = `(${OPEN_SIGNAL.join(' OR ')})`;
  const hirePart = `(${HIRE_SIGNAL.join(' OR ')})`;
  const openQueries = GENRE_GROUPS.map(g => ({
    label: `${g.label}（開店ニュース）`,
    query: `千葉県 ${openPart} (${g.keywords.join(' OR ')})`,
    signal: 'opening',
  }));
  const hireQueries = GENRE_GROUPS.map(g => ({
    label: `${g.label}（オープニング求人）`,
    query: `千葉県 ${hirePart} (${g.keywords.join(' OR ')})`,
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

export function detectArea(title) {
  for (const area of CHIBA_AREAS) {
    if (title.includes(area)) return area;
  }
  for (const key of AREA_ALIAS_KEYS) {
    if (title.includes(key)) return AREA_ALIASES[key];
  }
  return '';
}

function detectGenres(title) {
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
    const inChiba = (s.address || '').includes('千葉県');
    return inChiba && (sn.includes(norm) || norm.includes(sn));
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
  'オープニングスタッフ-飲食店の仕事-千葉県',
];

// 求人検索は「飲食店」で絞っていても事務・コールセンター等の求人が混ざるため、職種名で弾く
const NONFOOD_JOB_KEYWORDS = [
  'コールセンター', 'テレフォンオペレーター', '事務', '受付', 'データ入力',
  '清掃', '介護', '警備', '軽作業', '工場', 'ドライバー', '配送', '引越', 'コンビニ',
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

function kyujinboxToItem(job) {
  const jobTitle = (job.title || '').trim();
  const company = (job.company || '').trim();
  const workArea = job.workArea || '';
  if (!company || !workArea.includes('千葉県')) return null;
  const tags = [...(job.allFeatureTags || []), ...(job.featureTagSp || [])];
  const isOpening = tags.includes('オープニング') || /オープニング|新規オープン|NEW\s*OPEN/i.test(jobTitle);
  if (!isOpening) return null;
  if (isNonFoodJob(jobTitle)) return null;
  const combined = `${company} ${jobTitle}`;
  if (isChain(combined) || hasExcludeKeyword(combined)) return null;
  // 会社名（株式会社等）でなく店舗名らしければ「」で囲み、店名抽出（extractStoreName）を効かせる
  const isCorporate = /株式会社|有限会社|合同会社|\(株\)|（株）/.test(company);
  const title = isCorporate
    ? `${company} オープニングスタッフ募集（${truncate(jobTitle, 30)}）`
    : `「${truncate(company, 30)}」オープニングスタッフ募集（${truncate(jobTitle, 30)}）`;
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
    area: detectArea(workArea) || detectArea(combined),
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
  encodeURIComponent('オープニングスタッフ 飲食店') + '&l=' + encodeURIComponent('千葉県');

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
  if (!/オープニング|新規\s*オープン|新規\s*OPEN|NEW\s*OPEN|完全新規/i.test(jobTitle)) return null;
  if (isNonFoodJob(jobTitle)) return null;
  const combined = `${company} ${jobTitle} ${loc}`;
  if (isChain(combined) || hasExcludeKeyword(combined)) return null;
  const area = detectArea(loc) || detectArea(combined);
  if (!loc.includes('千葉') && !area) return null; // 千葉県外の求人を除外
  const isCorporate = /株式会社|有限会社|合同会社|\(株\)|（株）/.test(company);
  const title = isCorporate
    ? `${company} オープニングスタッフ募集（${truncate(jobTitle, 30)}）`
    : `「${truncate(company, 30)}」オープニングスタッフ募集（${truncate(jobTitle, 30)}）`;
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

async function collectIndeed() {
  const items = [];
  const runLog = [];
  try {
    const html = await fetchWithTimeout(INDEED_SEARCH_URL, FETCH_TIMEOUT_MS, BROWSER_USER_AGENT);
    const jobs = parseIndeedJobs(html);
    const converted = jobs.map(indeedToItem).filter(Boolean);
    runLog.push({ label: 'Indeed（オープニングスタッフ 飲食店 千葉県）', query: INDEED_SEARCH_URL, ok: true, count: converted.length });
    items.push(...converted);
  } catch (err) {
    runLog.push({ label: 'Indeed（オープニングスタッフ 飲食店 千葉県）', query: INDEED_SEARCH_URL, ok: false, error: String(err && err.message || err) });
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

function normalizeForDedupe(title) {
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
    if (!isChibaRelevant(it.title)) continue;  // 本文だけ「千葉県」の他県記事を除外
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
    (it.area || isChibaRelevant(it.title))
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
