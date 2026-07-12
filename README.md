# 千葉県 新店リサーチ

千葉県の新規開店情報（予約業態の飲食店）を毎朝自動収集し、GitHub Pagesで一覧表示するサイト。

- **公開URL**: https://wa-ra-so.github.io/sinntenn/shinten.html
- 提案書ジェネレーター（提案書セイセイ君）: https://wa-ra-so.github.io/sinntenn/index.html

## 仕組み

| ファイル | 役割 |
|---|---|
| `shinten.html` | 新店リサーチの画面（ダッシュボード・絞り込み・店舗詳細） |
| `scripts/fetch-stores.mjs` | Googleニュース検索RSS（開店ニュース）＋求人ボックス・Indeed（オープニングスタッフ求人）から収集し `data/stores.json` を更新 |
| `.github/workflows/update-shinten.yml` | 毎朝6:00 JST頃に自動実行（Actionsのcron） |
| `data/stores.json` | 収集済みデータ（直近60日分・自動コミット） |
| `index.html` | 提案書セイセイ君（独立ツール） |

## ホットペッパー掲載チェック（●×表示）を有効にする

各店舗がホットペッパーグルメに掲載済みか（＝ネット予約導入済みの可能性）を毎朝自動チェックし、一覧に「HP掲載 ●／HP未掲載 ×」を表示できます。

1. [リクルートWebサービス](https://webservice.recruit.co.jp/) でAPIキーを無料発行（メール登録のみ）
2. このリポジトリの **Settings → Secrets and variables → Actions → New repository secret** で
   - Name: `HOTPEPPER_API_KEY`
   - Secret: 発行されたキー
3. 翌朝の自動実行（またはActionsから手動実行）以降、●×が表示されます

キー未設定の間はこの機能はスキップされ、それ以外は通常どおり動作します。

- 掲載あり（●）の店は結果をそのまま保持、未掲載（×）の店は7日ごとに再チェックされます（開店後に掲載されるケースがあるため）
- ぐるなび・食べログは公開APIがないため自動チェック対象外です（店舗詳細からワンクリック検索で手動確認）

## メンテナンス

- **収集ジャンル・チェーン除外・エリア判定**は `scripts/fetch-stores.mjs` 冒頭の
  `GENRE_GROUPS` / `CHAIN_BLOCKLIST` / `CHIBA_AREAS` / `AREA_ALIASES` を編集
- **事件ニュース・対象外業態（ガールズバー等）の除外**は同ファイルの `EXCLUDE_KEYWORDS` を編集。
  タイトルに千葉要素（「千葉」または県内市区町村・駅名）が無い記事も自動除外される
- **オープニング求人の収集**は求人ボックスとIndeedの検索結果から取得
  （`KYUJINBOX_SEARCHES` / `INDEED_SEARCH_URL` で検索条件を編集）。
  どちらかのページ構造が変わって取得できなくなった場合も、他の収集は通常どおり動作する。
  タウンワークは検索ページがログインセッション必須のため直接収集していないが、
  掲載分の多くは求人ボックス経由でカバーされる
- 店名・開店日はニュース見出しから自動抽出しています。抽出ロジックは
  `scripts/fetch-stores.mjs` と `shinten.html` の `extractStoreName` を同一に保つこと
