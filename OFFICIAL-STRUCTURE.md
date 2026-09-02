# Zaikon 正式構成・運用ルール

最終確認日: 2026-08-10  
管理リポジトリ: `booandmoomoo1011-maker/zaiko-app`  
正式ブランチ: `main`  
公開先: `https://zaiko-app-two.vercel.app`

この文書をZaikonアプリの正式な構成基準とする。変更前には必ず本書と照合する。

## 1. 基本方針

- ソースの正式な更新先は `zaiko-app` の `main`。
- 各アプリは利用者が異なるため、画面・URL・保存領域を混ぜない。
- 「私の管理」は本人専用の入口であり、各利用者向けアプリそのものを統合しない。
- 「私の管理」に暗証番号は設けない。本人のみがURLとインストール済みアプリを使用する。
- 既存のLINE共有URLは、移行確認と転送設定なしに変更・削除しない。
- 旧ファイルと旧URLは互換性維持のため残す。利用状況を確認せず削除しない。

## 2. 通常利用の正式URL

| 区分 | ファイル | 利用者 | 正式URL |
|---|---|---|---|
| 私の管理 | `my-management.html` | 本人専用 | https://zaiko-app-two.vercel.app/my-management.html |
| 毎日在庫 | `index.html` | 在庫入力担当者 | https://zaiko-app-two.vercel.app/ |
| 在庫管理 | `inventory.html` | 在庫管理担当者 | https://zaiko-app-two.vercel.app/inventory.html |
| 仕入価格管理 | `price-management.html` | 棚卸管理者・店舗編集者 | https://zaiko-app-two.vercel.app/price-management.html |
| 売上入力 | `sales-input.html` | 売上入力担当者 | https://zaiko-app-two.vercel.app/sales-input.html |
| 売上オーナー | `sales-owner.html` | オーナー | https://zaiko-app-two.vercel.app/sales-owner.html |
| シフト・スタッフ | `shift-staff.html` | スタッフ | https://zaiko-app-two.vercel.app/shift-staff.html |
| シフト・オーナー | `shift-owner.html` | オーナー | https://zaiko-app-two.vercel.app/shift-owner.html |

## 3. 既存LINE共有URL

アプリ内部には、過去に配布した次のURLが残っている。通常利用URLと異なっていても、無断で置換しない。

| 用途 | 現在アプリ内で使用中の共有先 |
|---|---|
| 毎日在庫 | https://zaiko-app-two.vercel.app |
| 在庫管理 | https://booandmoomoo1011-maker.github.io/zaiko-app/inventory.html |
| 売上入力 | https://zaiko-app-two.vercel.app/sales-input.html?store=店舗名 |
| 売上オーナー（旧互換） | https://zaiko-app-two.vercel.app/owner.html |
| シフト・スタッフ（旧互換） | https://zaiko-app-two.vercel.app/shift/ |
| シフト・オーナー（旧互換） | https://zaiko-app-two.vercel.app/shift/owner.html |

店舗名はアプリ側でURLエンコードする。対象店舗は「那古野」「大須」「鉄板」「鎌倉」。

## 4. 「私の管理」

- 正式名称: 私の管理
- 現在の表示バージョン: v1.5
- URL: https://zaiko-app-two.vercel.app/my-management.html
- 目的: 本人がすべての独立アプリを一か所から開くための入口
- 各リンクはキャッシュ回避用の `_latest` パラメータを付けて開く
- PWA名: 私の管理
- アイコン: 修正版InBロゴ
- 起動画面背景: 黒
- アイコン仕様: 「株式会社」と月形を完全表示し、外側余白を黒にする

## 5. 互換用ファイル

次は古い共有先やショートカットを壊さないために残す。

- `owner.html`
- `shift/index.html`
- `shift/owner.html`
- その他、既に配布済みURLから参照されているファイル

互換用ファイルを削除・改名する場合は、先に利用者確認とリダイレクト設定を行う。

`owner.html` はURLを残したまま、認証を備えた正式な `sales-owner.html` へクエリ文字列とハッシュを保持して転送する。

## 6. 絶対に行わないこと

1. 異なる利用者向けアプリを一つの画面・一つのファイルへ統合しない。
2. `owner.html` という汎用名で新規アプリを追加しない。
3. 正式ファイル名を無断で変更しない。
4. LINE共有済みURLを確認せず変更しない。
5. 互換用ファイルを確認せず削除しない。
6. 保存キー、LocalStorage、IndexedDB、Cookieを確認せず変更・削除しない。
7. ブラウザの閲覧データやサイトデータの削除を安易に案内しない。
8. `zaiko-app` リポジトリを削除・改名しない。
9. Vercelプロジェクトを削除・切断しない。
10. ChatGPT Codex ConnectorをSuspendまたはUninstallしない。
11. 正式版と同名のアプリを別リポジトリで並行更新しない。
12. 一つの修正依頼で、対象外のアプリまで変更しない。

## 7. 更新前チェック

- 変更対象のアプリ名・ファイル名・利用者を確認
- 通常利用URLへの影響を確認
- LINE共有URLへの影響を確認
- 保存データと保存キーへの影響を確認
- 他アプリと同名ファイルにならないことを確認
- 対象外ファイルを変更しない
- 更新前のコミットを復元点として記録

## 8. 更新後チェック

- GitHub `main` への反映を確認
- Vercelのデプロイ成功を確認
- 正式URLが開くことを確認
- スタッフ画面とオーナー画面が分離されていることを確認
- LINE共有ボタンが意図したURLを生成することを確認
- 「私の管理」から各アプリが最新版で開くことを確認
- 既存データが維持されていることを確認

## 9. 更新依頼の標準文

```
zaiko-app の「対象アプリ名」を修正してください。
対象ファイルは「ファイル名」です。
他のアプリ、URL、保存データ、LINE共有先は変更しないでください。
OFFICIAL-STRUCTURE.md と照合し、更新後にVercelの成功を確認してください。
```

## 10. 現在のバージョンと確認基準

2026-08-10のGitHub記録確認時点:

- 私の管理: `v2.1`
- 毎日在庫: `v10.64`
- 在庫管理: `v4.9.0`
- 仕入価格管理: `v1.1.0`
- 売上入力: `v2.71`
- シフト・スタッフ: `v1.57`
- シフト・オーナー: `v1.66`

確認開始時の `main` コミット:

`d5a1dcab09d943d2b9669bd96d85b9255ec5893f`

問題発生時は破壊的操作をせず、このコミットと最新 `main` の差分を確認して原因を特定する。
