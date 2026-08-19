// ============================================================
//  大富豪 ルールカタログ（ここだけ編集すればルールを増減できます）
//  - サーバー（src/index.js）とブラウザ（app.js）が共通で読み込みます
//  - key はサーバー側の処理と一致させる必要があります
//  - group:"forbidden" の項目は rules.forbidden.xxx に入ります
// ============================================================

export const RULE_CATEGORIES = [
  {
    id: "basic",
    label: "1. 基本設定",
    rules: [
      { key: "jokerCount", label: "ジョーカー枚数", desc: "単体最強のカード", type: "select", default: 2,
        options: [{ v: 0, l: "0枚" }, { v: 1, l: "1枚" }, { v: 2, l: "2枚" }] },
      { key: "jokerSubstitute", label: "Joker代用", desc: "ペア・階段などの不足札の代わりに使える", type: "bool", default: true },
      { key: "passRestriction", label: "パス制限あり", desc: "一度パスすると場が流れるまで出せない", type: "bool", default: true },
      { key: "startCard", label: "開始プレイヤー", desc: "1手目を誰から始めるか", type: "select", default: "diamond3",
        options: [
          { v: "diamond3", l: "♦3を持つ人" },
          { v: "spade3", l: "♠3を持つ人" },
          { v: "heart3", l: "♥3を持つ人" },
          { v: "club3", l: "♣3を持つ人" },
          { v: "daihinmin", l: "前回の大貧民" },
          { v: "random", l: "ランダム" },
        ] },
      { key: "seatShuffle", label: "席順", desc: "手番が回る並び順を毎回入れ替えるか", type: "select", default: "every",
        options: [{ v: "every", l: "毎回シャッフル" }, { v: "first", l: "初回のみシャッフル" }] },
    ],
  },
  {
    id: "revolution",
    label: "2. 革命系",
    rules: [
      { key: "revolution", label: "革命", desc: "同じ数字を規定枚数出すと強弱が逆転", type: "bool", default: true },
      { key: "revolutionCards", label: "革命の成立枚数", desc: "何枚出しで革命になるか", type: "select", default: 4,
        options: [{ v: 3, l: "3枚" }, { v: 4, l: "4枚" }, { v: 5, l: "5枚" }] },
      { key: "kaidanRevolution", label: "階段革命", desc: "同じスートの連番4枚以上で革命", type: "bool", default: true },
      { key: "jokerRevolutionBan", label: "Joker革命禁止", desc: "Jokerを混ぜた組は革命として認めない", type: "bool", default: false },
      { key: "coupDetat", label: "クーデター（999）", desc: "9を3枚出すと革命", type: "bool", default: false },
      { key: "nanasan", label: "ナナサン革命（777）", desc: "7を3枚出すと革命", type: "bool", default: false },
      { key: "omen", label: "オーメン（666）", desc: "6を3枚で革命。以降の革命を封じる", type: "bool", default: false },
      { key: "superRevolution", label: "超革命", desc: "5枚以上出すと革命", type: "bool", default: false },
      { key: "nuke", label: "核爆弾", desc: "6枚以上で革命。以降は革命返し不可", type: "bool", default: false },
    ],
  },
  {
    id: "numbers",
    label: "3. 数字ごとの特殊効果",
    rules: [
      { key: "eightCut", label: "8切り", desc: "8を出すと場が流れ、続けて自分の番", type: "bool", default: true },
      { key: "fiveSkip", label: "5スキップ", desc: "5を出すと出した枚数分、次の人を飛ばす", type: "bool", default: false },
      { key: "sixBack", label: "6戻し", desc: "6を出すと場が流れるまで強弱が反転", type: "bool", default: false },
      { key: "sevenGive", label: "7渡し", desc: "7の枚数分、好きな手札を次の人に渡す", type: "bool", default: false },
      { key: "nineReverse", label: "9リバース", desc: "9を出すと手番の回転方向が逆になる", type: "bool", default: false },
      { key: "tenDiscard", label: "10捨て", desc: "10の枚数分、手札を捨てられる", type: "bool", default: false },
      { key: "elevenBack", label: "11バック（Jバック）", desc: "Jを出すと場が流れるまで強弱が反転", type: "bool", default: false },
      { key: "twelveBomber", label: "Qボンバー", desc: "数字を宣言し、全員にその数字を捨てさせる", type: "bool", default: false },
      { key: "twelveReverse", label: "12リバース", desc: "Qを出すと手番の回転方向が逆になる", type: "bool", default: false },
      { key: "thirteenSkip", label: "13スキップ", desc: "Kを出すと出した枚数分、次の人を飛ばす", type: "bool", default: false },
      { key: "ambulance", label: "救急車（99）", desc: "9を2枚出すと場が流れる", type: "bool", default: false },
      { key: "rokurokubi", label: "ろくろ首（66）", desc: "6を2枚出すと場が流れる", type: "bool", default: false },
      { key: "sandStorm", label: "砂嵐（333）", desc: "3を3枚出すとどんな場にも出せて場が流れる", type: "bool", default: false },
    ],
  },
  {
    id: "joker",
    label: "4. Joker・返し技",
    rules: [
      { key: "spade3Return", label: "スペ3返し", desc: "Joker単体に♠3を出して場を流せる", type: "bool", default: true },
      { key: "spade2Return", label: "スペ2返し", desc: "革命・11バック中はJokerに♠2を出せる", type: "bool", default: false },
      { key: "return33", label: "33返し", desc: "Joker単体に3を3枚出して流せる", type: "bool", default: false },
    ],
  },
  {
    id: "lock",
    label: "5. 縛り",
    rules: [
      { key: "suitLock", label: "スート縛り", desc: "同じスートが連続すると、そのスートしか出せない", type: "bool", default: true },
      { key: "suitLockCount", label: "縛りの成立回数", desc: "同じスートが何回続いたら縛るか", type: "select", default: 2,
        options: [{ v: 2, l: "2回縛り" }, { v: 3, l: "3回縛り" }] },
      { key: "numberLock", label: "数縛り", desc: "連番が出ると、次も1つ上の数字しか出せない", type: "bool", default: false },
      { key: "colorLock", label: "色縛り", desc: "同じ色が連続すると、その色しか出せない", type: "bool", default: false },
    ],
  },
  {
    id: "kaidan",
    label: "6. 階段",
    rules: [
      { key: "kaidan", label: "階段（ストレート）", desc: "同じスートの連番をまとめて出せる", type: "bool", default: true },
      { key: "kaidanMin", label: "階段の最低枚数", desc: "何枚から階段として認めるか", type: "select", default: 3,
        options: [{ v: 3, l: "3枚から" }, { v: 4, l: "4枚から" }] },
      { key: "kaidanEightCut", label: "階段8切り", desc: "8を含む階段でも8切りが発動する", type: "bool", default: false },
    ],
  },
  {
    id: "forbidden",
    label: "7. 上がり禁止（反則上がり）",
    note: "そのカードを最後の一手にできません。破ると最下位になります。",
    rules: [
      { key: "two", group: "forbidden", label: "2で上がり禁止", type: "bool", default: true },
      { key: "three", group: "forbidden", label: "3で上がり禁止（革命中）", type: "bool", default: false },
      { key: "eight", group: "forbidden", label: "8切りで上がり禁止", type: "bool", default: true },
      { key: "joker", group: "forbidden", label: "Jokerを含む上がり禁止", type: "bool", default: true },
      { key: "spade3", group: "forbidden", label: "♠3単体での上がり禁止", type: "bool", default: false },
      { key: "eleven", group: "forbidden", label: "Jで上がり禁止（11バック時）", type: "bool", default: false },
      { key: "ten", group: "forbidden", label: "10で上がり禁止（10捨て時）", type: "bool", default: false },
      { key: "seven", group: "forbidden", label: "7で上がり禁止（7渡し時）", type: "bool", default: false },
      { key: "revolutionAgari", group: "forbidden", label: "革命を起こしての上がり禁止", type: "bool", default: false },
    ],
  },
  {
    id: "rank",
    label: "8. 順位・階級",
    rules: [
      { key: "miyakoOchi", label: "都落ち", desc: "前回の大富豪が1位を逃すと大貧民に降格", type: "bool", default: true },
      { key: "gekokujo", label: "下剋上", desc: "大貧民が1位を取ると全員の階級が逆転", type: "bool", default: false },
      { key: "agariNagashi", label: "上がり流し", desc: "誰かが上がると、その場が強制的に流れる", type: "bool", default: false },
    ],
  },
  {
    id: "exchange",
    label: "9. カード交換",
    note: "2ゲーム目以降、前回の階級に応じてカードを交換します。",
    rules: [
      { key: "exchange", label: "カード交換", desc: "下位が強い札を渡し、上位が好きな札を返す", type: "select", default: "normal",
        options: [{ v: "normal", l: "通常交換" }, { v: "none", l: "交換なし" }] },
      { key: "tenpenchii", label: "天変地異", desc: "下位の手札が弱すぎる場合、上位と全交換", type: "bool", default: false },
      { key: "antiMonopoly", label: "独占禁止法", desc: "大富豪に2やJokerが集中しすぎたら配り直し", type: "bool", default: false },
    ],
  },
];

