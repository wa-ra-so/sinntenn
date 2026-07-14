# 新店リサーチ（千葉・東京・神奈川・埼玉）

食べログ営業のメンバーが使う営業支援ツール。対象都県の新規開店飲食店を
毎朝自動収集し、GitHub Pagesで一覧表示する。**依存パッケージなし**（Node 20+の組み込みfetchのみ）。

- 公開URL: https://wa-ra-so.github.io/sinntenn/ （千葉県・デフォルト）
  - 東京都: `?pref=tokyo` / 神奈川県: `?pref=kanagawa` / 埼玉県: `?pref=saitama`
- アタックリスト: https://wa-ra-so.github.io/sinntenn/attack.html （ネット予約不可店。現状千葉のみ収集）
- 提案書セイセイ君: https://wa-ra-so.github.io/sinntenn/seiseikun.html （独立ツール）

## 構成

| ファイル | 役割 |
|---|---|
| `index.html` | 新店リサーチ画面（一覧・絞り込み・店舗詳細モーダル）。ビルドなしの素のHTML+JS。`?pref=`で県切替 |
| `attack.html` | ネット予約不可アタックリスト画面（期間・エリア・ジャンル絞り込み、CSV保存）。`data/hotpepper-reservation-lost*.json` を表示 |
| `seiseikun.html` | 提案書セイセイ君（独立ツール、新店リサーチとは無関係） |
| `shinten.html` | 旧URL向けリダイレクトスタブ（削除しない） |
| `scripts/prefectures.mjs` | 県設定（市区町村・駅名エイリアス・データファイル名）。**index.htmlのPREFSと対応を保つ** |
| `scripts/fetch-stores.mjs` | 収集スクリプト。`--pref=chiba\|tokyo\|kanagawa\|saitama`で県指定。Actionsから毎朝6:00 JST頃、4県分実行 |
| `scripts/test-filters.mjs` | フィルタ単体テスト＋公開前データ監査（全県分）。失敗すると公開が止まる |
| `scripts/merge-indeed.mjs` | Indeed公式コネクタ（Claude MCP）で集めた求人を県別データへマージ。毎朝のClaudeルーティンから実行 |
| `scripts/hotpepper-roster.mjs` | ホットペッパー全掲載店の台帳更新＋ネット予約可否チェック（現状千葉のみ・Actionsから毎朝実行） |
| `scripts/list-reservation-lost.mjs` | 台帳からネット予約不可になった店をアタックリストとして出力。`--csv=` でCSV書き出し |
| `data/stores.json` | 千葉県の収集済みデータ（直近60日・Actionsが自動コミット。手で編集しない） |
| `data/hotpepper-roster.json` | 千葉県のホットペッパー掲載台帳（店舗IDごとの firstSeenAt / lastSeenAt / reservable / reservableCheckedAt / lastReservableAt / reservationLostAt。Actionsが自動コミット） |
| `data/hotpepper-reservation-lost.json` | 台帳から抽出したネット予約不可店のみの軽量版（attack.html が読む） |
| `data/stores-tokyo.json` ほか | 東京・神奈川（`-kanagawa`）・埼玉（`-saitama`）の収集済みデータ（同上） |

## データソース（fetch-stores.mjs）

1. **Googleニュース検索RSS** — 開店ニュース・オープニング求人告知
2. **求人ボックス** — オープニングスタッフ求人。検索結果の `data-func-show-arg` 属性の
   埋め込みJSONをパース。タウンワーク・バイトル等の掲載もここ経由で入る
3. **Indeed** — 埋め込みJSON（mosaic-provider-jobcards）をパース。
   **Actionsランナーからは403でブロックされることが多い**が、仕様どおりスキップされる。
   このため主経路はIndeed公式コネクタ（Claude MCP）：毎朝のClaudeルーティンが
   `search_jobs`（オープニングスタッフ 飲食店 × 各都県）で4県分検索し、結果JSONを
   `scripts/merge-indeed.mjs --pref=◯◯` で県別データにマージする（フィルタは
   fetch-stores.mjs の `connectorJobToItem` に集約、収集基準は他ソースと同一）
