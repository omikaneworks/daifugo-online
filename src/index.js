// ============ 大富豪 サーバーロジック（全ルール対応版） ============
// ルールの一覧・初期値は public/rules.js が唯一の定義元です。
import { buildDefaultRules } from "../public/rules.js";

const SUITS = ["S", "H", "D", "C"];
const RANKS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]; // 15=2, 14=A
const JOKER_RANK = 16;
const RANK_LABEL = (r) => ({ 11: "J", 12: "Q", 13: "K", 14: "A", 15: "2", 16: "Joker" }[r] || String(r));
const IS_RED = (s) => s === "H" || s === "D";
// rules.startCard の「◯3を持つ人」指定と、そのスートの対応
const START_SUIT = { diamond3: "D", spade3: "S", heart3: "H", club3: "C" };

const DEFAULT_RULES = buildDefaultRules();

function buildDeck(jokerCount) {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ id: `${s}-${r}`, suit: s, rank: r });
  for (let i = 0; i < jokerCount; i++) deck.push({ id: `JOKER-${i}`, suit: "JOKER", rank: JOKER_RANK });
  return deck;
}
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
// 実効的な革命状態（革命 XOR 一時反転[11バック/6戻し]）
function effRev(r) {
  return !!r.revolution !== !!r.tempReverse;
}
function strength(rank, rev) {
  return rev ? -rank : rank;
}
function sortHand(hand, rev) {
  return [...hand].sort((a, b) => {
    const sa = a.suit === "JOKER" ? 999 : strength(a.rank, rev);
    const sb = b.suit === "JOKER" ? 999 : strength(b.rank, rev);
    return sa - sb;
  });
}
function rankTitle(order, total) {
  if (order === 1) return "大富豪";
  if (order === total) return "大貧民";
  if (total >= 4) {
    if (order === 2) return "富豪";
    if (order === total - 1) return "貧民";
  }
  return "平民";
}