// --- カタログからデフォルト値を自動生成 ---
export function buildDefaultRules() {
  const out = { forbidden: {} };
  for (const cat of RULE_CATEGORIES) {
    for (const rule of cat.rules) {
      if (rule.group === "forbidden") out.forbidden[rule.key] = rule.default;
      else out[rule.key] = rule.default;
    }
  }
  return out;
}

// --- プリセット（ワンタップでまとめて設定） ---
export const PRESETS = [
  {
    id: "simple", label: "シンプル", desc: "革命と8切りだけ。初めての人向け",
    apply: { revolution: true, eightCut: true, kaidan: false, suitLock: false, spade3Return: false,
      jokerCount: 0, miyakoOchi: false, exchange: "none",
      forbidden: { two: false, eight: false, joker: false, spade3: false } },
  },
  {
    id: "standard", label: "標準（連盟五大ルール）", desc: "革命・8切り・都落ち・スート縛り・スペ3返し＋階段",
    apply: { revolution: true, eightCut: true, kaidan: true, suitLock: true, spade3Return: true,
      miyakoOchi: true, jokerCount: 2, exchange: "normal",
      forbidden: { two: true, eight: true, joker: true, spade3: false } },
  },
  {
    id: "party", label: "パーティー", desc: "標準＋11バック・5スキップ・7渡し・9リバース・10捨て・Qボンバー",
    apply: { revolution: true, eightCut: true, kaidan: true, suitLock: true, spade3Return: true, miyakoOchi: true,
      jokerCount: 2, elevenBack: true, fiveSkip: true, sevenGive: true, nineReverse: true,
      tenDiscard: true, twelveBomber: true, thirteenSkip: true, exchange: "normal",
      forbidden: { two: true, eight: true, joker: true, eleven: true, ten: true, seven: true } },
  },
  {
    id: "chaos", label: "全部入り", desc: "確認できたルールをほぼ全部ON。法令集モード",
    apply: (() => {
      const all = {};
      const fb = {};
      for (const cat of RULE_CATEGORIES) {
        for (const rule of cat.rules) {
          if (rule.type === "bool") {
            if (rule.group === "forbidden") fb[rule.key] = true;
            else all[rule.key] = true;
          }
        }
      }
      all.jokerCount = 2;
      all.exchange = "normal";
      all.startCard = "diamond3";
      all.jokerRevolutionBan = false; // 全部入りでも代用は活かす
      all.forbidden = fb;
      return all;
    })(),
  },
];
