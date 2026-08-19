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
- `order[]`   : 席順のプレイヤーID配列（ゲーム開始時に確定）。`rules.seatShuffle` が
                `"every"` なら毎回シャッフル、`"first"` なら初回の並びを `seatOrder` に
                覚えて引き継ぐ。**`currentTurnIndex` は `order` の添字**なので、
                開始プレイヤーを決めるときは必ず `order.indexOf(id)` から引くこと
                （`players` の添字と混同しない）
- `field`     : 場に出ているカード。`{kind:'set'|'stairs'|'joker', rank/startRank, count, cards[]}` か `null`
- `rules`     : `public/rules.js` の `buildDefaultRules()` から生成、ホストが `setRules` で変更
- `pending`   : 7渡し/10捨て/Qボンバーなどの保留アクション。`{type, playerId, count}`
- `classes`   : ゲーム終了後の階級マップ `{playerId: "大富豪"|...}`（都落ち判定に使う）

### 反則上がり（forbidden）の扱い

**手は止めない。** 禁止カードで上がろうとしても弾かず、そのまま上がらせて `foul: true`
を立て、順位だけ下位に回す（弾くと、その札しか持っていない人が永久に打てず進行が止まる）。

反則した順を `foulOrder`（room の `foulSeq` を採番）に控え、`checkGameEnd()` で
「無事故の人 → 反則した人」の順に並べ直す。反則者どうしは `foulOrder` 昇順、
つまり**あとに反則した人ほど下位**になる。

判定箇所は2つある。**両方を直さないと片方だけ素通りする**：

1. `applyPlay()` … 場に出して手札がゼロになった場合
2. `resolvePending()` … 7渡しで最後の札を渡した／10捨てで最後の札を捨てた場合。
   元の一手（7 / 10）で上がったのと同じとみなし、`forbidden.seven` /
   `forbidden.ten` で反則にする

### 手札ゼロなのに「上がっていない」状態を作らないこと

Qボンバーは他人の手札を抜くので、抜かれた側が手札ゼロになりうる。ここで
`finished` を立てないと、その人は**出す札もなく、場が空だとパスも拒否される**ため
手番が回った時点で進行が永久に止まる。`resolvePending()` のボンバー処理で
手札ゼロになった人はその場で上がり扱いにしている（自分の一手ではないので反則にしない）。

### ログの順序

`applyPlay()` では「出した手」のログを**上がり処理より先**に積む。逆にすると
反則の通知が出した手のログに上書きされ、画面は最新1行しか出さないため
プレイヤーが反則に気付けない。

各プレイヤーには自分の手札しか見えない（`sanitize()` でWebSocket送信時にマスク）。
`room.testMode === true` のときだけ全員の手札が見える（動作確認用）。

## CPU

`decideCPUMove()` が思考ロジック。同ランクの組み合わせしか使わない簡易版（階段・
Joker代用はしない）。Durable Objectの `alarm()` を使って1秒程度の間を置いて着手する。

## 開発者モード・テストモード

**`?dev=1` を付けてアクセスした端末にだけ**、ロビーに「開発者メニュー」が出る
（`localStorage` の `daifugo-dev` に記憶され、以後クエリなしでも表示される。
`?dev=0` で解除）。友達に渡す通常URLでは一切表示されない。判定はフロントの
`IS_DEV` 定数。

開発者メニューの中身：

- **テストモード** … 2人からでも開始でき、全員の手札が見え、誰の番でもホストが
  代わりに操作できる（`room.testMode`）
- **ダミー席** … 自動着手しない空席（`isDummy: true`）。CPUと違い `alarm()` の
  対象外なので、全員分を1画面で自分だけで動かせる。ダミー席が1つでもあると
  サーバー側で強制的にテストモードになり（`start` ハンドラ）、`rematch` 後も
  テストモードを維持する（連戦してもセットアップが崩れない）

CPU（`isCPU: true`）は本番機能なので、開発者モードでなくても誰でも追加できる。

## よくある作業

- 新しいローカルルールを足す → `rules.js` にエントリ追加 → `applyPlay()` に判定を実装
- CPUを賢くする → `decideCPUMove()` を拡張
- 見た目を変える → `public/index.html` の `<style>` (CSS変数で統一)
