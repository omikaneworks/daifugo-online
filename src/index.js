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
// CPU の名前候補（参加時に未使用のものからランダムに選ぶ）
const CPU_NAMES = ["ハルト", "アオイ", "ソラ", "ナナ", "リク", "ミカ", "ケンタ", "ユウキ", "サクラ", "ツバサ"];

// 場に残して見せる直近の手の数（room.pile）
const PILE_MAX = 3;
// 「いま出せる組み合わせ」の一覧をクライアントへ送るときの上限。
// 画面で出せない札を伏せるためだけのものなので、多すぎたら諦めて何も伏せない方が安全
const MOVES_MAX = 400;

const DEFAULT_RULES = buildDefaultRules();

const roomJsonRes = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });

// 部屋の合言葉（＝部屋コード）の正規化。前後の空白を落として大文字化し、
// 長さだけ見る（文字種は特に制限しない。日本語も通す）。おかしければ null
function normalizeCode(raw) {
  const c = String(raw == null ? "" : raw).trim().toUpperCase();
  if (c.length < 2 || c.length > 16) return null;
  return c;
}

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
    // 交換キューの持ち方を変えた（{upperId, lowerId, n} → {role, playerId, toId, n}）。
    // 入れ替えた瞬間に交換フェーズだった部屋は、変換しないと「誰の番か」が分からず
    // 動かなくなる。旧形式は「下位はもう差し出し済み・上位が返すだけ」の状態なので
    // そのまま back の1手として引き継ぐ
    const q = this.room && this.room.exchangeNeeded;
    if (q && q.length && q[0] && !q[0].playerId && q[0].upperId) {
      this.room.exchangeNeeded = q.map((t) => ({ role: "back", playerId: t.upperId, toId: t.lowerId, n: t.n }));
    }
  }

  async fetch(request) {
    // WebSocket以外に、部屋の様子を尋ねる／片付けるための小さな経路を持つ。
    // ルーターが /status /close だけをここへ通す
    const path = new URL(request.url).pathname;
    if (path.endsWith("/status") || path.endsWith("/close")) {
      await this.ensureLoaded();
      let body = {};
      try { body = await request.json(); } catch { body = {}; }
      return path.endsWith("/status") ? this.roomStatus(body) : this.roomClose(body);
    }

    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected websocket", { status: 426 });
    await this.ensureLoaded();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.sessions.set(server, null);
    server.addEventListener("message", async (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      try { await this.handleMessage(server, msg); }
      catch (e) { server.send(JSON.stringify({ type: "error", message: "エラー: " + (e && e.message ? e.message : "不明") })); }
    });
    server.addEventListener("close", () => {
      const pid = this.sessions.get(server);
      this.sessions.delete(server);
      // ロビー中にタブを閉じた人の席を空ける（タブを閉じても "leave" は届かない）。
      // 対戦中は席を残す（電波が切れただけで抜けたことにしない）。
      // 再読み込みでは新しい接続が先に座ることがあるので、まだ誰も繋がっていないときだけ外す
      if (pid && this.room && this.room.status === "waiting" &&
          ![...this.sessions.values()].includes(pid)) {
        this.dropSeat(pid).catch(() => {});
      }
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  // 活動ログへ1件送るだけ。結果は待たない・失敗しても対戦は絶対に止めない
  logEvent(kind, name, code, playerId) {
    this.env.LOG.get(this.env.LOG.idFromName("log"))
      .fetch("https://log/record", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, name, code, playerId }),
      })
      .catch(() => {});
  }

  async persistAndBroadcast() {
    await this.state.storage.put("room", this.room);
    // 出せる手の洗い出しは全員に同じものを送るので、人数分ではなく1回だけ計算する
    const moves = this.legalMoves(this.actingId());
    for (const [ws, pid] of this.sessions.entries()) {
      try { ws.send(JSON.stringify({ type: "state", room: this.sanitize(pid, moves) })); }
      catch { this.sessions.delete(ws); }
    }
  }

  // いま操作すべき人。テストモードではこの人の手札だけ見せる（ホストが代わりに打つため）
  actingId() {
    const r = this.room;
    if (!r) return null;
    if (r.pending) return r.pending.playerId;
    if (r.status === "exchange" && r.exchangeNeeded && r.exchangeNeeded[0]) return r.exchangeNeeded[0].playerId;
    if (r.order && r.order.length) return r.order[r.currentTurnIndex];
    return null;
  }

  // ---- 部屋の様子を尋ねる／片付ける（WebSocketを張らずにHTTPで） ----
  // 「最近の部屋」の一覧と管理画面の部屋一覧が使う。
  // 誰の名前も返さない（合言葉を総当たりされても中身が漏れないように）。
  // 部屋が在るかどうかは join を試せば元々分かるので、ここで新しく漏れるものは無い
  roomStatus(body) {
    const r = this.room;
    const playerId = String(body.playerId || "");
    if (!r) return roomJsonRes({ ok: true, exists: false });
    const connected = [...this.sessions.values()].filter(Boolean);
    const humans = r.players.filter((p) => !p.isCPU && !p.isDummy);
    return roomJsonRes({
      ok: true, exists: true, code: r.code, status: r.status,
      players: r.players.length, humans: humans.length,
      connected: humans.filter((p) => connected.includes(p.id)).length,
      createdAt: r.createdAt || null,
      mine: !!playerId && r.createdBy === playerId,
      joined: !!playerId && r.players.some((p) => p.id === playerId),
      // 消してよいのは「作った人」「今のホスト」「誰も繋がっていない部屋」のいずれか
      canClose: !!playerId && (r.createdBy === playerId || r.hostId === playerId
        || humans.every((p) => !connected.includes(p.id))),
    });
  }

  async roomClose(body) {
    const r = this.room;
    const playerId = String(body.playerId || "");
    if (!r) return roomJsonRes({ ok: true, closed: true, already: true });
    const connected = [...this.sessions.values()].filter(Boolean);
    const humans = r.players.filter((p) => !p.isCPU && !p.isDummy);
    const may = !!playerId && (r.createdBy === playerId || r.hostId === playerId
      || humans.every((p) => !connected.includes(p.id)));
    if (!may) return roomJsonRes({ ok: false, error: "その部屋は消せません（作った人・ホスト・誰もいない部屋だけ消せます）" });
    // 中にいる人はスタート画面へ戻す。黙って消すと画面が固まったように見える
    for (const [sock] of this.sessions.entries()) {
      try { sock.send(JSON.stringify({ type: "disbanded" })); } catch { /* 切れていれば無視 */ }
    }
    const code = r.code;
    this.room = null;
    this.sessions.clear();
    await this.state.storage.deleteAll();
    this.logRoom("close", code);
    return roomJsonRes({ ok: true, closed: true });
  }

  // 部屋の生き死にを ActivityLog の索引へ伝える。Durable Object は一覧できないので、
  // 「どんな合言葉の部屋が作られたか」を別に控えておかないと管理画面で並べられない。
  // 結果は待たない・失敗しても無視する（logEvent と同じ考え方。対戦は絶対に止めない）
  logRoom(kind, code, name, playerId) {
    this.env.LOG.get(this.env.LOG.idFromName("log"))
      .fetch("https://log/room", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, code, name, playerId }),
      })
      .catch(() => {});
  }

  // 8切り・革命などを画面に大きく出すための合図。ログの小さい1行だけだと見落とすため。
  // id は「まだ見せていない効果かどうか」をクライアントが見分けるための通し番号で、
  // これが無いと部屋に入り直すたびに過去の効果が再生されてしまう
  setFlash(items, by) {
    const r = this.room;
    if (!r || !items || !items.length) return;
    r.flashSeq = (r.flashSeq || 0) + 1;
    r.flash = { id: r.flashSeq, by: by || "", items };
  }

  sanitize(forPlayerId, moves) {
    if (!this.room) return null;
    // 自分の手札＋（テストモードなら）手番の人の手札だけ。それ以外は必ず伏せる
    const acting = this.room.testMode ? this.actingId() : null;
    const out = {
      ...this.room,
      players: this.room.players.map((p) =>
        p.id === forPlayerId || (acting && p.id === acting) ? p : { ...p, hand: undefined }),
    };
    // いま出せる組み合わせの一覧。手札を見せている相手にだけ送る（画面で出せない札を
    // 伏せるため）。**送っていないものは見えない**ので、クライアントは moves が
    // 届かなければ何も伏せない＝今までどおり全部押せる
    const actId = this.actingId();
    if (actId && (actId === forPlayerId || this.room.testMode)) out.moves = moves;
    return out;
  }

  // ロビーから席を1つ空ける。自分で抜けたときと、ロビー中に接続が切れたときの両方で通る
  async dropSeat(playerId) {
    const r = this.room;
    if (!r) return;
    const i = r.players.findIndex((p) => p.id === playerId);
    if (i < 0) return;
    r.log.push(`${r.players.splice(i, 1)[0].name} が退出しました`);

    // 人が一人もいなくなった部屋は残す意味がないので消す（CPU・ダミーだけの部屋も同様）
    const humans = r.players.filter((p) => !p.isCPU && !p.isDummy);
    if (humans.length === 0) {
      const code = r.code;
      this.room = null;
      await this.state.storage.deleteAll();
      this.logRoom("close", code);
      return;
    }
    if (r.hostId === playerId) {
      // ホストが抜けたら残っている人に引き継ぐ
      r.hostId = humans[0].id;
      r.log.push(`${humans[0].name} がホストになりました`);
    }
    await this.persistAndBroadcast();
  }

  // 対戦をやめてロビーの状態に戻す。中断と、誰も戻ってこない部屋の後始末で使う
  backToLobby(r) {
    r.status = "waiting";
    r.order = [];
    r.currentTurnIndex = 0;
    r.pending = null; r.adv = null;
    r.exchangeNeeded = []; r.exchangeGiven = {};
    r.revolution = false; r.revolutionLocked = false; r.direction = 1;
    this.clearField(r);
    for (const p of r.players) {
      p.hand = []; p.handCount = 0;
      p.finished = false; p.finishOrder = null; p.foul = false; p.foulOrder = null;
    }
  }

  clearField(r) {
    r.field = null;
    r.pile = [];
    r.suitLockActive = null;
    r.colorLockActive = null;
    r.numberLockActive = null;
    r.suitRunSuit = null;
    r.suitRunCount = 0;
    r.tempReverse = false;
    r.passedPlayers = [];
    r.passStreak = 0;
  }

  newRoom(code, playerId, name) {
    return {
      code, status: "waiting", hostId: playerId, testMode: false,
      // 作った人と作った時刻。「自分が作った部屋」の判定と管理画面の一覧に使う。
      // hostId は抜けると他の人へ移るので、作った人を別に控えておく必要がある
      createdBy: playerId, createdAt: Date.now(),
      players: [{ id: playerId, name, hand: [], handCount: 0, finished: false, finishOrder: null }],
      order: [], seatOrder: null, field: null, direction: 1,
      suitLockActive: null, colorLockActive: null, numberLockActive: null,
      suitRunSuit: null, suitRunCount: 0,
      lastPlayerId: null, currentTurnIndex: 0, passStreak: 0, passedPlayers: [],
      revolution: false, tempReverse: false, revolutionLocked: false, foulSeq: 0,
      pending: null, adv: null, discardPile: [], pile: [],
      rules: JSON.parse(JSON.stringify(DEFAULT_RULES)),
      classes: null, previousDaifugoId: null, demotedPlayerId: null,
      exchangeNeeded: [], exchangeGiven: {},
      log: [`${name} が部屋を作成しました`],
    };
  }

  // ---------- メッセージ処理 ----------
  async handleMessage(ws, msg) {
    const type = msg.type;
    const playerId = msg.playerId;

    if (type === "create") {
      // 合言葉は作る人が決める。すでに誰かが使っていたら上書きしない
      // （人が抜けて空になった部屋は leave 側で this.room = null に戻るので、
      // 本当に使われなくなった合言葉は自然に空く）
      if (this.room) {
        ws.send(JSON.stringify({ type: "error", message: "その合言葉はもう使われています。別の言葉にするか、参加するを試してください" }));
        return;
      }
      const code = normalizeCode(msg.code);
      if (!code) {
        ws.send(JSON.stringify({ type: "error", message: "合言葉は2〜16文字で入力してください" }));
        return;
      }
      this.room = this.newRoom(code, playerId, msg.name);
      this.sessions.set(ws, playerId);
      this.logEvent("create", msg.name, code, playerId);
      this.logRoom("open", code, msg.name, playerId);
      await this.persistAndBroadcast();
      return;
    }

    await this.ensureLoaded();

    // 部屋が無ければその場で作る経路。通るのは開発部屋（?dev=1 の決め打ちの部屋）だけ
    if (type === "enter" && !this.room) {
      this.room = this.newRoom(msg.code, playerId, msg.name);
      this.sessions.set(ws, playerId);
      await this.persistAndBroadcast();
      return;
    }

    if (!this.room) { ws.send(JSON.stringify({ type: "error", message: "部屋が見つかりません" })); return; }
    const r = this.room;

    if (type === "join" || type === "enter") {
      this.sessions.set(ws, playerId);
      const myName = msg.name;
      // 席のある人が誰も繋がっていない対戦中の部屋は、捨ててロビーに戻す。
      // これが無いと、全員抜けた部屋に誰も入れず、中断も解散もできないまま残り続ける
      const connected = [...this.sessions.values()];
      const anyoneHome = r.players.some((p) => !p.isCPU && !p.isDummy && connected.includes(p.id));
      if (r.status !== "waiting" && !anyoneHome) {
        this.backToLobby(r);
        r.log.push("誰も戻ってこなかったので、対戦を取りやめました");
      }
      if (!r.players.some((p) => p.id === playerId)) {
        if (r.status !== "waiting") { ws.send(JSON.stringify({ type: "error", message: "すでにゲームが始まっています" })); return; }
        if (r.players.length >= 6) { ws.send(JSON.stringify({ type: "error", message: "満員です（最大6人）" })); return; }
        r.players.push({ id: playerId, name: myName, hand: [], handCount: 0, finished: false, finishOrder: null });
        r.log.push(`${myName} が参加しました`);
        this.logEvent("join", myName, r.code, playerId);
      }
      // ホストが繋がっていない部屋は中断も解散も誰にもできなくなる。
      // 放置された部屋を自力で片付けられるよう、入ってきた人にホストを渡す。
      if (![...this.sessions.values()].includes(r.hostId)) {
        r.hostId = playerId;
        r.log.push(`${myName} がホストになりました`);
      }
      await this.persistAndBroadcast();
      return;
    }

    // 対戦を中断してロビーに戻す（ホストのみ）。
    // 進行が詰まったときの脱出口なので、状態は playing / exchange のどちらからでも受ける。
    if (type === "abort") {
      if (r.hostId !== playerId) { ws.send(JSON.stringify({ type: "error", message: "ホストだけが操作できます" })); return; }
      this.backToLobby(r);
      r.log.push("対戦を中断しました");
      await this.persistAndBroadcast();
      return;
    }

    // 部屋ごと消す（ホストのみ）。全員がスタート画面に戻る
    if (type === "disband") {
      if (r.hostId !== playerId) { ws.send(JSON.stringify({ type: "error", message: "ホストだけが操作できます" })); return; }
      for (const [sock] of this.sessions.entries()) {
        try { sock.send(JSON.stringify({ type: "disbanded" })); } catch {}
      }
      const closedCode = r.code;
      this.room = null;
      this.sessions.clear();
      await this.state.storage.deleteAll();
      this.logRoom("close", closedCode);
      return;
    }

    // ロビーからスタート画面に戻る（席を抜ける）
    if (type === "leave") {
      if (r.status !== "waiting") {
        ws.send(JSON.stringify({ type: "error", message: "ゲーム中は退出できません" }));
        return;
      }
      this.sessions.delete(ws);
      await this.dropSeat(playerId);
      return;
    }

    // 名前を変える（マイページから。対戦中でも呼べる）。
    // 変えられるのは自分の席の名前だけなので、ホスト権限は要らない
    if (type === "rename") {
      const name = String(msg.name || "").trim().slice(0, 20);
      if (!name) return;
      const p = r.players.find((pl) => pl.id === playerId);
      if (!p) return;
      const old = p.name;
      if (old === name) return;
      p.name = name;
      r.log.push(`${old} が ${name} に名前を変更しました`);
      this.logEvent("rename", name, r.code, playerId);
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
      // 部屋にいる人と名前がかぶらないよう、空いている候補からランダムに選ぶ
      const used = new Set(r.players.map((p) => p.name));
      const free = CPU_NAMES.filter((nm) => !used.has(nm));
      const name = free.length ? free[Math.floor(Math.random() * free.length)] : `CPU ${n}`;
      r.players.push({ id: `cpu-${n}-${Date.now()}`, name, isCPU: true, hand: [], handCount: 0, finished: false, finishOrder: null });
      r.log.push(`${name} が参加しました`);
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
    r.pending = null; r.adv = null; r.discardPile = []; r.pile = [];
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
      // 「下位が強い札を差し出す」→「上位が好きな札を返す」の2手を、この順に1つずつ処理する。
      // 昔は下位の分を自動で抜いていたが、**何を取られたのか本人に見えなかった**ので
      // 下位も自分で選ぶようにした。強さは「一番上から n 枚」に縛られる（弱い札を隠せない）が、
      // 同じ強さの札が並んでいるとき（2が3枚あるとき等）はどれを渡すか本人が決められる
      r.exchangeNeeded.push({ role: "give", playerId: lower.id, toId: upper.id, n });
      r.exchangeNeeded.push({ role: "back", playerId: upper.id, toId: lower.id, n });
    }
    if (r.exchangeNeeded.length > 0) r.status = "exchange";
  }

  // 交換の1手。**必ずキューの先頭（exchangeNeeded[0]）だけを処理する**。
  // 下位が差し出す前に上位が返すと、返した札をそのまま取り返せてしまうため順番を守る
  submitExchange(playerId, cards) {
    const r = this.room;
    if (r.status !== "exchange") return { ok: false, message: "交換フェーズではありません" };
    const task = r.exchangeNeeded[0];
    if (!task || task.playerId !== playerId) return { ok: false, message: "あなたの交換ではありません" };
    if (!cards || cards.length !== task.n) return { ok: false, message: `${task.n}枚選んでください` };
    const from = r.players.find((p) => p.id === task.playerId);
    const to = r.players.find((p) => p.id === task.toId);
    // 相手が居なくなっていたら、この1手は捨てて先へ進める（交換で止まったままにしない）
    if (!from || !to) {
      r.exchangeNeeded.shift();
      if (r.exchangeNeeded.length === 0) { r.status = "playing"; r.log.push("ゲーム開始！"); }
      return { ok: false, message: "交換の相手がいません" };
    }
    const ids = new Set(cards.map((c) => c.id));
    if (ids.size !== cards.length) return { ok: false, message: "同じカードは選べません" };
    for (const c of cards) if (!from.hand.some((h) => h.id === c.id)) return { ok: false, message: "手札にないカードです" };
    // 動かすのは手札にある実物。クライアントから届いた中身はそのまま信じない
    const give = from.hand.filter((c) => ids.has(c.id));
    const rest = from.hand.filter((c) => !ids.has(c.id));

    if (task.role === "give") {
      // 下位が差し出すのは「一番強いところから n 枚」。同じ強さの中でどれを出すかだけ選べる。
      // 出した中の一番弱い札より強い札が手元に残っていたら、強い札を隠したということ
      const st = (c) => (c.suit === "JOKER" ? 999 : strength(c.rank, effRev(r)));
      const weakestGiven = Math.min(...give.map(st));
      if (rest.some((c) => st(c) > weakestGiven)) return { ok: false, message: "一番強いカードから渡してください" };
    }

    from.hand = rest;
    to.hand = sortHand([...to.hand, ...give], false);
    from.handCount = from.hand.length; to.handCount = to.hand.length;
    r.exchangeNeeded.shift();
    r.log.push(task.role === "give"
      ? `${from.name} が ${to.name} に強いカードを ${task.n}枚 渡しました`
      : `${from.name} が ${to.name} にカードを ${task.n}枚 返しました`);

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

  // この一手で上がったとき、反則上がりになるか。手札がゼロになる場合だけ意味を持つ。
  // applyPlay() と decideCPUMove() の両方がここを呼ぶ
  checkFoul(cards, play) {
    const r = this.room;
    const rules = r.rules;
    const fb = rules.forbidden;
    const rev = effRev(r);
    const reals = cards.filter((c) => c.suit !== "JOKER");
    const has = (rk) => reals.some((c) => c.rank === rk);
    const willRevolt = rules.revolution && play.kind === "set" && play.count >= rules.revolutionCards;
    if (fb.joker && cards.some((c) => c.suit === "JOKER")) return true;
    if (fb.two && !rev && has(15)) return true;
    if (fb.three && rev && has(3)) return true;
    if (fb.eight && rules.eightCut && has(8)) return true;
    if (fb.spade3 && cards.length === 1 && cards[0].suit === "S" && cards[0].rank === 3) return true;
    if (fb.eleven && rules.elevenBack && has(11)) return true;
    if (fb.ten && rules.tenDiscard && has(10)) return true;
    if (fb.seven && rules.sevenGive && has(7)) return true;
    if (fb.revolutionAgari && willRevolt) return true;
    return false;
  }

  // 出せるかどうかの判定だけを切り出したもの。**applyPlay() と、CPU・画面用の
  // legalMoves() が同じここを通る**ので、ルールを足すときはここ1ヶ所で済む。
  // 手札も場も触らないことがこの関数の約束（触ると出せる手の洗い出しが盤面を壊す）
  validatePlay(cards) {
    const r = this.room;
    const rules = r.rules;
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

    return { ok: true, play, rev, reals, isSpade3Return, isSpade2Return, is33Return, isSandStorm };
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

    const v = this.validatePlay(cards);
    if (!v.ok) return v;
    const { play, rev, reals, isSpade3Return, isSpade2Return, is33Return, isSandStorm } = v;

    // --- 上がり禁止（反則上がり）チェック ---
    // 判定の中身は checkFoul() に出してある。**CPU が反則を避けるのに同じ判定を使う**ので、
    // 禁止の条件を足すときはあちらだけ直せば両方に効く
    const newHand = me.hand.filter((c) => !cards.some((s) => s.id === c.id));
    const foul = newHand.length === 0 && this.checkFoul(cards, play);

    // ===== ここから確定処理 =====
    me.hand = newHand;
    me.handCount = newHand.length;
    r.discardPile.push(...cards);

    let cut = false;     // 場を流すか
    let skip = 0;        // 次に飛ばす人数
    let logExtra = "";
    // 画面に大きく出す用の効果。**ログの文言と必ず同じ場所で積む**（片方だけ足すと、
    // ログには出るのに大きく出ない／その逆が起きて食い違うため）。
    // logText を渡すとログ側だけ別の（長い）文言にできる
    const fx = [];
    const mark = (label, kind, logText) => {
      logExtra += `（${logText || label}）`;
      fx.push({ label, kind });
    };

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
      if (rules.nuke && play.count >= 6) { revolt = true; r.revolutionLocked = true; mark("核爆弾", "revolution"); }
      if (revolt) {
        r.revolution = !r.revolution;
        mark(r.revolution ? "革命！" : "革命返し", "revolution");
        if (rules.omen && play.kind === "set" && play.rank === 6 && play.count === 3) {
          r.revolutionLocked = true;
          mark("オーメン", "revolution", "オーメン：以降の革命封じ");
        }
      }
    }

    // --- 場を流す系 ---
    if (isSandStorm) { cut = true; mark("砂嵐", "cut"); }
    if (isSpade3Return) { cut = true; mark("スペ3返し", "cut"); }
    if (isSpade2Return) { cut = true; mark("スペ2返し", "cut"); }
    if (is33Return) { cut = true; mark("33返し", "cut"); }
    if (rules.eightCut && play.kind === "set" && reals.length > 0 && reals.every((c) => c.rank === 8)) { cut = true; mark("8切り", "cut"); }
    if (rules.kaidanEightCut && play.kind === "stairs" && play.ranks && play.ranks.includes(8)) { cut = true; mark("階段8切り", "cut"); }
    if (rules.ambulance && play.kind === "set" && play.rank === 9 && play.count === 2) { cut = true; mark("救急車", "cut"); }
    if (rules.rokurokubi && play.kind === "set" && play.rank === 6 && play.count === 2) { cut = true; mark("ろくろ首", "cut"); }

    // --- 一時反転系 ---
    if (rules.elevenBack && play.kind === "set" && play.rank === 11) { r.tempReverse = !r.tempReverse; mark("11バック", "reverse"); }
    if (rules.sixBack && play.kind === "set" && play.rank === 6) { r.tempReverse = !r.tempReverse; mark("6戻し", "reverse"); }

    // --- 順番系 ---
    if (rules.nineReverse && play.kind === "set" && play.rank === 9) { r.direction *= -1; mark("9リバース", "order"); }
    if (rules.twelveReverse && play.kind === "set" && play.rank === 12) { r.direction *= -1; mark("12リバース", "order"); }
    if (rules.fiveSkip && play.kind === "set" && play.rank === 5) { skip += play.count; mark("5スキップ", "order"); }
    if (rules.thirteenSkip && play.kind === "set" && play.rank === 13) { skip += play.count; mark("13スキップ", "order"); }

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
        fx.push({ label: "反則上がり", kind: "foul" });
      } else {
        me.finishOrder = r.players.filter((p) => p.finished && !p.foul).length;
      }
      if (rules.agariNagashi) cut = true;
    }

    // 効果が付いた一手なら、画面に大きく出す合図を積む（反則上がりまで含めてから呼ぶ）
    this.setFlash(fx, me.name);

    // --- 出た札の履歴 ---
    // 場が流れずに続いている間だけ溜める（clearField() で空になる）。
    // 8切りのように出した瞬間に流れる手は、押し込んだ直後に消える＝正しい挙動。
    r.pile = [...(r.pile || []), { cards, by: me.name }].slice(-PILE_MAX);

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
        this.setFlash([{ label: "反則上がり", kind: "foul" }], me.name);
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

    // 都落ち。**階級だけを入れ替える**（着順そのものは動かさない）。
    // 前回の大富豪を階級の並びの一番下へ回し、その下にいた人を1つずつ繰り上げる。
    // ここで「大貧民」を上書きするだけだと、**元の大貧民と2人になって富豪が消える**
    r.demotedPlayerId = null;
    if (r.rules.miyakoOchi && r.previousDaifugoId) {
      const prev = r.players.find((p) => p.id === r.previousDaifugoId);
      if (prev && prev.finishOrder !== 1) {
        r.demotedPlayerId = prev.id;
        const line = [...r.players].sort((x, y) => x.finishOrder - y.finishOrder)
          .filter((p) => p.id !== prev.id);
        line.push(prev);
        line.forEach((p, i) => { newClasses[p.id] = rankTitle(i + 1, total); });
        r.log.push(`${prev.name} は都落ち！`);
      }
    }
    // 下剋上。**これはこういうルール**（着順がそっくり裏返る）なので直さないこと。
    // 前回の大貧民が1位を取ると、1位が大貧民・最下位が大富豪になる。
    // 都落ちより後に効き、階級を全部上書きするので、都落ちの印は取り消す
    // （そうしないと結果発表で「都落ち」と出ている人が大富豪になって見える）
    if (r.rules.gekokujo && r.classes) {
      const winner = r.players.find((p) => p.finishOrder === 1);
      if (winner && r.classes[winner.id] === "大貧民") {
        r.log.push("下剋上！ 全員の階級が逆転します");
        for (const p of r.players) newClasses[p.id] = rankTitle(total - p.finishOrder + 1, total);
        r.demotedPlayerId = null;
      }
    }
    const winner = r.players.find((p) => p.finishOrder === 1);
    r.previousDaifugoId = winner ? winner.id : null;
    r.classes = newClasses;
    r.status = "finished";
    r.field = null;
    r.pile = [];
    r.pending = null;
    return true;
  }

  // ---------- いま出せる組み合わせの一覧 ----------
  // 画面で「出せない札」を薄くして押せなくするために、手番の人へ送る。
  // 候補を作るのはここだが、**出せるかどうかの判定は必ず validatePlay() に任せる**ので
  // ルールを足しても（縛り・返し技・革命など）自動で正しくなる。
  // 戻り値はカードidの配列の配列（例 [["S-3"], ["H-5","D-5"]]）。
  // **空の配列＝「1つも出せない」**という意味なので、クライアントはパスへ誘導してよい。
  // 反対に、届いていない（undefined）ときは何も伏せないこと
  legalMoves(playerId) {
    const r = this.room;
    if (!r || r.status !== "playing" || r.pending || !playerId) return undefined;
    if (!r.order || r.order[r.currentTurnIndex] !== playerId) return undefined;
    const p = r.players.find((pl) => pl.id === playerId);
    if (!p || !p.hand || p.finished) return undefined;

    const out = [];
    const seen = new Set();
    let full = false;
    const add = (cs) => {
      if (full || !cs.length) return;
      const ids = cs.map((c) => c.id).sort();
      const key = ids.join(",");
      if (seen.has(key)) return;
      seen.add(key);
      if (!this.validatePlay(cs).ok) return;
      out.push(ids);
      // 多すぎて送れないくらいなら、何も伏せない方が安全（画面で詰ませない）
      if (out.length > MOVES_MAX) full = true;
    };
    // ちょうど k 枚の組み合わせを全部作る（階段で Joker に置き換える札を選ぶのに使う）
    const pick = (arr, k) => {
      if (k <= 0) return [[]];
      const res = [];
      const walk = (i, cur) => {
        if (cur.length === k) { res.push([...cur]); return; }
        for (let x = i; x < arr.length; x++) { cur.push(arr[x]); walk(x + 1, cur); cur.pop(); }
      };
      walk(0, []);
      return res;
    };
    // 空でない部分集合を全部作る。同ランクは最大4枚・Jokerも数枚なので数は知れている
    const subsets = (arr) => {
      const res = [];
      for (let m = 1; m < (1 << arr.length); m++) {
        const sub = [];
        for (let i = 0; i < arr.length; i++) if (m & (1 << i)) sub.push(arr[i]);
        res.push(sub);
      }
      return res;
    };

    const jokers = p.hand.filter((c) => c.suit === "JOKER");
    const reals = p.hand.filter((c) => c.suit !== "JOKER");
    const byRank = new Map();
    for (const c of reals) {
      if (!byRank.has(c.rank)) byRank.set(c.rank, []);
      byRank.get(c.rank).push(c);
    }
    const jokerSubs = [[], ...subsets(jokers)];
    // 同ランク（Joker を混ぜた形も含む）
    for (const g of byRank.values()) for (const sub of subsets(g)) for (const j of jokerSubs) add([...sub, ...j]);
    // Joker だけ
    for (const j of subsets(jokers)) add(j);
    // 階段。「連番の区間」を端から端まで試し、持っていないランクは Joker で埋める。
    // **持っているランクをあえて Joker に置き換えた形も作る**こと —— そうしないと
    // 「3・4・Joker」（Joker を端に付ける形）のような手を取りこぼして、画面で出せる札が
    // 伏せられてしまう
    if (r.rules.kaidan) {
      const TOP = RANKS[RANKS.length - 1];
      for (const suit of SUITS) {
        if (full) break;
        const at = new Map(reals.filter((c) => c.suit === suit).map((c) => [c.rank, c]));
        if (!at.size) continue;
        for (let start = RANKS[0]; start <= TOP && !full; start++) {
          for (let len = r.rules.kaidanMin; start + len - 1 <= TOP && !full; len++) {
            const got = [];
            let miss = 0;
            for (let k = start; k < start + len; k++) {
              const c = at.get(k);
              if (c) got.push(c); else miss++;
            }
            if (miss > jokers.length) break;   // これ以上伸ばしても Joker が足りない
            for (const j of jokerSubs) {
              const swap = j.length - miss;      // 実札を Joker に置き換える枚数
              if (swap < 0 || swap > got.length) continue;
              for (const drop of pick(got, swap)) {
                add([...got.filter((c) => !drop.includes(c)), ...j]);
              }
            }
          }
        }
      }
    }
    if (full) return undefined;
    return out;
  }

  // ---------- CPU ----------
  async maybeScheduleCPU() {
    const r = this.room;
    if (!r || (r.status !== "playing" && r.status !== "exchange")) return;
    if (r.status === "exchange") {
      const task = r.exchangeNeeded[0];
      if (task) {
        const p = r.players.find((pl) => pl.id === task.playerId);
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
        const p = r.players.find((pl) => pl.id === task.playerId);
        if (p && p.isCPU) {
          const sorted = sortHand(p.hand, effRev(r));
          // 差し出すときは強い方から（ルール上そうするしかない）、返すときは弱い方から
          const pick = task.role === "give" ? sorted.slice(sorted.length - task.n) : sorted.slice(0, task.n);
          this.submitExchange(p.id, pick);
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
    let res = cards ? this.applyPlay(cur.id, cards) : { ok: false };
    // **CPU が打てなかったときは必ず何かさせる。** 昔は applyPlay の結果を見ずに
    // 捨てていたので、思考が出せない札を選ぶと手番が回らないまま対戦が止まった
    // （実際、色縛り中にそうなっていた）。出せる手の一覧から拾い直し、それも無ければパスする
    if (!res.ok) {
      const mv = this.legalMoves(cur.id);
      if (mv && mv.length) {
        const byId = new Map(cur.hand.map((c) => [c.id, c]));
        res = this.applyPlay(cur.id, mv[0].map((id) => byId.get(id)));
      }
      if (!res.ok) res = this.applyPass(cur.id);
      if (!res.ok) r.log.push(`${cur.name} の手が決まりませんでした`);
    }
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

    // 出せる手の候補を弱い順に並べる（同ランクの組み合わせだけ。階段・Joker代用はしない）。
    // 昔は最初に見つかった1つをそのまま出していたが、反則上がりを避けるために
    // いったん全部集めてから選ぶ形にした
    let cands = [];
    if (!r.field) {
      for (const rk of ranks) cands.push([byRank.get(rk)[0]]);
      if (jokers.length > 0) cands.push([jokers[0]]);
    } else {
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
          cands.push(cand);
        }
        if (jokers.length >= f.count) cands.push(jokers.slice(0, f.count));
      } else if (f.kind === "joker") {
        if (r.rules.spade3Return && f.count === 1) {
          const s3 = reals.find((c) => c.suit === "S" && c.rank === 3);
          if (s3) cands.push([s3]);
        }
      }
      // 階段はCPU非対応
    }
    // **候補は必ず validatePlay に通す。** ここを自前の条件だけで済ませていたため、
    // 色縛り（colorLock）を見落として「出せない札を出そうとして手番が止まる」不具合があった。
    // ルールを足したときも、ここを通していれば CPU が勝手に反則手を選ばない
    cands = cands.filter((c) => this.validatePlay(c).ok);
    if (!cands.length) return null;
    if (cands.length === 1) return cands[0];

    // 反則上がりを避ける。CPU が反則で最下位に落ちると、人には「勝ちを勝手に
    // 譲られた」ように見えて興ざめするので、極力させない。
    //   ① その一手で上がると反則になるものを避ける
    //   ② 出したあと1枚だけ残り、その1枚では必ず反則になる形も避ける
    //      （＝2 や 8 を最後まで抱え込まないよう、余裕のあるうちに出しておく）
    //   ③ 7渡し／10捨てで残り全部を手放す形も、上がれば反則になる
    const foulOf = (cs) => {
      const play = this.classify(cs, r);
      return !!play && this.checkFoul(cs, play);
    };
    const penalty = (cs) => {
      const left = player.hand.filter((c) => !cs.some((x) => x.id === c.id));
      if (left.length === 0) return foulOf(cs) ? 1000 : 0;
      const play = this.classify(cs, r);
      if (play && play.kind === "set" && left.length <= play.count) {
        const fb = r.rules.forbidden;
        if (fb.seven && r.rules.sevenGive && play.rank === 7) return 1000;
        if (fb.ten && r.rules.tenDiscard && play.rank === 10) return 1000;
      }
      if (left.length === 1 && foulOf(left)) return 100;
      return 0;
    };
    // 同じ点数なら先頭（＝一番弱い手）のまま。今までの打ち方をそのまま残すため
    let best = cands[0], bestPen = penalty(cands[0]);
    for (let i = 1; i < cands.length && bestPen > 0; i++) {
      const pen = penalty(cands[i]);
      if (pen < bestPen) { best = cands[i]; bestPen = pen; }
    }
    return best;
  }
}