4. **ホットペッパーAPI**（`HOTPEPPER_API_KEY` シークレット設定時のみ）—
   掲載チェック（●×）、掲載店の店舗詳細（住所・予算等）、商圏データ（エリア×ジャンル別の掲載店数）。
   加えて `hotpepper-roster.mjs` が県内全掲載店（千葉は約5,200店）の台帳を毎朝更新する。
   ※グルメサーチAPIにネット予約可否のフィールドは無いため、店舗ページ本体を取得し
   `<title>` タグの「＜ネット予約可＞」表記の有無で判定している（実ページで確認済み。
   Actionsランナーからhotpepper.jpへの直接アクセスは通る＝Indeedと違いブロックされない）。
   全店を毎日チェックすると重いため、未チェック・チェックが古い店から1日800件ずつ
   ローテーションで確認（約6〜7日で一巡）。ネット予約可→不可に変わった店を検出し、
   `lastReservableAt`（予約可能を最後に確認した日）と `reservationLostAt`
   （不可を検出した日）を記録する。**ローテーションのため「正確にいつ変わったか」は
   わからず、この2つの日付の間のどこかとしてしか特定できない**（掲載自体が終了した
   場合は台帳の掲載有無チェックが毎日走るため、その部分は1日単位で正確）。
   `list-reservation-lost.mjs` でアタックリスト出力できる。
   台帳の記録は2026-07-14開始で、それ以前には遡れない

## 重要な設計ルール

- **店名抽出 `extractStoreName` は `scripts/fetch-stores.mjs` と `index.html` の両方にあり、
  必ず同一ロジックを保つこと**（片方だけ変えるとHP掲載チェックのキーがずれる）
- 県を追加するとき: `scripts/prefectures.mjs` に県設定を足し、`index.html` の `PREFS` と
  ワークフローの県ループ、毎朝のClaudeルーティンの検索対象にも同じ県を足す（4箇所）
- 収集フィルタの判定順: チェーン除外 → 除外ワード → 千葉関連性。
  既存 `data/stores.json` にも毎回同じ基準を適用する（基準を強化すると過去の混入も自動で消える）
- 外部サイトのHTML構造変化で収集が失敗しても、他のソースは動き続ける設計
  （try/catchでrunLogにerrorを記録してスキップ）。全クエリ失敗時は既存データを上書きしない
- ページ入れ替え履歴: 元は `shinten.html` が新店リサーチ・`index.html` がセイセイ君だったが、
  ルートで新店リサーチを開くため入れ替えた（2026-07）

## 掲載品質（ユーザーからの重要な要望）

**飲食店の新店情報のみを掲載する。** 以下は絶対に掲載してはいけない：
- 事件・犯罪・行政処分ニュース（過去にガールズバー売春事件の記事が混入した）
- 倒産・破綻系の経済ニュース（過去に「全東信」破綻記事が混入した）
- ガールズバー・キャバクラ等の飲食店以外の業態
- 大手チェーン（本部一括契約のため提案対象外）
- 飲食以外の職種求人（過去にテレフォンオペレーター求人が混入した）
- タイトルに対象県の要素がない他県ニュース（各県のデータには当該県の情報のみ載せる）

新しい混入を見つけたら：`EXCLUDE_KEYWORDS` / `CHAIN_BLOCKLIST` / `NONFOOD_JOB_KEYWORDS`
（fetch-stores.mjs）に追加し、**そのタイトルを `test-filters.mjs` のテストケースにも追加**して再発防止する。

## 開発時の注意

- ローカルにNode/Pythonが無い環境で開発してきた。動作確認は
  **pushしてActionsで実行**するのが確実（`scripts/*.mjs` かワークフローの変更pushで自動実行される）
- 画面の確認は簡易HTTPサーバーで `index.html` を開く（`fetch('./data/stores.json')` があるため
  file:// では動かない）
- ワークフローの流れ: Test filters → Fetch → Audit → Commit。テストか監査が失敗すると
  公開されず、前日のデータが残る（安全側に倒れる）
- コミットメッセージは日本語でよい