export class DaifugoRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
    this.room = null;
  }

  async ensureLoaded() {
    if (!this.room) this.room = (await this.state.storage.get("room")) || null;
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected websocket", { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    await this.ensureLoaded();
    this.sessions.set(server, null);
    server.addEventListener("message", async (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      try { await this.handleMessage(server, msg); }
      catch (e) { server.send(JSON.stringify({ type: "error", message: "エラー: " + (e && e.message ? e.message : "不明") })); }
    });
    server.addEventListener("close", () => this.sessions.delete(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  async persistAndBroadcast() {
    await this.state.storage.put("room", this.room);
    for (const [ws, pid] of this.sessions.entries()) {
      try { ws.send(JSON.stringify({ type: "state", room: this.sanitize(pid) })); }
      catch { this.sessions.delete(ws); }
    }
  }

  sanitize(forPlayerId) {
    if (!this.room) return null;
    if (this.room.testMode) return this.room;
    return {
      ...this.room,
      players: this.room.players.map((p) => (p.id === forPlayerId ? p : { ...p, hand: undefined })),
    };
  }

  clearField(r) {
    r.field = null;
    r.suitLockActive = null;
    r.colorLockActive = null;
    r.numberLockActive = null;
    r.suitRunSuit = null;
    r.suitRunCount = 0;
    r.tempReverse = false;
    r.passedPlayers = [];
    r.passStreak = 0;
  }

  // ---------- メッセージ処理 ----------
  async handleMessage(ws, msg) {
    const { type, playerId } = msg;

    if (type === "create") {
      this.room = {
        code: msg.code, status: "waiting", hostId: playerId, testMode: false,
        players: [{ id: playerId, name: msg.name, hand: [], handCount: 0, finished: false, finishOrder: null }],
        order: [], seatOrder: null, field: null, direction: 1,
        suitLockActive: null, colorLockActive: null, numberLockActive: null,
        suitRunSuit: null, suitRunCount: 0,
        lastPlayerId: null, currentTurnIndex: 0, passStreak: 0, passedPlayers: [],
        revolution: false, tempReverse: false, revolutionLocked: false, foulSeq: 0,
        pending: null, adv: null, discardPile: [],
        rules: JSON.parse(JSON.stringify(DEFAULT_RULES)),
        classes: null, previousDaifugoId: null, demotedPlayerId: null,
        exchangeNeeded: [], exchangeGiven: {},
        log: [`${msg.name} が部屋を作成しました`],
      };
      this.sessions.set(ws, playerId);
      await this.persistAndBroadcast();
      return;
    }

    await this.ensureLoaded();
    if (!this.room) { ws.send(JSON.stringify({ type: "error", message: "部屋が見つかりません" })); return; }
    const r = this.room;

    if (type === "join") {
      this.sessions.set(ws, playerId);
      if (!r.players.some((p) => p.id === playerId)) {
        if (r.status !== "waiting") { ws.send(JSON.stringify({ type: "error", message: "すでにゲームが始まっています" })); return; }
        if (r.players.length >= 6) { ws.send(JSON.stringify({ type: "error", message: "満員です（最大6人）" })); return; }
        r.players.push({ id: playerId, name: msg.name, hand: [], handCount: 0, finished: false, finishOrder: null });
        r.log.push(`${msg.name} が参加しました`);
      }
      await this.persistAndBroadcast();
      return;
    }

    if (type === "setRules") {
      if (playerId !== r.hostId) { ws.send(JSON.stringify({ type: "error", message: "ホストだけが変更できます" })); return; }
      if (r.status !== "waiting") { ws.send(JSON.stringify({ type: "error", message: "開始後は変更できません" })); return; }
      const inc = msg.rules || {};
      r.rules = { ...r.rules, ...inc, forbidden: { ...r.rules.forbidden, ...(inc.forbidden || {}) } };
      r.log.push("ルールを変更しました");
      await this.persistAndBroadcast();
      return;
    }

    if (type === "addCPU") {
      if (playerId !== r.hostId || r.status !== "waiting") return;
      if (r.players.length >= 6) { ws.send(JSON.stringify({ type: "error", message: "満員です" })); return; }
      const n = r.players.filter((p) => p.isCPU).length + 1;
      r.players.push({ id: `cpu-${n}-${Date.now()}`, name: `CPU ${n}`, isCPU: true, hand: [], handCount: 0, finished: false, finishOrder: null });
      r.log.push(`CPU ${n} が参加しました`);
      await this.persistAndBroadcast();
      return;
    }

    if (type === "removeCPU") {
      if (playerId !== r.hostId || r.status !== "waiting") return;
      for (let i = r.players.length - 1; i >= 0; i--) if (r.players[i].isCPU) { r.players.splice(i, 1); break; }
      await this.persistAndBroadcast();
      return;
    }

    // ダミー席：自動着手しない空席。テストモードでホストが全員分を手動操作するためのもの
    if (type === "addDummy") {
      if (playerId !== r.hostId || r.status !== "waiting") return;
      if (r.players.length >= 6) { ws.send(JSON.stringify({ type: "error", message: "満員です" })); return; }
      const n = r.players.filter((p) => p.isDummy).length + 1;
      r.players.push({ id: `dummy-${n}-${Date.now()}`, name: `ダミー ${n}`, isDummy: true, hand: [], handCount: 0, finished: false, finishOrder: null });
      r.log.push(`ダミー ${n} を追加しました`);
      await this.persistAndBroadcast();
      return;
    }

    if (type === "removeDummy") {
      if (playerId !== r.hostId || r.status !== "waiting") return;
      for (let i = r.players.length - 1; i >= 0; i--) if (r.players[i].isDummy) { r.players.splice(i, 1); break; }
      await this.persistAndBroadcast();
      return;
    }

    if (type === "start") {
      // ダミー席は誰も自動で着手しないので、あるときは必ずテストモードで動かす
      const testMode = !!msg.testMode || r.players.some((p) => p.isDummy);
      const min = testMode ? 2 : 3;
      if (r.players.length < min) { ws.send(JSON.stringify({ type: "error", message: `${min}人以上必要です` })); return; }
      r.testMode = testMode;
      this.dealAndStart();
      await this.persistAndBroadcast();
      await this.maybeScheduleCPU();
      return;
    }

    if (type === "play") {
      const actor = r.testMode && msg.asPlayerId ? msg.asPlayerId : playerId;
      const res = this.applyPlay(actor, msg.cards);
      if (!res.ok) { ws.send(JSON.stringify({ type: "error", message: res.message })); return; }
      await this.persistAndBroadcast();
      await this.maybeScheduleCPU();
      return;
    }

    if (type === "pass") {
      const actor = r.testMode && msg.asPlayerId ? msg.asPlayerId : playerId;
      const res = this.applyPass(actor);
      if (!res.ok) { ws.send(JSON.stringify({ type: "error", message: res.message })); return; }
      await this.persistAndBroadcast();
      await this.maybeScheduleCPU();
      return;
    }

    if (type === "resolve") {
      const actor = r.testMode && msg.asPlayerId ? msg.asPlayerId : playerId;
      const res = this.resolvePending(actor, msg.payload);
      if (!res.ok) { ws.send(JSON.stringify({ type: "error", message: res.message })); return; }
      await this.persistAndBroadcast();
      await this.maybeScheduleCPU();
      return;
    }

    if (type === "exchange") {
      const actor = r.testMode && msg.asPlayerId ? msg.asPlayerId : playerId;
      const res = this.submitExchange(actor, msg.cards);
      if (!res.ok) { ws.send(JSON.stringify({ type: "error", message: res.message })); return; }
      await this.persistAndBroadcast();
      await this.maybeScheduleCPU();
      return;
    }

    if (type === "rematch") {
      r.status = "waiting";
      // ダミー席が残っている間はテストモードを維持する（開発中の連戦用）
      r.testMode = r.players.some((p) => p.isDummy);
      r.players = r.players.map((p) => ({ ...p, hand: [], handCount: 0, finished: false, finishOrder: null }));
      this.clearField(r);
      r.pending = null; r.adv = null; r.discardPile = [];
      r.log = ["次のゲームの準備中..."];
      await this.persistAndBroadcast();
      return;
    }
  }

  // ---------- 配札・開始 ----------
  // 席順（手番が回る並び）を決める。
  // "first"（初回のみ）は前回の並びを引き継ぎ、後から入った人だけ後ろに足す。
  buildSeatOrder() {
    const r = this.room;
    const ids = r.players.map((p) => p.id);
    if (r.rules.seatShuffle === "first" && Array.isArray(r.seatOrder) && r.seatOrder.length) {
      const kept = r.seatOrder.filter((id) => ids.includes(id));
      const added = shuffle(ids.filter((id) => !kept.includes(id)));
      return [...kept, ...added];
    }
    return shuffle(ids);
  }

  dealAndStart() {
    const r = this.room;
    const rules = r.rules;
    const deck = shuffle(buildDeck(rules.jokerCount));
    const order = this.buildSeatOrder();
    r.seatOrder = order;
    const hands = Object.fromEntries(order.map((id) => [id, []]));
    deck.forEach((c, i) => hands[order[i % order.length]].push(c));

    r.players = r.players.map((p) => ({
      ...p, hand: sortHand(hands[p.id], false), handCount: hands[p.id].length,
      finished: false, finishOrder: null, foul: false, foulOrder: null,
    }));
    r.foulSeq = 0;
    r.order = order;
    r.direction = 1;
    r.revolution = false;
    r.revolutionLocked = false;
    r.demotedPlayerId = null;
    r.pending = null; r.adv = null; r.discardPile = [];
    this.clearField(r);

    // 独占禁止法：大富豪に2/Jokerが4枚以上集中していたら再配布
    if (rules.antiMonopoly && r.classes) {
      const top = r.players.find((p) => r.classes[p.id] === "大富豪");
      if (top) {
        const strong = top.hand.filter((c) => c.suit === "JOKER" || c.rank === 15).length;
        if (strong >= 4) { r.log.push("独占禁止法により配り直し"); return this.dealAndStart(); }
      }
    }

    // 開始プレイヤー（currentTurnIndex は order の添字なので、必ず order から引く）
    let startIdx = 0;
    const startSuit = START_SUIT[rules.startCard];
    if (startSuit) {
      const holder = r.players.find((p) => p.hand.some((c) => c.suit === startSuit && c.rank === 3));
      if (holder) {
        const i = order.indexOf(holder.id);
        if (i >= 0) startIdx = i;
      }
    } else if (rules.startCard === "daihinmin" && r.classes) {
      const p = r.players.find((pl) => r.classes[pl.id] === "大貧民");
      if (p) {
        const i = order.indexOf(p.id);
        if (i >= 0) startIdx = i;
      }
    } else if (rules.startCard === "random") {
      startIdx = Math.floor(Math.random() * order.length);
    }
    r.currentTurnIndex = startIdx;
    r.lastPlayerId = order[startIdx];

    // カード交換フェーズ
    if (r.classes && rules.exchange === "normal") {
      this.setupExchange();
      if (r.status === "exchange") { r.log = ["カード交換フェーズ"]; return; }
    }
    r.status = "playing";
    r.log = ["ゲーム開始！"];
  }

  setupExchange() {
    const r = this.room;
    const cls = r.classes;
    const total = r.players.length;
    const find = (t) => r.players.find((p) => cls[p.id] === t);
    const pairs = [];
    const dai = find("大富豪"), hin = find("大貧民");
    if (dai && hin) pairs.push({ upper: dai, lower: hin, n: 2 });
    if (total >= 4) {
      const fu = find("富豪"), bin = find("貧民");
      if (fu && bin) pairs.push({ upper: fu, lower: bin, n: 1 });
    }
    if (pairs.length === 0) return;

    r.exchangeNeeded = [];
    r.exchangeGiven = {};
    for (const { upper, lower, n } of pairs) {
      // 天変地異：下位の手札が全部弱い場合は全交換
      if (r.rules.tenpenchii) {
        const hasStrong = lower.hand.some((c) => c.suit === "JOKER" || c.rank >= 14);
        if (!hasStrong) {
          const tmp = upper.hand; upper.hand = lower.hand; lower.hand = tmp;
          upper.handCount = upper.hand.length; lower.handCount = lower.hand.length;
          r.log.push(`天変地異！ ${upper.name} と ${lower.name} が手札を全交換`);
          continue;
        }
      }
      // 下位は強い順に自動で差し出す
      const sorted = sortHand(lower.hand, false);
      const give = sorted.slice(-n);
      lower.hand = sorted.slice(0, sorted.length - n);
      upper.hand = sortHand([...upper.hand, ...give], false);
      lower.handCount = lower.hand.length; upper.handCount = upper.hand.length;
      // 上位は自分で選んで返す
      r.exchangeNeeded.push({ upperId: upper.id, lowerId: lower.id, n });
    }
    if (r.exchangeNeeded.length > 0) r.status = "exchange";
  }

  submitExchange(playerId, cards) {
    const r = this.room;
    if (r.status !== "exchange") return { ok: false, message: "交換フェーズではありません" };
    const task = r.exchangeNeeded.find((t) => t.upperId === playerId);
    if (!task) return { ok: false, message: "あなたの交換ではありません" };
    if (!cards || cards.length !== task.n) return { ok: false, message: `${task.n}枚選んでください` };
    const upper = r.players.find((p) => p.id === task.upperId);
    const lower = r.players.find((p) => p.id === task.lowerId);
    for (const c of cards) if (!upper.hand.some((h) => h.id === c.id)) return { ok: false, message: "手札にないカードです" };

    upper.hand = upper.hand.filter((h) => !cards.some((c) => c.id === h.id));
    lower.hand = sortHand([...lower.hand, ...cards], false);
    upper.handCount = upper.hand.length; lower.handCount = lower.hand.length;
    r.exchangeNeeded = r.exchangeNeeded.filter((t) => t.upperId !== playerId);
    r.log.push(`${upper.name} が ${lower.name} にカードを返しました`);

    if (r.exchangeNeeded.length === 0) { r.status = "playing"; r.log.push("ゲーム開始！"); }
    return { ok: true };
  }

  // ---------- 役判定 ----------
  classify(cards, r) {
    const rules = r.rules;
    const jokers = cards.filter((c) => c.suit === "JOKER");
    const reals = cards.filter((c) => c.suit !== "JOKER");
    if (reals.length === 0 && jokers.length > 0) return { kind: "joker", count: cards.length };

    // 同ランク（Jokerを代用として許容）
    const allSame = reals.every((c) => c.rank === reals[0].rank);
    if (allSame && (jokers.length === 0 || rules.jokerSubstitute)) {
      return { kind: "set", rank: reals[0].rank, count: cards.length, jokers: jokers.length };
    }
    // 階段
    if (rules.kaidan && cards.length >= rules.kaidanMin) {
      const st = this.tryStairs(reals, jokers.length, rules);
      if (st) return st;
    }
    return null;
  }

  tryStairs(reals, jokerCount, rules) {
    if (reals.length === 0) return null;
    const suits = new Set(reals.map((c) => c.suit));
    if (suits.size !== 1) return null;
    const ranks = [...reals.map((c) => c.rank)].sort((a, b) => a - b);
    for (let i = 1; i < ranks.length; i++) if (ranks[i] === ranks[i - 1]) return null;
    const span = ranks[ranks.length - 1] - ranks[0] + 1;
    const total = reals.length + jokerCount;
    if (!rules.jokerSubstitute && jokerCount > 0) return null;
    const gaps = span - reals.length;
    if (gaps > jokerCount) return null;
    const extra = jokerCount - gaps; // 端に付ける分
    const len = span + extra;
    if (len !== total) return null;
    return { kind: "stairs", suit: reals[0].suit, startRank: ranks[0] - extra, count: total, ranks: ranks, jokers: jokerCount };
  }

  // ---------- カードを出す ----------
  applyPlay(playerId, cards) {
    const r = this.room;
    const rules = r.rules;
    if (r.status !== "playing") return { ok: false, message: "ゲーム中ではありません" };
    if (r.pending) return { ok: false, message: "先に処理を完了してください" };
    if (r.order[r.currentTurnIndex] !== playerId) return { ok: false, message: "あなたの番ではありません" };
    if (!cards || cards.length === 0) return { ok: false, message: "カードを選んでください" };

    const me = r.players.find((p) => p.id === playerId);
    for (const c of cards) if (!me.hand.some((h) => h.id === c.id)) return { ok: false, message: "手札にないカードです" };

    const play = this.classify(cards, r);
    if (!play) return { ok: false, message: "出せる組み合わせではありません" };

    const rev = effRev(r);
    const reals = cards.filter((c) => c.suit !== "JOKER");

    // --- 特殊な返し技 ---
    const fieldIsSoloJoker = r.field && r.field.kind === "joker" && r.field.count === 1;
    const isSpade3Return = rules.spade3Return && fieldIsSoloJoker &&
      cards.length === 1 && cards[0].suit === "S" && cards[0].rank === 3;
    const isSpade2Return = rules.spade2Return && fieldIsSoloJoker && rev &&
      cards.length === 1 && cards[0].suit === "S" && cards[0].rank === 15;
    const is33Return = rules.return33 && fieldIsSoloJoker &&
      cards.length === 3 && reals.length === 3 && reals.every((c) => c.rank === 3);
    const isSandStorm = rules.sandStorm && cards.length === 3 && reals.length === 3 && reals.every((c) => c.rank === 3);
    const bypass = isSpade3Return || isSpade2Return || is33Return || isSandStorm;

    // --- 通常の場との比較 ---
    if (!bypass && r.field) {
      const f = r.field;
      if (play.kind === "joker") {
        if (f.count !== play.count) return { ok: false, message: "枚数を合わせてください" };
      } else if (play.kind === "stairs") {
        if (f.kind !== "stairs") return { ok: false, message: "階段を出してください" };
        if (f.count !== play.count) return { ok: false, message: `${f.count}枚の階段を出してください` };
        if (strength(play.startRank, rev) <= strength(f.startRank, rev)) return { ok: false, message: "場より強い階段を出してください" };
      } else {
        if (f.kind === "stairs") return { ok: false, message: "階段を出してください" };
        if (f.count !== play.count) return { ok: false, message: `${f.count}枚で出してください` };
        if (f.kind === "joker") {
          // Joker場には通常札で勝てない
          return { ok: false, message: "Jokerには勝てません" };
        }
        if (strength(play.rank, rev) <= strength(f.rank, rev)) return { ok: false, message: "場より強いカードを出してください" };
      }
      // 縛りチェック
      if (play.kind === "set" && reals.length > 0) {
        if (rules.suitLock && r.suitLockActive) {
          if (!reals.every((c) => c.suit === r.suitLockActive))
            return { ok: false, message: `スート縛り中：${r.suitLockActive}のみ` };
        }
        if (rules.colorLock && r.colorLockActive) {
          if (!reals.every((c) => (IS_RED(c.suit) ? "red" : "black") === r.colorLockActive))
            return { ok: false, message: `色縛り中：${r.colorLockActive === "red" ? "赤" : "黒"}のみ` };
        }
        if (rules.numberLock && r.numberLockActive != null) {
          if (play.rank !== r.numberLockActive) return { ok: false, message: `数縛り中：${RANK_LABEL(r.numberLockActive)}のみ` };
        }
      }
    }

    // --- 上がり禁止（反則上がり）チェック ---
    const newHand = me.hand.filter((c) => !cards.some((s) => s.id === c.id));
    let foul = false;
    if (newHand.length === 0) {
      const fb = rules.forbidden;
      const has = (rk) => reals.some((c) => c.rank === rk);
      const willRevolt = rules.revolution && play.kind === "set" && play.count >= rules.revolutionCards;
      if (fb.joker && cards.some((c) => c.suit === "JOKER")) foul = true;
      if (fb.two && !rev && has(15)) foul = true;
      if (fb.three && rev && has(3)) foul = true;
      if (fb.eight && rules.eightCut && has(8)) foul = true;
      if (fb.spade3 && cards.length === 1 && cards[0].suit === "S" && cards[0].rank === 3) foul = true;
      if (fb.eleven && rules.elevenBack && has(11)) foul = true;
      if (fb.ten && rules.tenDiscard && has(10)) foul = true;
      if (fb.seven && rules.sevenGive && has(7)) foul = true;
      if (fb.revolutionAgari && willRevolt) foul = true;
    }

    // ===== ここから確定処理 =====
    me.hand = newHand;
    me.handCount = newHand.length;
    r.discardPile.push(...cards);

    let cut = false;     // 場を流すか
    let skip = 0;        // 次に飛ばす人数
    let logExtra = "";

    // --- 革命判定 ---
    if (!r.revolutionLocked) {
      let revolt = false;
      if (rules.revolution && play.kind === "set" && play.count >= rules.revolutionCards) revolt = true;
      if (rules.superRevolution && play.count >= 5) revolt = true;
      if (rules.kaidanRevolution && play.kind === "stairs" && play.count >= 4) revolt = true;
      if (rules.coupDetat && play.kind === "set" && play.rank === 9 && play.count === 3) revolt = true;
      if (rules.nanasan && play.kind === "set" && play.rank === 7 && play.count === 3) revolt = true;
      if (rules.omen && play.kind === "set" && play.rank === 6 && play.count === 3) revolt = true;
      if (rules.jokerRevolutionBan && (play.jokers || 0) > 0) revolt = false;
      if (rules.nuke && play.count >= 6) { revolt = true; r.revolutionLocked = true; logExtra += "（核爆弾）"; }
      if (revolt) {
        r.revolution = !r.revolution;
        logExtra += r.revolution ? "（革命！）" : "（革命返し）";
        if (rules.omen && play.kind === "set" && play.rank === 6 && play.count === 3) {
          r.revolutionLocked = true;
          logExtra += "（オーメン：以降の革命封じ）";
        }
      }
    }

    // --- 場を流す系 ---
    if (isSandStorm) { cut = true; logExtra += "（砂嵐）"; }
    if (isSpade3Return) { cut = true; logExtra += "（スペ3返し）"; }
    if (isSpade2Return) { cut = true; logExtra += "（スペ2返し）"; }
    if (is33Return) { cut = true; logExtra += "（33返し）"; }
    if (rules.eightCut && play.kind === "set" && reals.length > 0 && reals.every((c) => c.rank === 8)) { cut = true; logExtra += "（8切り）"; }
    if (rules.kaidanEightCut && play.kind === "stairs" && play.ranks && play.ranks.includes(8)) { cut = true; logExtra += "（階段8切り）"; }
    if (rules.ambulance && play.kind === "set" && play.rank === 9 && play.count === 2) { cut = true; logExtra += "（救急車）"; }
    if (rules.rokurokubi && play.kind === "set" && play.rank === 6 && play.count === 2) { cut = true; logExtra += "（ろくろ首）"; }

    // --- 一時反転系 ---
    if (rules.elevenBack && play.kind === "set" && play.rank === 11) { r.tempReverse = !r.tempReverse; logExtra += "（11バック）"; }
    if (rules.sixBack && play.kind === "set" && play.rank === 6) { r.tempReverse = !r.tempReverse; logExtra += "（6戻し）"; }

    // --- 順番系 ---
    if (rules.nineReverse && play.kind === "set" && play.rank === 9) { r.direction *= -1; logExtra += "（9リバース）"; }
    if (rules.twelveReverse && play.kind === "set" && play.rank === 12) { r.direction *= -1; logExtra += "（12リバース）"; }
    if (rules.fiveSkip && play.kind === "set" && play.rank === 5) { skip += play.count; logExtra += "（5スキップ）"; }
    if (rules.thirteenSkip && play.kind === "set" && play.rank === 13) { skip += play.count; logExtra += "（13スキップ）"; }

    // --- 出した手のログ（上がり処理より先に出す。あとに回すと反則の通知が
    //     この行に上書きされて、画面上は最新1行しか見えないため気付けない） ---
    const label = play.kind === "joker" ? "Joker" : play.kind === "stairs"
      ? `${RANK_LABEL(play.startRank)}からの階段` : RANK_LABEL(play.rank);
    r.log.push(`${me.name} が ${label} ${cards.length}枚${logExtra}`);

    // --- 上がり処理 ---
    let justFinished = false;
    if (newHand.length === 0) {
      justFinished = true;
      me.finished = true;
      if (foul) {
        // 反則でも手は止めず、そのまま上がらせる。順位だけ下位に回す。
        // 反則した順を控えておき、あとに反則した人ほど下位にする。
        me.foul = true;
        me.foulOrder = ++r.foulSeq;
        me.finishOrder = r.players.length; // 仮置き。確定は checkGameEnd()
        r.log.push(`${me.name} は反則上がり！（下位確定）`);
      } else {
        me.finishOrder = r.players.filter((p) => p.finished && !p.foul).length;
      }
      if (rules.agariNagashi) cut = true;
    }

    // --- 場の更新 ---
    if (cut) {
      this.clearField(r);
    } else {
      if (play.kind === "set") r.field = { kind: "set", rank: play.rank, count: play.count, cards };
      else if (play.kind === "stairs") r.field = { kind: "stairs", suit: play.suit, startRank: play.startRank, count: play.count, cards };
      else r.field = { kind: "joker", count: play.count, cards };
      r.lastPlayerId = playerId;
      r.passStreak = 0;
      r.passedPlayers = [];
      this.updateLocks(r, play, reals);
    }
    if (cut) r.lastPlayerId = playerId;

    // --- 保留アクション（7渡し / 10捨て / Qボンバー） ---
    r.adv = { cut, justFinished, skip };
    if (!justFinished) {
      if (rules.sevenGive && play.kind === "set" && play.rank === 7 && me.hand.length > 0) {
        r.pending = { type: "give", playerId, count: Math.min(play.count, me.hand.length) };
        return { ok: true };
      }
      if (rules.tenDiscard && play.kind === "set" && play.rank === 10 && me.hand.length > 0) {
        r.pending = { type: "discard", playerId, count: Math.min(play.count, me.hand.length) };
        return { ok: true };
      }
      if (rules.twelveBomber && play.kind === "set" && play.rank === 12) {
        r.pending = { type: "bomber", playerId };
        return { ok: true };
      }
    }

    this.advanceTurn();
    return { ok: true };
  }

  updateLocks(r, play, reals) {
    const rules = r.rules;
    if (play.kind !== "set" || reals.length === 0) return;
    // スート縛り
    if (rules.suitLock) {
      const suits = [...new Set(reals.map((c) => c.suit))].sort().join(",");
      if (r.suitRunSuit === suits) {
        r.suitRunCount += 1;
        if (r.suitRunCount >= rules.suitLockCount && reals.length === 1) r.suitLockActive = reals[0].suit;
      } else { r.suitRunSuit = suits; r.suitRunCount = 1; }
    }
    // 色縛り
    if (rules.colorLock) {
      const colors = [...new Set(reals.map((c) => (IS_RED(c.suit) ? "red" : "black")))];
      if (colors.length === 1) {
        if (r._lastColor === colors[0]) r.colorLockActive = colors[0];
        r._lastColor = colors[0];
      } else r._lastColor = null;
    }
    // 数縛り（次は1つ上の数字のみ）
    if (rules.numberLock) {
      if (r._lastRank != null && play.rank === r._lastRank + 1) r.numberLockActive = play.rank + 1;
      else r.numberLockActive = null;
      r._lastRank = play.rank;
    }
  }

  // ---------- 保留アクションの解決 ----------
  resolvePending(playerId, payload) {
    const r = this.room;
    if (!r.pending) return { ok: false, message: "処理待ちはありません" };
    if (r.pending.playerId !== playerId) return { ok: false, message: "あなたの処理ではありません" };
    const me = r.players.find((p) => p.id === playerId);
    const pendType = r.pending.type; // 下の上がり判定で使うので、null にする前に控える

    if (r.pending.type === "give") {
      const cards = payload && payload.cards;
      if (!cards || cards.length !== r.pending.count) return { ok: false, message: `${r.pending.count}枚選んでください` };
      for (const c of cards) if (!me.hand.some((h) => h.id === c.id)) return { ok: false, message: "手札にないカードです" };
      const nextIdx = this.findNext(r.currentTurnIndex, 0);
      const target = r.players.find((p) => p.id === r.order[nextIdx]);
      me.hand = me.hand.filter((h) => !cards.some((c) => c.id === h.id));
      me.handCount = me.hand.length;
      target.hand = sortHand([...target.hand, ...cards], effRev(r));
      target.handCount = target.hand.length;
      r.log.push(`${me.name} が ${target.name} に ${cards.length}枚渡した（7渡し）`);
    } else if (r.pending.type === "discard") {
      const cards = payload && payload.cards;
      if (!cards || cards.length !== r.pending.count) return { ok: false, message: `${r.pending.count}枚選んでください` };
      for (const c of cards) if (!me.hand.some((h) => h.id === c.id)) return { ok: false, message: "手札にないカードです" };
      me.hand = me.hand.filter((h) => !cards.some((c) => c.id === h.id));
      me.handCount = me.hand.length;
      r.discardPile.push(...cards);
      r.log.push(`${me.name} が ${cards.length}枚捨てた（10捨て）`);
    } else if (r.pending.type === "bomber") {
      const rank = payload && payload.rank;
      if (!rank) return { ok: false, message: "数字を選んでください" };
      let n = 0;
      for (const p of r.players) {
        if (p.id === playerId || p.finished) continue;
        const before = p.hand.length;
        p.hand = p.hand.filter((c) => c.rank !== rank);
        p.handCount = p.hand.length;
        n += before - p.hand.length;
        // Qボンバーで手札が尽きた人はそのまま上がり扱いにする。
        // ここで上がらせないと、出す札もパスもできないまま手番が回り、進行が止まる。
        // 自分の一手ではないので反則にはしない。
        if (p.hand.length === 0) {
          p.finished = true;
          p.finishOrder = r.players.filter((q) => q.finished && !q.foul).length;
          r.log.push(`${p.name} は手札が無くなり上がり（Qボンバー）`);
        }
      }
      r.log.push(`${me.name} が ${RANK_LABEL(rank)} を宣言し、${n}枚が捨てられた（Qボンバー）`);
    }

    r.pending = null;
    // 渡した／捨てた結果あがった場合。
    // 元の一手（7渡しなら7、10捨てなら10）で上がったのと同じなので、
    // 「7で上がり禁止」「10で上がり禁止」が有効なら反則として扱う。
    if (me.hand.length === 0 && !me.finished) {
      const fb = r.rules.forbidden;
      const foul = (pendType === "give" && fb.seven) || (pendType === "discard" && fb.ten);
      me.finished = true;
      if (foul) {
        me.foul = true;
        me.foulOrder = ++r.foulSeq;
        me.finishOrder = r.players.length; // 仮置き。確定は checkGameEnd()
        r.log.push(`${me.name} は反則上がり！（下位確定）`);
      } else {
        me.finishOrder = r.players.filter((p) => p.finished && !p.foul).length;
      }
      r.adv.justFinished = true;
    }
    this.advanceTurn();
    return { ok: true };
  }

  // ---------- 手番を進める ----------
  findNext(fromIndex, skip) {
    const r = this.room;
    let idx = fromIndex;
    let toSkip = skip || 0;
    const restrict = r.rules.passRestriction && r.field;
    for (let i = 0; i < r.order.length * 3; i++) {
      idx = (idx + r.direction + r.order.length) % r.order.length;
      const p = r.players.find((pl) => pl.id === r.order[idx]);
      if (!p || p.finished) continue;
      if (restrict && r.passedPlayers.includes(p.id)) continue;
      if (toSkip > 0) { toSkip--; continue; }
      return idx;
    }
    // 全員パス済みなどの場合は素直に次の未上がり者へ
    idx = fromIndex;
    for (let i = 0; i < r.order.length; i++) {
      idx = (idx + r.direction + r.order.length) % r.order.length;
      const p = r.players.find((pl) => pl.id === r.order[idx]);
      if (p && !p.finished) return idx;
    }
    return fromIndex;
  }

  advanceTurn() {
    const r = this.room;
    const adv = r.adv || { cut: false, justFinished: false, skip: 0 };
    r.adv = null;

    if (this.checkGameEnd()) return;

    if (adv.cut) {
      // 場を流した本人が続けて親。上がっていたら次の人。
      const meIdx = r.order.indexOf(r.lastPlayerId);
      const me = r.players.find((p) => p.id === r.lastPlayerId);
      if (me && !me.finished) r.currentTurnIndex = meIdx;
      else r.currentTurnIndex = this.findNext(meIdx, adv.skip);
    } else {
      r.currentTurnIndex = this.findNext(r.currentTurnIndex, adv.skip);
    }
  }

  applyPass(playerId) {
    const r = this.room;
    if (r.status !== "playing") return { ok: false, message: "ゲーム中ではありません" };
    if (r.pending) return { ok: false, message: "先に処理を完了してください" };
    if (r.order[r.currentTurnIndex] !== playerId) return { ok: false, message: "あなたの番ではありません" };
    if (!r.field) return { ok: false, message: "場が空のときはパスできません" };

    const me = r.players.find((p) => p.id === playerId);
    r.log.push(`${me.name} がパス`);
    r.passStreak += 1;
    if (!r.passedPlayers.includes(playerId)) r.passedPlayers.push(playerId);

    const active = r.players.filter((p) => !p.finished);
    const passedActive = active.filter((p) => r.passedPlayers.includes(p.id)).length;
    const shouldClear = r.rules.passRestriction
      ? passedActive >= active.length - 1
      : r.passStreak >= active.length - 1;

    if (shouldClear) {
      const lastIdx = r.order.indexOf(r.lastPlayerId);
      this.clearField(r);
      r.log.push("場が流れました");
      const last = r.players.find((p) => p.id === r.lastPlayerId);
      if (last && !last.finished) r.currentTurnIndex = lastIdx;
      else r.currentTurnIndex = this.findNext(lastIdx, 0);
    } else {
      r.currentTurnIndex = this.findNext(r.currentTurnIndex, 0);
    }
    return { ok: true };
  }

  checkGameEnd() {
    const r = this.room;
    const active = r.players.filter((p) => !p.finished);
    if (active.length > 1) return false;
    if (active.length === 1) {
      const last = active[0];
      last.finished = true;
      last.finishOrder = r.players.length;
    }
    // 反則者を最下位に押し下げて順位を確定。
    // 反則者どうしは「反則した順」で並べ、あとに反則した人ほど下位になる。
    const fouls = r.players.filter((p) => p.foul).sort((a, b) => (a.foulOrder || 0) - (b.foulOrder || 0));
    const clean = r.players.filter((p) => !p.foul).sort((a, b) => (a.finishOrder || 99) - (b.finishOrder || 99));
    clean.forEach((p, i) => { p.finishOrder = i + 1; });
    fouls.forEach((p, i) => { p.finishOrder = clean.length + i + 1; });

    const total = r.players.length;
    const newClasses = {};
    for (const p of r.players) newClasses[p.id] = rankTitle(p.finishOrder, total);

    // 都落ち
    r.demotedPlayerId = null;
    if (r.rules.miyakoOchi && r.previousDaifugoId) {
      const prev = r.players.find((p) => p.id === r.previousDaifugoId);
      if (prev && prev.finishOrder !== 1) {
        r.demotedPlayerId = prev.id;
        newClasses[prev.id] = "大貧民";
        r.log.push(`${prev.name} は都落ち！`);
      }
    }
    // 下剋上
    if (r.rules.gekokujo && r.classes) {
      const winner = r.players.find((p) => p.finishOrder === 1);
      if (winner && r.classes[winner.id] === "大貧民") {
        r.log.push("下剋上！ 全員の階級が逆転します");
        for (const p of r.players) newClasses[p.id] = rankTitle(total - p.finishOrder + 1, total);
      }
    }
    const winner = r.players.find((p) => p.finishOrder === 1);
    r.previousDaifugoId = winner ? winner.id : null;
    r.classes = newClasses;
    r.status = "finished";
    r.field = null;
    r.pending = null;
    return true;
  }

  // ---------- CPU ----------
  async maybeScheduleCPU() {
    const r = this.room;
    if (!r || (r.status !== "playing" && r.status !== "exchange")) return;
    if (r.status === "exchange") {
      const task = r.exchangeNeeded[0];
      if (task) {
        const p = r.players.find((pl) => pl.id === task.upperId);
        if (p && p.isCPU) { await this.state.storage.setAlarm(Date.now() + 800); return; }
      }
      return;
    }
    if (r.pending) {
      const p = r.players.find((pl) => pl.id === r.pending.playerId);
      if (p && p.isCPU) { await this.state.storage.setAlarm(Date.now() + 900); return; }
      return;
    }
    const cur = r.players.find((p) => p.id === r.order[r.currentTurnIndex]);
    if (cur && cur.isCPU) await this.state.storage.setAlarm(Date.now() + 1100);
  }

  async alarm() {
    await this.ensureLoaded();
    const r = this.room;
    if (!r) return;

    if (r.status === "exchange") {
      const task = r.exchangeNeeded[0];
      if (task) {
        const p = r.players.find((pl) => pl.id === task.upperId);
        if (p && p.isCPU) {
          const weakest = sortHand(p.hand, effRev(r)).slice(0, task.n);
          this.submitExchange(p.id, weakest);
        }
      }
      await this.persistAndBroadcast();
      await this.maybeScheduleCPU();
      return;
    }

    if (r.status !== "playing") return;

    if (r.pending) {
      const p = r.players.find((pl) => pl.id === r.pending.playerId);
      if (!p || !p.isCPU) return;
      if (r.pending.type === "give" || r.pending.type === "discard") {
        const weakest = sortHand(p.hand, effRev(r)).slice(0, r.pending.count);
        this.resolvePending(p.id, { cards: weakest });
      } else if (r.pending.type === "bomber") {
        this.resolvePending(p.id, { rank: 15 });
      }
      await this.persistAndBroadcast();
      await this.maybeScheduleCPU();
      return;
    }

    const cur = r.players.find((p) => p.id === r.order[r.currentTurnIndex]);
    if (!cur || !cur.isCPU) return;
    const cards = this.decideCPUMove(cur);
    if (cards) this.applyPlay(cur.id, cards);
    else this.applyPass(cur.id);
    await this.persistAndBroadcast();
    await this.maybeScheduleCPU();
  }

  decideCPUMove(player) {
    const r = this.room;
    const rev = effRev(r);
    const reals = player.hand.filter((c) => c.suit !== "JOKER");
    const jokers = player.hand.filter((c) => c.suit === "JOKER");
    const byRank = new Map();
    for (const c of reals) {
      if (!byRank.has(c.rank)) byRank.set(c.rank, []);
      byRank.get(c.rank).push(c);
    }
    const ranks = [...byRank.keys()].sort((a, b) => strength(a, rev) - strength(b, rev));

    if (!r.field) {
      if (ranks.length > 0) return [byRank.get(ranks[0])[0]];
      if (jokers.length > 0) return [jokers[0]];
      return null;
    }
    const f = r.field;
    if (f.kind === "set") {
      for (const rk of ranks) {
        const g = byRank.get(rk);
        if (g.length < f.count) continue;
        if (strength(rk, rev) <= strength(f.rank, rev)) continue;
        const cand = g.slice(0, f.count);
        // 縛りに引っかかるものは避ける
        if (r.suitLockActive && !cand.every((c) => c.suit === r.suitLockActive)) continue;
        if (r.numberLockActive != null && rk !== r.numberLockActive) continue;
        return cand;
      }
      if (jokers.length >= f.count) return jokers.slice(0, f.count);
      return null;
    }
    if (f.kind === "joker") {
      if (r.rules.spade3Return && f.count === 1) {
        const s3 = reals.find((c) => c.suit === "S" && c.rank === 3);
        if (s3) return [s3];
      }
      return null;
    }
    return null; // 階段はCPU非対応
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/api\/room\/([A-Za-z0-9]{4})\/ws$/);
    if (m) {
      const id = env.ROOM.idFromName(m[1].toUpperCase());
      return env.ROOM.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