// ============ 活動ログ・プレイヤー台帳（ActivityLog） ============
// 部屋を作った・参加した、という出来事から2種類のデータを同時に作る。
// インスタンスは1つだけ（idFromName("log")）。別のデータベースは使わない。
//
//   パターンA：活動ログ    … 「いつ何が起きたか」の生の記録を時系列で積む（直近500件）
//   パターンB：プレイヤー台帳 … playerId ごとに1件。初回・最終・使った名前・回数を集計。
//                            同じIDが違う名前で来ても、台帳上は同じ1レコードとして追える
//
// playerId（daifugo-pid）は「永久に変わらない個人ID」ではない。端末やブラウザが
// 変わると別物になりうる。この限界を隠さず、管理画面の注記に明記すること。

const LOG_FAIL_LIMIT = 5;
const LOG_FAIL_BASE_MS = 60 * 1000;
const LOG_FAIL_MAX_STEP = 6;
const LOG_FAIL_RESET_MS = 60 * 60 * 1000;
const EVENTS_MAX = 500;   // 直近この件数だけ残す
// Durable Object は1つの値が128KBまで。events は全部まとめて1つの値なので、件数だけで
// 削っていると長い名前・長い合言葉が続いたときに超える。超えると put が失敗し、
// logEvent は fire-and-forget なので**黙って記録が止まる**ため、バイト数でも削る
const EVENTS_BYTES_MAX = 100 * 1024;
const NAMES_MAX = 10;     // 1人あたり、直近この個数の名前だけ残す

