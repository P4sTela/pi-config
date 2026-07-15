---
name: okf-kb
description: Navigate, search, and author [Open Knowledge Format (OKF) v0.1](https://okf.md/spec/) knowledge bundles — directories of markdown files with YAML frontmatter (`type` required). Use when asked to find, list, query by tag/type/timestamp, traverse `related` links, validate, or create concept docs in an OKF bundle (e.g. a `docs/` tree with `okf_version` in its root `index.md`). Saves context by returning compact machine-readable summaries instead of reading many files.
---

# OKF Knowledge Bundle Navigator

[OKF v0.1](https://okf.md/spec/) 形式のナレッジバンドルを機械的に検索・作成・検証する。

**核心**: この SKILL の目的は**コンテキスト節約**。66 個の doc を全て `read` する代わりに、フロントマターだけを構造化抽出してタブ区切りで返す。質問に必要な 1〜2 doc だけを後で `read` すれば済む。

## Bundle の自動発見

cwd から上へ遡り、`index.md` の先頭フロントマターに `okf_version:` を含むディレクトリを bundle root とみなす（仕様 §11 準拠）。

確認済みの bundle:
- `/root/metaverse-over-moq/docs/` — MoQ 研究実験ナレッジベース（docs/index.md に `okf_version: "0.1"`）

ここは CLAUDE.md の docs 規約（OKF frontmatter / `index.md` / `YYYY-MM-DD-topic-description.md` 命名）そのまま。SKILL は汎用だが、このリポジトリでは docs/ が自動発見される。

## Components

- `scripts/okf-query.sh`   — 検索・一覧・横断（主役）
- `scripts/okf-new.sh`      — 新規 concept doc 雛形生成 + index.md 追記
- `scripts/okf-validate.sh` — frontmatter 必須項目・index 網羅性・broken `related` リンク検査

## 使い方

全スクリプトは bundle root を自動発見する（引数不要）。

### 検索（okf-query.sh）

```bash
# 一覧系 — path<TAB>type<TAB>title[<TAB>tags]
scripts/okf-query.sh list                          # 全 concept 一覧
scripts/okf-query.sh dirs                          # ディレクトリ別件数
scripts/okf-query.sh types                         # type 別集計
scripts/okf-query.sh tags                          # tag 出現頻度
scripts/okf-query.sh recent [N]                    # timestamp 降順上位 N（規定 10）

# 絞り込み
scripts/okf-query.sh tag <tag> [<tag> ...]         # 指定 tag を全て持つ doc（AND）
scripts/okf-query.sh type <type>                   # 指定 type の doc
scripts/okf-query.sh find <keyword>                # title/description/tags/body から検索

# 関連 traverse
scripts/okf-query.sh related <doc>                 # その doc の related 先（前方リンク）
scripts/okf-query.sh backlinks <doc>              # その doc を related に挙げている doc（逆リンク）
scripts/okf-query.sh graph <doc> [depth]           # related をたどる（規定 depth=2）

# 内容 peek
scripts/okf-query.sh show <doc>                    # frontmatter + 先頭 10 行（本体は読まない）
scripts/okf-query.sh meta <doc>                    # frontmatter のみ（構造化）
```

`<doc>` は bundle 相対（`03-analysis/foo.md`）でも絶対パスでも OK。`.md` は省略可。

### 作成（okf-new.sh）

```bash
scripts/okf-new.sh <dir> <filename> --type <type> --title '<title>' \
  [--desc '<description>'] [--tags 't1,t2'] [--related '/xx.md,/yy.md']
```

フロントマター付き空 doc を生成し、対応ディレクトリの `index.md` に末尾へ追記するエントリを追加。`timestamp` は現在時刻 `YYYY-MM-DDThh:mm:ssZ`。

### 検証（okf-validate.sh）

```bash
scripts/okf-validate.sh                  # conformance + index 網羅性 + broken related
scripts/okf-validate.sh --fix-index      # index.md に載っていない doc を警告のみ（自動修正なし、推奨形式を表示）
```

仕様 §9 conformance: 全 concept に `type` が必要。加えてこのリポジトリ規約では docs 毎の index.md 網羅性と `related` リンク切断を検出。

## 出力形式の規約

- 一覧はタブ区切り（パース容易・トークン削減）。1 行 1 doc。
- 本文は出さない。本文が必要なら出力された path をその後 `read` する。
- 色付けなし（パイプで grep/sort しやすく）。

## SKILL を使うべき局面

- 「ubiq 関連の分析を列挙して」「pose-sync の実験を時系列で」「この doc にリンクしてるのは誰？」等のナビゲーション
- docs/ 下に新規 doc を追加する時の雛形 + index.md 整合性維持
- docs/ の健全性チェック（CI 或いは作業前の前提確認）

## 使うべきでない局面

- 1 つの doc の中身を精読したい → ここは `read` で直接当たる
- docs 構造を文学的に記述したい → これはナビゲーション専用

## 参照

- `references/okf-spec-summary.md` — OKF v0.1 仕様要点（必要時にロード）

## 与えられた project 規約（この repo 限定の追加制約）

CLAUDE.md に基づく docs/ 運用規約。他の OKF bundle では一部当てはまらない点もあるが、本 SKILL の `okf-new.sh` は以下を守る:
- ファイル命名: `YYYY-MM-DD-topic-description.md` or `topic-guide.md`
- frontmatter: `type` / `title` / `description` / `tags` / `timestamp` / `related`
- `type`: 中央管理なしの自由記述（実装記録 / 実験ログ / 分析 / 設計ドキュメント / 検証レポート 等）
- `related`: bundle 相対パス（`/` 始まり）、明確な関連がある場合のみ
- 新規 doc 追加時は対応ディレクトリの `index.md` にも追記