# qiita-kamo

Qiita / Qiita Team の記事を**ターミナルから全文検索・読み書き**するための、依存パッケージゼロの小さな CLI です。
記事をローカルにダウンロード・同期せず、API を直接叩きます。Qiita Team では**チーム全員の記事**を本文ごと横断検索できるので、蓄積された知見を（AI エージェントからも）すぐに引けます。Node.js 標準モジュールと `fetch` のみで動きます。

## 必要環境

- Node.js 18 以上

## セットアップ

1. このリポジトリで `npm install -g .` を実行し、`qiita-kamo` コマンドを使えるようにする。
2. 接続先を指定する（Qiita Team を使う場合）。カレントディレクトリの `.env` に書くか、環境変数で渡す。

   ```bash
   # .env
   QIITA_DOMAIN=<your-team>.qiita.com
   ```

   公開版 Qiita（qiita.com）の場合は `QIITA_DOMAIN` 未指定でOK。

3. アクセストークンを用意する。次のいずれか。
   - `qiita-kamo login` を実行し、対話入力で保存する（`~/.config/qiita-kamo/credentials.json`）
   - 環境変数 `QIITA_TOKEN=<token>` を渡す

## 使い方

```bash
# 読む
qiita-kamo list [--page N] [--per N]   # 記事一覧（番号・タイトル・ID・更新日）
qiita-kamo read <ID|番号>              # 記事を表示（長い記事は | less 推奨）
qiita-kamo search <キーワード>          # タイトル検索
qiita-kamo grep <キーワード>            # 本文を全文検索（著者・抜粋付き）
qiita-kamo tag <タグ名>                 # タグで検索
qiita-kamo group <グループ名>           # グループ（Qiita Team のカテゴリ相当）で検索

# 書く
qiita-kamo post <file.md>             # 新規投稿
qiita-kamo update <ID> <file.md>      # 既存記事を更新
```

### 投稿ファイルの形式

frontmatter で `title` / `tags` / `private` を指定します。

```markdown
---
title: 記事のタイトル
tags: Node.js, JavaScript
private: false
---

本文（Markdown）
```

## 仕組み

- 接続先 `QIITA_DOMAIN` から `https://<domain>/api/v2/...` を Bearer 認証で呼び出します。
- 一覧/検索/閲覧: `GET /api/v2/items`（Qiita Team では**全メンバーの記事**を返す）, `GET /api/v2/items/:id`
- 投稿/更新: `POST /api/v2/items`, `PATCH /api/v2/items/:id`
- `grep`（本文全文検索）・タグ/グループ検索は、一覧レスポンスに含まれる本文をクライアント側で横断します。

## ライセンス

MIT
