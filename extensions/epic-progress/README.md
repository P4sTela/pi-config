# epic-progress

pi extension — 「大きめのタスク → 細分化 → 実行」の AI 駆動開発ワークフローで、
現在の進行状況を把握する画面を提供します。

## 機能

| 画面 | 内容 |
| ---- | ---- |
| エディタ上部ウィジェット | epic (親タスク) 単位の進捗サマリ。完了数、進行中 (activeForm)、ブロック中、残りを常時表示 |
| `/progress` コマンド | 詳細一覧 (タスク id / status / activeForm / blockedBy)。`/progress <キーワード>` で epic を絞り込み |

ウィジェット例:

```
● Progress (1/5)
▣ Add caching layer (1/4)
├─ ● in progress: impl (designing cache key)
├─ ⛓ blocked: integration test
└─ 1 pending
▣ Refactor CLI (0/1)
○ 1 uncategorized
```

## タスクモデル (rpiv-todo と統合)

rpiv-todo の `todo` ツールで作成するタスクをそのまま利用します。**実行時依存なし**
(tool 実行結果 `task_details` とセッション履歴から自前で state を再構築)。

- **epic (親タスク)**: 通常のタスク。子タスクから `metadata.epic` で参照される
- **子タスク**: `todo create` の `metadata` に `{ epic: <親タスク id> }` を指定
- 状態: `pending` / `in_progress` / `completed` / `deleted` (tombstone)
- 依存: `blockedBy` が未完了タスクを指す間は `blocked` として表示

### 使い方の流れ

```text
1. epic を作成 (todo create subject="Add caching layer")   → id 1
2. 子タスクを metadata.epic で紐付け
   (todo create subject="impl" metadata={ epic: 1, ... })
   (todo create subject="integration test" metadata={ epic: 1 })
3. todo update で status / activeForm / blockedBy を進めると
   ウィジェットと /progress が自動更新
4. epic 自体の status を completed にするとサマリから色が落ちる
   (children の進捗はそのまま表示)
```

## 開発

```bash
npm test          # node --test でユニットテスト (22 casos)
npx --yes -p typescript tsc --noEmit -p tsconfig.json   # 型チェック
```

- 実行時依存なし。開発時のみ `node_modules/` に `@earendil-works/*` の
  symlink を張って型解決 (tsc / LSP 用)
- 表示ロジックは `render.ts` / `selectors.ts` に純関数として分離し、
  `tests/` でテスト可能にしている

## インストール

`~/.pi/agent/extensions/*/index.ts` は pi が自動ロードするため、この
ディレクトリを置けば追加設定は不要です。
