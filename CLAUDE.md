# daifugo-online

友達とスマホのブラウザで遊べる大富豪（President系トランプゲーム）。
Cloudflare Workers + Durable Objects でルームごとの対戦状態をリアルタイム同期する。

## 構成

```
wrangler.jsonc      Cloudflare設定（Durable Objects + 静的アセット配信）
src/index.js        Worker本体。DaifugoRoom (Durable Object) が1部屋=1インスタンス。
                     ゲームロジック（役判定・進行・CPU思考）はここに全部ある。
public/index.html   HTMLシェル。スタイル(CSS変数によるライト/ナイトテーマ)のみ。
public/app.js        フロントエンドのロジック（画面描画・WebSocket通信）。
public/rules.js       ルールカタログ。src/index.js と public/app.js の両方が
                     この1ファイルをimportして使う「ルール定義の唯一のソース」。
```

## ルールを追加/変更するとき

**必ず `public/rules.js` の `RULE_CATEGORIES` を編集する。** ここに1項目追加するだけで：
- デフォルト値（`buildDefaultRules()`）に自動で入る
- ロビー画面の設定パネルに自動でチェックボックス/セレクトが出る（カテゴリ単位で折りたたみ表示）
- サーバー側は `rules.xxx` でその値を参照できる

ルールの「効果」自体（例：8を出したら場が流れる、等）は `src/index.js` の
`applyPlay()` 内に条件分岐として実装する。`rules.js` にキーを足しただけでは
UIには出るが実際のゲーム挙動には反映されない点に注意（判定ロジックは別途実装が必要）。

判定ロジックの実装状況は `applyPlay()` 内のコメント（革命系／数字系／Joker・返し技／
縛り／上がり禁止 の各ブロック）を参照。

## デプロイ

GitHub連携（Cloudflare Workers Builds）済み。`main`ブランチにpushすると自動でビルド・
デプロイされる。手動デプロイしたい場合のみ：

```bash
npx wrangler deploy
```

`wrangler.jsonc` の `compatibility_date` は未来日付にするとデプロイが失敗する
（`[code: 10021]`）。今日以前の日付にしておくこと。

## データモデル（room オブジェクト）

Durable Objectの `this.room` がゲーム状態そのもの。主なフィールド：

- `players[]` : { id, name, hand[], handCount, finished, finishOrder, isCPU, foul }
- `order[]`   : 座席順のプレイヤーID配列（ゲーム開始時に確定）
- `field`     : 場に出ているカード。`{kind:'set'|'stairs'|'joker', rank/startRank, count, cards[]}` か `null`
- `rules`     : `public/rules.js` の `buildDefaultRules()` から生成、ホストが `setRules` で変更
- `pending`   : 7渡し/10捨て/Qボンバーなどの保留アクション。`{type, playerId, count}`
- `classes`   : ゲーム終了後の階級マップ `{playerId: "大富豪"|...}`（都落ち判定に使う）

各プレイヤーには自分の手札しか見えない（`sanitize()` でWebSocket送信時にマスク）。
`room.testMode === true` のときだけ全員の手札が見える（動作確認用）。

## CPU

`decideCPUMove()` が思考ロジック。同ランクの組み合わせしか使わない簡易版（階段・
Joker代用はしない）。Durable Objectの `alarm()` を使って1秒程度の間を置いて着手する。

## テストモード

ロビーでホストが「テストモード」をONにすると、2人からでも開始でき、全員の手札が
見え、誰の番でもホストが代わりに操作できる。デバッグ用。`rematch` で自動的にOFFに戻る。

## よくある作業

- 新しいローカルルールを足す → `rules.js` にエントリ追加 → `applyPlay()` に判定を実装
- CPUを賢くする → `decideCPUMove()` を拡張
- 見た目を変える → `public/index.html` の `<style>` (CSS変数で統一)
