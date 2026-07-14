// 一時診断スクリプト: ホットペッパー店舗ページに実際にアクセスできるか、
// 「ネット予約」ボタン・空席カレンダーがHTML上どう表現されているかを確認する。
// 用が済んだら削除する（本番コードではない）。
const urls = [
  'https://www.hotpepper.jp/strJ004633975/',
  'https://www.hotpepper.jp/strJ003649532/',
  'https://www.hotpepper.jp/strJ004612468/',
];

const MARKERS = ['ネット予約', '空席', 'yoyaku', 'reserve', '電話予約', 'お問い合わせ'];

for (const url of urls) {
  console.log(`\n=== ${url} ===`);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
      signal: AbortSignal.timeout(15000),
    });
    console.log(`status: ${res.status}`);
    const html = await res.text();
    console.log(`length: ${html.length}`);
    for (const m of MARKERS) {
      const count = html.split(m).length - 1;
      console.log(`  "${m}": ${count} 回`);
    }
    // ネット予約ボタン周辺のスニペットを探す
    const idx = html.indexOf('ネット予約');
    if (idx >= 0) {
      console.log('--- snippet around ネット予約 ---');
      console.log(html.slice(Math.max(0, idx - 300), idx + 300).replace(/\s+/g, ' '));
    }
  } catch (err) {
    console.log(`error: ${err.message || err}`);
  }
}
