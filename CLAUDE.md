# 新店リサーチ（千葉・東京・神奈川・埼玉）

食べログ営業のメンバーが使う営業支援ツール。対象都県の新規開店飲食店を
1日6回自動収集し、GitHub Pagesで一覧表示する。**依存パッケージなし**（Node 20+の組み込みfetchのみ）。

- 公開URL: https://wa-ra-so.github.io/sinntenn/ （千葉県・デフォルト）
  - 東京都: `?pref=tokyo` / 神奈川県: `?pref=kanagawa` / 埼玉県: `?pref=saitama`
- 提案書セイセイ君: https://wa-ra-so.github.io/sinntenn/seiseikun.html （独立ツール）

**アタックリスト（ネット予約不可店の検出）は姉妹リポジトリ [`hppzaiko`](https://github.com/wa-ra-so/hppzaiko)
に分離済み**（2026-07。https://wa-ra-so.github.io/hppzaiko/ ）。台帳更新（1日3回×4県×800件の
ローテーションチェック）が新店リサーチの更新ワークフローと同居して重かったため分けた。
**このリポジトリ（sinntenn）は新店リサーチのみを担当する。** アタックリスト関連のコード・データ
（`attack.html` / `scripts/hotpepper-roster.mjs` / `scripts/list-reservation-lost.mjs` /
`data/hotpepper-roster*.json` / `data/hotpepper-reservation-lost*.json`）は追加しないこと。

## 構成

| ファイル | 役割 |
|---|---|
| `index.html` | 新店リサーチ画面（一覧・絞り込み・店舗詳細モーダル）。ビルドなしの素のHTML+JS。`?pref=`で県切替 |
| `seiseikun.html` | 提案書セイセイ君（独立ツール、新店リサーチとは無関係） |
| `shinten.html` | 旧URL向けリダイレクトスタブ（削除しない） |
| `scripts/prefectures.mjs` | 県設定（市区町村・駅名エイリアス・データファイル名）。**index.htmlのPREFSと対応を保つ** |
| `scripts/fetch-stores.mjs` | 収集スクリプト。`--pref=chiba\|tokyo\|kanagawa\|saitama`で県指定。Actionsから1日6回（9:00〜19:00 JSTの勤務時間帯を2時間おき）、4県分実行 |
| `scripts/test-filters.mjs` | フィルタ単体テスト＋公開前データ監査（全県分）。失敗すると公開が止まる |
| `scripts/merge-indeed.mjs` | Indeed公式コネクタ（Claude MCP）で集めた求人を県別データへマージ。毎朝のClaudeルーティンから実行 |
| `.github/workflows/watchdog.yml` | 見張り番。本体（`update-shinten.yml`）のscheduleが発火しなかった場合に代わりに起動する（後述） |
| `data/stores.json` | 千葉県の収集済みデータ（直近60日・Actionsが自動コミット。手で編集しない） |
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
   新店ごとの掲載チェック（●×）、掲載店の店舗詳細（住所・予算等）、商圏データ
   （エリア×ジャンル別の掲載店数）。全掲載店の台帳管理・ネット予約可否チェック
   （アタックリスト用）は行わない（hppzaiko側の役割）。

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

### 見張り番（watchdog.yml）

姉妹リポジトリhppzaikoで、GitHub Actionsのscheduleトリガーが（公式が明言している
「毎時ちょうどは高負荷で遅延・スキップされうる」通り）4時間以上発火しなかった事象が
発生した。同じ保険をこちらにも導入した（2026-07）。

`update-shinten.yml`とは別の分（:07,:27,:47、UTC 0〜11時台＝JST 9時〜20時台）で
動き、本体と同じスケジュール（2時間おき）の直近の実行予定時刻を計算し、そこから
30分（収集・監査・コミットの所要時間を見込んだ猶予）経ってもいずれかの県データの
`generatedAt`が更新されていなければ、定期実行が発火しなかったとみなして
`update-shinten.yml`を`workflow_dispatch`で代わりに起動する。

夜間・早朝（19:00〜9:00 JST）は本体が動かない設計のため、単純な「最終更新からの
経過時間」では前日夜〜翌朝の正常な間隔を異常と誤判定してしまう。そのため
hppzaikoの実装（単純な経過時間チェック）とは異なり、「直近の実行予定スロット時刻」を
基準に判定している。本体ワークフローが実行中/待機中の場合は二重起動しない。
GitHub側のスケジューラが広範囲に停止した場合はwatchdog自身のscheduleも発火しない
ため100%の保証にはならない（あくまで発火しない時間を短く抑えるための保険）。
