// 一時診断(2回目): サイトの「掲載店検索一覧」の総件数を取得してAPI(5,228)と比較する。
// 用が済んだら削除する（本番コードではない）。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

for (const url of [
  'https://www.hotpepper.jp/SA14/lst/',        // PC 千葉県の検索一覧
  'https://www.hotpepper.jp/SA14/lst/bgn1/',   // 予備（ページ指定形式）
]) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000), redirect: 'follow' });
    console.log(`\n=== ${url} → HTTP ${res.status} (final: ${res.url}) ===`);
    if (!res.ok) continue;
    const html = await res.text();
    console.log('title:', (html.match(/<title>([^<]*)<\/title>/i) || [])[1]);
    // 総件数の表記（「全◯件」「◯件中」「検索結果 ◯件」等）周辺を出す
    const hits = [...html.matchAll(/.{0,80}[\d,]{3,7}\s*件.{0,30}/g)].slice(0, 12);
    for (const h of hits) console.log('  …' + h[0].replace(/\s+/g, ' ').replace(/<[^>]*>/g, '|'));
  } catch (e) {
    console.log(`${url} error: ${e.message}`);
  }
}
