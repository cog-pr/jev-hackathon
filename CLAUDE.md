# Project Instructions

このファイルは Claude Code 向けのプロジェクト指示です。
詳細なプロダクト仕様は `仕様書.md` を参照してください。
実装前に必ず `仕様書.md` を確認してください。

## Core concept
このアプリの目的は Todo を管理することではない。

「今、何をやるか」という意思決定を
ユーザーの代わりに行うことを中心価値とする。

改善の評価基準は、
「機能が増えたか」ではなく、
「ユーザーの入力・判断をどれだけ減らせたか」。

## Domain model
Task と Schedule / Constraint を混同しないこと。

- Task:
  ユーザーが取り組む候補。
  Jev の優先順位判定対象。

- Schedule / Constraint:
  授業・バイトなど、利用可能時間を制約する情報。
  タスクとしてランキングしない。

予定機能を通常のカレンダーアプリへ拡張しないこと。

## Jev
ランキング本体は Jev の Score による priority 判定を使用する。

JavaScript側で複数シグナルに独自重みを付けて
ランキングを作らないこと。

Jevは生成AIチャットとして扱わず、
高速な構造化判断を頻繁に行うために使用する。

## Architecture
- Node.js
- Express
- Vanilla HTML / CSS / JavaScript
- TypeSafe SDK / Jev
- localStorage

UI改善だけを理由にReactやNext.jsへ移行しないこと。

## Security
- `TYPESAFE_API_KEY` は `.env` のみ
- APIキーをクライアントへ送らない
- `.env` をGit管理しない
- APIキーをログや回答に表示しない

## Development
既存機能を変更する前に関連コードを読むこと。

過剰なリファクタリングや、
要求されていない機能追加を避けること。

実装後は既存機能の動作確認を行うこと。

TypeSafe / Jev を変更する場合は、
利用可能な `typesafe:typesafe-ai` Skill を参照すること。