const logJsonRes = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
// 保存したときのバイト数。日本語は1文字3バイトになるので、文字数で測ると足りない
const logByteLen = (o) => new TextEncoder().encode(JSON.stringify(o)).length;

// 個人IDは8桁の数字。先頭が0の番号（"00123456"）も正規のIDなので、
// どこでも数値に変換せず必ず文字列のまま扱うこと（数値にすると桁が落ちて別のIDになる）
const ID_ISSUE_TRIES = 10;
function randomDigits8() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 100000000).padStart(8, "0");
}

// 一致するまでの時間で中身を推測されないよう、必ず最後まで比較する
function logSafeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a == null ? "" : a));
  const y = enc.encode(String(b == null ? "" : b));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

export class ActivityLog {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.migrated = false;   // 旧形式の台帳を移し終えたか（このインスタンスの間だけ覚える）
  }

  // 台帳は昔「players」という**1つの値に全員分**を入れていた。Durable Object は
  // 1つの値が128KBまでなので、その持ち方だと名前の長さ次第で 166〜978人で頭打ちになる。
  // `issued:{id}` と同じ「1人1キー」に移して天井を無くす。移し終えたら旧キーを消す
  async ensureMigrated() {
    if (this.migrated) return;
    const old = await this.state.storage.get("players");
    if (old) {
      for (const [id, rec] of Object.entries(old)) {
        // 新しい形が既にあればそちらが新しいので触らない
        if (!(await this.state.storage.get(`player:${id}`))) {
          await this.state.storage.put(`player:${id}`, rec);
        }
      }
      await this.state.storage.delete("players");
    }
    this.migrated = true;
  }

  // ---- 総当たり対策：同じ相手が続けて外したら待たせる（UserRegistryと同じ形） ----
  async waitSec(key) {
    const fails = (await this.state.storage.get("fails")) || {};
    const f = fails[key];
    if (!f || !f.until || f.until < Date.now()) return 0;
    return Math.ceil((f.until - Date.now()) / 1000);
  }
  async addFail(key) {
    const fails = (await this.state.storage.get("fails")) || {};
    const now = Date.now();
    // 掃除の基準は「最後に外した時刻(at)」。待ち時間(until)で見ると、
    // まだ待たせる前（until=0）の記録まで消えてしまい、回数がいつまでも溜まらない
    for (const k of Object.keys(fails)) if ((fails[k].at || 0) < now - 86400000) delete fails[k];
    const prev = fails[key];
    const f = prev && now - (prev.at || 0) < LOG_FAIL_RESET_MS ? prev : { n: 0, until: 0 };
    f.n += 1;
    f.at = now;
    if (f.n >= LOG_FAIL_LIMIT) f.until = now + LOG_FAIL_BASE_MS * 2 ** Math.min(f.n - LOG_FAIL_LIMIT, LOG_FAIL_MAX_STEP);
    fails[key] = f;
    await this.state.storage.put("fails", fails);
  }
  async clearFail(key) {
    const fails = (await this.state.storage.get("fails")) || {};
    if (fails[key]) { delete fails[key]; await this.state.storage.put("fails", fails); }
  }

  async fetch(request) {
    const url = new URL(request.url);
    let body = {};
    try { body = await request.json(); } catch { body = {}; }

    await this.ensureMigrated();
    if (url.pathname === "/record") return this.record(body);
    if (url.pathname === "/room") return this.recordRoom(body);
    if (url.pathname === "/api/admin/rooms") return this.adminRooms(body, request);
    if (url.pathname === "/api/id/issue") return this.issueId();
    if (url.pathname === "/api/id/profile") return this.profile(body, request);
    if (url.pathname === "/api/admin/log") return this.adminLog(body, request);
    return new Response("Not found", { status: 404 });
  }

  // 個人IDに紐づく名前を読む／保存する。管理キーは不要（issueId と同じ性質）。
  //   { id }        → 読む
  //   { id, name }  → 保存して返す
  // 本人確認はしない（番号を知っている人は名乗れる、という今の作りと一貫させる）。
  // ただし**存在するIDを総当たりで探れる入口**になるので、外したときだけ待たせる。
  // 正しいIDを引く分にはミスが出ないので、普通に使う人は引っかからない
  async profile(body, request) {
    const id = String(body.id || "");
    const ip = request.headers.get("CF-Connecting-IP") || "local";
    const key = "profile:" + ip;
    if (!id) return logJsonRes({ ok: false });
    if ((await this.waitSec(key)) > 0) return logJsonRes({ ok: false });

    let p = await this.state.storage.get(`player:${id}`);
    // 台帳にも発行済み一覧にも無ければ知らない番号。「在る／無い」をエラーの形で
    // 区別させないため、空の名前を返す（発行済みなら、まだ一度も遊んでいないだけ）
    if (!p && !(await this.state.storage.get(`issued:${id}`))) {
      await this.addFail(key);
      return logJsonRes({ ok: true, name: "" });
    }
    await this.clearFail(key);

    const name = String(body.name || "").trim().slice(0, 20);
    if (name && name !== (p && p.name)) {
      const ts = Date.now();
      p = p || { firstSeenAt: ts, lastSeenAt: ts, names: [], createCount: 0, joinCount: 0 };
      p.name = name;
      if (!p.names.includes(name)) {
        p.names.push(name);
        while (p.names.length > NAMES_MAX) p.names.shift();
      }
      p.lastSeenAt = ts;
      await this.state.storage.put(`player:${id}`, p);
    }
    return logJsonRes({ ok: true, name: (p && p.name) || "" });
  }

  // 個人IDを発行する。誰でも自分の番号をもらえるべきものなので管理キーは要らない。
  // 発行済み番号は `issued:{id}` の個別キーで持つ（players のように1つのオブジェクトに
  // まとめない）。重複確認が get 1回で済み、発行数が増えても遅くならないため
  async issueId() {
    for (let i = 0; i < ID_ISSUE_TRIES; i++) {
      const id = randomDigits8();
      if (await this.state.storage.get(`issued:${id}`)) continue;
      await this.state.storage.put(`issued:${id}`, Date.now());
      return logJsonRes({ ok: true, id });
    }
    // 10回とも埋まっていた（現実にはまず起きない）。クライアント側が自前生成に切り替える
    return logJsonRes({ ok: false });
  }

  // DaifugoRoom からだけ呼ばれる内部経路。認証不要（Workerのルーターがこの経路を
  // ブラウザへは公開していない）。fire-and-forgetで呼ばれるので失敗しても影響は無い
  async record(body) {
    const ts = Date.now();
    const kind = ["create", "join", "rename"].includes(body.kind) ? body.kind : null;
    const playerId = String(body.playerId || "");
    const name = String(body.name || "").slice(0, 20);
    const code = String(body.code || "").slice(0, 20);
    if (!kind || !playerId) return logJsonRes({ ok: false });

    // パターンA：活動ログに1件追記し、直近500件だけ残す。
    // 件数だけでなくバイト数でも削る（1つの値の上限128KBを超えると put が失敗し、
    // ここは fire-and-forget なので黙って記録が止まってしまうため）
    const events = (await this.state.storage.get("events")) || [];
    events.push({ ts, kind, name, code, playerId });
    while (events.length > EVENTS_MAX) events.shift();
    while (events.length > 1 && logByteLen(events) > EVENTS_BYTES_MAX) events.shift();
    await this.state.storage.put("events", events);

    // パターンB：プレイヤー台帳をその場で更新する（1人1キー）
    const p = (await this.state.storage.get(`player:${playerId}`))
      || { firstSeenAt: ts, lastSeenAt: ts, names: [], createCount: 0, joinCount: 0 };
    p.lastSeenAt = ts;
    // 今の名前。create / join / rename のどの経路でも名前が届くので、遊んでいれば最新化される
    if (name) p.name = name;
    if (name && !p.names.includes(name)) {
      p.names.push(name);
      while (p.names.length > NAMES_MAX) p.names.shift();
    }
    // rename は「遊んだ回数」ではないので数えない（names への追加と lastSeenAt の更新だけ）
    if (kind === "create") p.createCount = (p.createCount || 0) + 1;
    else if (kind === "join") p.joinCount = (p.joinCount || 0) + 1;
    await this.state.storage.put(`player:${playerId}`, p);

    return logJsonRes({ ok: true });
  }

  // 部屋の索引。Durable Object は「今どんな部屋があるか」を一覧できないので、
  // 作られた合言葉をここに控えておく。1部屋1キー（`room:{code}`）で持ち、
  // 部屋が消えたら落とす。DaifugoRoom から fire-and-forget で呼ばれる
  async recordRoom(body) {
    const code = String(body.code || "").slice(0, 20);
    if (!code) return logJsonRes({ ok: false });
    if (body.kind === "close") {
      await this.state.storage.delete(`room:${code}`);
      return logJsonRes({ ok: true });
    }
    if (body.kind !== "open") return logJsonRes({ ok: false });
    await this.state.storage.put(`room:${code}`, {
      code, createdAt: Date.now(),
      by: String(body.name || "").slice(0, 20),
      byId: String(body.playerId || ""),
    });
    return logJsonRes({ ok: true });
  }

  // 管理画面の部屋一覧。索引は「候補」でしかない（fire-and-forget なので取りこぼしうる）。
  // 生きているかどうかはワーカー側が1部屋ずつ聞いて確かめ、死んでいた分は prune で落とす
  async adminRooms(body, request) {
    if (Array.isArray(body.prune)) {
      for (const c of body.prune.slice(0, 200)) await this.state.storage.delete(`room:${String(c)}`);
      return logJsonRes({ ok: true });
    }
    const denied = await this.adminGate(body, request);
    if (denied) return denied;
    const rooms = [];
    for (const [, v] of await this.state.storage.list({ prefix: "room:" })) rooms.push(v);
    rooms.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return logJsonRes({ ok: true, rooms });
  }

  // 管理キーの確認。通れば null、弾いたらそのまま返すレスポンス
  async adminGate(body, request) {
    if (this.env.DAIFUGO_DEV === "1") return null;
    const ip = request.headers.get("CF-Connecting-IP") || "local";
    const key = "admin:" + ip;
    const wait = await this.waitSec(key);
    if (wait > 0) return logJsonRes({ ok: false, error: `続けて間違えています。${wait}秒ほど待ってからお試しください` });
    const master = this.env.DAIFUGO_MASTER_KEY;
    if (!master) return logJsonRes({ ok: false, error: "管理キーが未設定です（wrangler secret put DAIFUGO_MASTER_KEY）" });
    if (!logSafeEqual(master, body.key)) {
      await this.addFail(key);
      return logJsonRes({ ok: false, error: "管理キーが違います" });
    }
    await this.clearFail(key);
    return null;
  }

  // 管理画面から。管理キーで保護する（PrivateRegistry・UserRegistryと同じ考え方）
  async adminLog(body, request) {
    const denied = await this.adminGate(body, request);
    if (denied) return denied;
    const events = ((await this.state.storage.get("events")) || []).slice().reverse();
    // 台帳は1人1キー。画面に返す形は今までどおり { id: レコード } にまとめ直す
    const players = {};
    for (const [k, v] of await this.state.storage.list({ prefix: "player:" })) {
      players[k.slice("player:".length)] = v;
    }
    return logJsonRes({ ok: true, events, players });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 一般の部屋。合言葉（2〜16文字。日本語も通す）がそのままDOの識別子になる。
    // 日本語はURLに乗ると percent-encoding で長さが膨らむので、正規表現では
    // 長さを見ず「スラッシュを含まない1区間」とだけ捉え、長さは decode した後に見る
    // ws=対戦の接続、status=様子を尋ねる、close=片付ける
    const m = url.pathname.match(/^\/api\/room\/([^/]+)\/(ws|status|close)$/);
    if (m) {
      let decoded;
      try { decoded = decodeURIComponent(m[1]); } catch { decoded = ""; }
      const code = normalizeCode(decoded);
      if (!code) return new Response("Bad room code", { status: 400 });
      if (m[2] !== "ws" && request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      const id = env.ROOM.idFromName(code);
      return env.ROOM.get(id).fetch(request);
    }

    // 個人IDの発行（初めて遊ぶ端末が1回だけ呼ぶ）と、IDに紐づく名前の読み書き。
    // どちらも管理キーは要らない
    if (url.pathname === "/api/id/issue" || url.pathname === "/api/id/profile") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      return env.LOG.get(env.LOG.idFromName("log")).fetch(request);
    }

    // 管理画面（プレイヤー台帳・活動ログ）。誰にもリンクしない隠しページ用のAPI
    if (url.pathname === "/api/admin/log") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      return env.LOG.get(env.LOG.idFromName("log")).fetch(request);
    }

    // 管理画面の部屋一覧。索引（候補）を受け取り、1部屋ずつ生きているか確かめてから返す。
    // 索引は fire-and-forget で書いているので取りこぼしうる。ここで確かめて、
    // もう無い部屋は索引からも落とす（放っておくと死んだ部屋が並び続ける）
    if (url.pathname === "/api/admin/rooms") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      let body = {};
      try { body = await request.clone().json(); } catch { body = {}; }
      const log = env.LOG.get(env.LOG.idFromName("log"));
      const idx = await (await log.fetch("https://log/api/admin/rooms", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: body.key }),
      })).json();
      if (!idx.ok) return new Response(JSON.stringify(idx), { headers: { "content-type": "application/json" } });

      const live = [], dead = [];
      for (const rec of idx.rooms.slice(0, 100)) {
        let st = { exists: false };
        try {
          st = await (await env.ROOM.get(env.ROOM.idFromName(rec.code)).fetch(
            `https://room/api/room/${encodeURIComponent(rec.code)}/status`,
            { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
        } catch { /* 聞けなければ死んでいる扱いにはしない */ st = { exists: true, unknown: true }; }
        if (st.exists) live.push({ ...rec, ...st });
        else dead.push(rec.code);
      }
      if (dead.length) {
        log.fetch("https://log/api/admin/rooms", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ prune: dead }),
        }).catch(() => {});
      }
      return new Response(JSON.stringify({ ok: true, rooms: live, removed: dead.length }),
        { headers: { "content-type": "application/json" } });
    }

    // 静的ファイルの配信は GET/HEAD だけ。本文つきの POST を流すと配信側が落ちる
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Not found", { status: 404 });
    return env.ASSETS.fetch(request);
  },
};
