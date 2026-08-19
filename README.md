# 大富豪オンライン - Cloudflare Workers版

友達それぞれのiPhoneのブラウザから遊べるオンライン大富豪。
Cloudflare Workers + Durable Objects でルームごとの対戦状態をリアルタイム同期（WebSocket）。

## 必要なもの
- Node.js（第2PCのセットアップで入れているものでOK）
- Cloudflareアカウント（無料枠で動きます）

## デプロイ手順

```bash
cd daifugo-cf
npm install -g wrangler   # 未インストールなら
wrangler login             # ブラウザでCloudflareにログイン
wrangler deploy
```

デプロイが終わると `https://daifugo-online.<あなたのサブドメイン>.workers.dev` のようなURLが発行されます。
このURLを友達に送るだけで、それぞれのiPhoneのSafari/Chromeから参加できます。

## 開発中の動作確認（任意）

```bash
wrangler dev
```
`http://localhost:8787` でローカル動作確認できます（別タブを複数開いて対戦テスト可能）。

## 構成

```
daifugo-cf/
├── wrangler.jsonc      # Cloudflare設定（Durable Objects + 静的アセット）
├── src/index.js        # Worker本体：ルーティング + ゲームロジック(Durable Object)
└── public/index.html   # フロントエンド（素のHTML/JS、ビルド不要）
```

- ルームの状態は Durable Object 1つ = 部屋1つ、で管理しています（`env.ROOM.idFromName(部屋コード)`）。
- 各プレイヤーのWebSocket接続ごとに、自分の手札だけ見える状態を送っています（他人の手札は見えません）。
- 状態は Durable Object の内蔵ストレージに永続化されるので、Workerが再起動しても部屋は消えません。

## 実装済みルール
3〜6人対応 / 同ランクの1〜4枚出し / あがり順位（大富豪〜大貧民）

ロビー画面の「ルール設定」（ホストのみ編集、表示/非表示を切り替え可能）で以下をオン/オフできます。

| ルール | 説明 | デフォルト |
|---|---|---|
| 革命 | 同じ数字4枚出しで強弱逆転 | ON |
| 8切り | 8を出すと場が流れ、続けて自分の番 | ON |
| スート縛り | 同じスートの1枚出しが連続すると、場が流れるまで縛られる | OFF |
| 階段 | 同じスートの連番3枚以上をまとめて出せる | OFF |
| スペ3返し | Joker単体に♠3で対抗して場を流す（ジョーカー1枚以上で意味を持つ） | OFF |
| 都落ち | 前回の大富豪が1位を逃すと大貧民に降格 | OFF |
| ジョーカー枚数 | 0/1/2枚。単体最強、同ランクの代用札にもなる | 0 |
| 反則上がり（2/8/Joker/♠3） | 該当カードを最後の一手にできない | 全てOFF |

## 未実装・簡略化している点（要望があれば追加します）
- 激レア系ローカルルール（ゾンビ、砂嵐、47切り、9リバース等の特殊効果カード群）
- 階段でのジョーカー代用（現状は階段は素の連番のみ）
- 反則上がりで詰み（他に出せる手がない）になった場合の救済処理
- 切断・再接続時の自動復帰の細かい調整

## カスタムドメインを使いたい場合
Cloudflareダッシュボード → Workers & Pages → 対象のWorker → Settings → Domains & Routes
から独自ドメインを割り当てられます。
