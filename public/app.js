import { RULE_CATEGORIES, buildDefaultRules, PRESETS, presetRules, sameRules } from "./rules.js";

// --- 自作プリセット（この端末に保存される）---
const CUSTOM_KEY = "daifugo-presets";
function loadCustomPresets() {
  try { return JSON.parse(localStorage.getItem(CUSTOM_KEY)) || []; } catch { return []; }
}
function saveCustomPresets(list) { localStorage.setItem(CUSTOM_KEY, JSON.stringify(list)); }
const allPresets = () => [...PRESETS, ...loadCustomPresets()];
// 今の設定がどのプリセットと一致するか。どれとも違えば null（＝カスタム設定）
function activePresetId(rules) {
  for (const p of allPresets()) if (sameRules(presetRules(p), rules)) return p.id;
  return null;
}

const RANK_LABEL = (r) => ({ 11: "J", 12: "Q", 13: "K", 14: "A", 15: "2", 16: "Joker" }[r] || String(r));
const SUIT_SYMBOL = { S: "♠", H: "♥", D: "♦", C: "♣", JOKER: "★" };
const SUIT_COLOR = { S: "c-black", H: "c-red", D: "c-red", C: "c-black", JOKER: "c-joker" };
const PICK_RANKS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
const effRev = (r) => !!r.revolution !== !!r.tempReverse;
// 手札の並びは常に 3→2（Joker は右端）。革命・一時反転で強弱が逆になっても
// 並べ替えない（同じ札が毎回同じ位置にある方が探しやすいため）
function sortHand(hand) {
  return [...hand].sort((a, b) => {
    const sa = a.suit === "JOKER" ? 999 : a.rank;
    const sb = b.suit === "JOKER" ? 999 : b.rank;
    return sa - sb;
  });
}
function badgeColor(label) {
  if (label.startsWith("大富豪")) return "bg-amber-400 text-amber-950";
  if (label.startsWith("富豪")) return "bg-slate-300 text-slate-900";
  if (label.startsWith("平民")) return "bg-stone-400 text-stone-950";
  if (label.startsWith("大貧民")) return "bg-rose-900 text-rose-100";
  if (label.startsWith("貧民")) return "bg-orange-800 text-orange-100";
  return "bg-stone-500 text-white";
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const state = {
  playerId: localStorage.getItem("daifugo-pid") || uuid(),
  name: localStorage.getItem("daifugo-name") || "",
  night: localStorage.getItem("daifugo-night") === "1",
  screen: "home", room: null, error: "", selected: [], ws: null,
  showRules: false, openCat: null, draftRules: null,
  testMode: false, showGameRules: false, menu: null, code: "",
  // 身内ルーム（合言葉モード）。roomName は部屋コードの代わりに画面へ出す名前
  // admin は管理画面に出す部屋一覧、adminKey は操作のたびに送るマスターキー（端末に残さない）
  roomName: "", busy: false, admin: null, adminKey: "", passDraft: "",
  openRooms: null, adminOpen: [], adminAsk: null,
};
localStorage.setItem("daifugo-pid", state.playerId);

// 開発者モード：URLに ?dev=1 が付いているときだけテスト機能が見える。
// 端末に記憶はしない（通常URLで開けば必ずOFF）。記憶すると、通常URLを開いた
// つもりでも開発者メニューが出続けて紛らわしいため。
const IS_DEV = new URLSearchParams(location.search).get("dev") === "1";
localStorage.removeItem("daifugo-dev"); // 記憶方式だった頃の値の後始末

// ダミー席がある部屋は必ずテストモード（誰も自動で着手しないため）
function effTestMode() {
  const r = state.room;
  return state.testMode || !!(r && r.players.some((p) => p.isDummy));
}

// ---------- 通信 ----------
function send(obj) {
  const r = state.room;
  if (r && r.testMode && !obj.asPlayerId) obj.asPlayerId = actingId();
  obj.playerId = state.playerId;
  state.ws.send(JSON.stringify(obj));
}
function actingId() {
  const r = state.room;
  if (!r) return state.playerId;
  if (r.pending) return r.pending.playerId;
  if (r.status === "exchange" && r.exchangeNeeded && r.exchangeNeeded[0]) return r.exchangeNeeded[0].upperId;
  if (r.order && r.order.length) return r.order[r.currentTurnIndex];
  return state.playerId;
}
function connect(code, first) {
  // 部屋の状態が来る前でも部屋コードを出せるように控えておく（固まったときの確認用）
  state.code = code;
  state.roomName = "";
  openSocket(`/api/room/${code}/ws`, first, `部屋 ${code} に接続できませんでした`, "home");
}
// 身内ルーム。合言葉と引き換えに受け取った通行証でつなぐ。
// 部屋コードはサーバーから渡ってこないので、画面には部屋名を出す
function connectPrivate(ticket, roomName) {
  state.code = "";
  state.roomName = roomName;
  openSocket(`/api/private/${ticket}/ws`, { type: "enter" },
    "部屋に入れませんでした。合言葉を入れ直してください", "gate");
}
function openSocket(path, first, failMsg, backTo) {
  // 先に参照を外してから閉じる。そうしないと下の onclose が「切断」と誤判定する
  if (state.ws) { const old = state.ws; state.ws = null; old.close(); }
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}${path}`);
  // 返事が来るまでの間も部屋コードと脱出口を出しておく（ここで固まると何も分からなくなる）
  state.screen = "connecting";
  state.error = "";
  render();
  ws.onopen = () => ws.send(JSON.stringify(first));
  ws.onclose = () => {
    if (state.ws !== ws) return; // 自分で抜けたときは何もしない
    state.error = state.room
      ? "接続が切れました。タイトルに戻って入り直してください"
      : failMsg;
    if (!state.room) state.screen = backTo;
    render();
  };
  ws.onmessage = (evt) => {
    const d = JSON.parse(evt.data);
    if (d.type === "state") {
      const prevActor = state.room ? actingId() : null;
      // 身内ルームでは席のIDをサーバーが決めるので、名乗ったIDではなくサーバーの言う方に合わせる。
      // 端末のID（daifugo-pid）は書き換えない。タイトルに戻ったときに戻す
      if (d.room.you) state.playerId = d.room.you;
      state.room = d.room;
      state.error = "";
      if (!state.draftRules) state.draftRules = JSON.parse(JSON.stringify(d.room.rules));
      if (prevActor !== actingId()) state.selected = [];
      if (d.room.status === "playing" || d.room.status === "exchange") state.screen = "game";
      else if (d.room.status === "finished") state.screen = "finished";
      else state.screen = "lobby";
    } else if (d.type === "kicked") { resetToTitle("この部屋から外されました"); return; }
    else if (d.type === "disbanded") { resetToTitle("部屋が解散されました"); return; }
    else if (d.type === "error") state.error = d.message;
    render();
  };
  state.ws = ws;
}

// 部屋との接続を切ってスタート画面へ。詰まったときの共通の脱出口
function resetToTitle(message) {
  if (state.ws) { try { state.ws.close(); } catch { /* 切れていれば何もしない */ } }
  Object.assign(state, {
    ws: null, room: null, code: "", draftRules: null, selected: [], menu: null,
    showRules: false, openCat: null, testMode: false, showGameRules: false,
    roomName: "", busy: false, admin: null, adminKey: "", passDraft: "",
    openRooms: null, adminOpen: [], adminAsk: null,
    // 身内ルームで借りていた席のIDを、この端末のIDに戻す
    playerId: localStorage.getItem("daifugo-pid") || state.playerId,
    error: message || "", screen: "home",
  });
  render();
}

// ---------- 操作 ----------
const W = window;
W.createRoom = () => {
  state.name = document.getElementById("name-input").value.trim();
  if (!state.name) { state.error = "名前を入力してください"; return render(); }
  localStorage.setItem("daifugo-name", state.name);
  const code = Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");
  connect(code, { type: "create", playerId: state.playerId, name: state.name, code });
};
W.joinRoom = () => {
  state.name = document.getElementById("name-input").value.trim();
  const code = document.getElementById("code-input").value.trim().toUpperCase();
  if (!state.name) { state.error = "名前を入力してください"; return render(); }
  if (!code) { state.error = "部屋コードを入力してください"; return render(); }
  localStorage.setItem("daifugo-name", state.name);
  connect(code, { type: "join", playerId: state.playerId, name: state.name });
};
// ---------- 身内ルーム ----------
// 合言葉は「部屋を開ける鍵」。持つのは知り合いだけで、その友達は持たない。
// 鍵を持つ人が入っている間だけ部屋が一覧に出て、友達は合言葉なしで入れる。
// 合言葉はサーバーにしか無く、ブラウザには通行証と部屋名しか渡ってこない。
const PASS_KEY = "daifugo-pass";
const post = (path, body) =>
  fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then((r) => r.json())
    .catch(() => ({ ok: false, error: "つながりませんでした。通信を確認してください" }));

async function tryPass(pass, remember) {
  state.busy = true; state.error = ""; render();
  const d = await post("/api/gate", { pass });
  state.busy = false;
  if (!d.ok) { state.error = d.error || "合言葉が違います"; state.screen = "gate"; return render(); }
  state.passDraft = "";
  if (remember) localStorage.setItem(PASS_KEY, pass); else localStorage.removeItem(PASS_KEY);
  connectPrivate(d.ticket, d.roomName);
}
// 隅の入口。鍵を覚えている端末はそのまま自分の部屋を開く（2回目以降は入力なし）。
// 持っていない人には「いま遊べる部屋」を出す
W.openGate = () => {
  const saved = localStorage.getItem(PASS_KEY);
  if (saved) return tryPass(saved, true);
  state.screen = "gate"; state.error = ""; state.openRooms = null;
  render();
  loadOpenRooms();
};
async function loadOpenRooms() {
  const d = await post("/api/open", {});
  state.openRooms = d.ok ? d.rooms : [];
  if (state.screen === "gate") render();
}
W.reloadOpen = () => { state.openRooms = null; render(); loadOpenRooms(); };
// 友達の入室。合言葉は要らない。名前だけ入れてもらう
W.joinOpen = async (roomId) => {
  const el = document.getElementById("guest-name");
  const name = ((el ? el.value : "") || "").trim();
  if (!name) { state.error = "名前を入力してください"; return render(); }
  state.name = name;
  localStorage.setItem("daifugo-name", name);
  state.busy = true; state.error = ""; render();
  const d = await post("/api/join", { roomId, name, playerId: localStorage.getItem("daifugo-pid") || "" });
  state.busy = false;
  if (!d.ok) {
    // その部屋が閉じた直後だとここに来る。一覧を取り直して現状を見せる
    state.error = d.error || "入れませんでした";
    render(); loadOpenRooms(); return;
  }
  connectPrivate(d.ticket, d.roomName);
};
W.enterPass = () => {
  const pass = (document.getElementById("pass-input").value || "").trim();
  state.passDraft = pass; // 間違えたときに打ち直さなくて済むよう控えておく
  if (!pass) { state.error = "合言葉を入力してください"; return render(); }
  tryPass(pass, document.getElementById("pass-remember").checked);
};
W.forgetPass = () => {
  localStorage.removeItem(PASS_KEY);
  state.menu = null;
  resetToTitle("この端末から合言葉を消しました");
};

// 管理画面。マスターキーは端末に残さず、操作のたびに送る
W.openAdmin = () => { state.screen = "admin"; state.admin = null; state.error = ""; render(); };
async function adminCall(body) {
  if (!state.adminKey) return;
  state.busy = true; render();
  const d = await post("/api/admin", { key: state.adminKey, ...body });
  state.busy = false;
  if (!d.ok) { state.error = d.error || "失敗しました"; state.admin = null; state.adminKey = ""; }
  else { state.error = ""; state.admin = d.keys; state.adminOpen = d.open || []; }
  render();
}
W.adminLogin = () => {
  state.adminKey = (document.getElementById("admin-key").value || "").trim();
  if (!state.adminKey) { state.error = "管理キーを入力してください"; return render(); }
  adminCall({ action: "list" });
};
W.adminAct = (action, keyId) => adminCall({ action, keyId });
W.adminAddKey = () => {
  const el = document.getElementById("new-key");
  const name = (el.value || "").trim();
  if (!name) { state.error = "名前を入力してください"; return render(); }
  el.value = "";
  adminCall({ action: "addKey", name });
};
W.adminToggle = (keyId, disabled) => adminCall({ action: "setDisabled", keyId, disabled });
// 名前に引用符が入っても壊れないよう、合言葉そのものではなくIDを渡して引き当てる
W.copyPass = (keyId) => {
  const k = (state.admin || []).find((x) => x.id === keyId);
  if (!k) return;
  navigator.clipboard.writeText(k.pass).then(
    () => { state.error = `${k.name} の合言葉をコピーしました`; render(); },
    () => { state.error = "コピーできませんでした。長押しで選択してください"; render(); });
};
// 消すものは取り返しがつかないので必ず一度止める
W.adminAsk = (action, keyId) => { state.adminAsk = { action, keyId }; render(); };
W.adminAskNo = () => { state.adminAsk = null; render(); };
W.adminAskYes = () => { const a = state.adminAsk; state.adminAsk = null; adminCall(a); };
W.resetToTitleBtn = () => resetToTitle();
// 知らない人が入ってきたときに、ホストが席から外す（ロビー中のみ）
W.kickPlayer = (targetId) => send({ type: "kick", targetId });

// 開発用：部屋コードのやり取りを省いて、決め打ちの部屋に直行する（?dev=1 のときだけ出る）
const DEV_CODE = "DEV0";
W.devEnter = () => {
  const input = document.getElementById("name-input");
  state.name = ((input ? input.value : "") || "").trim() || "開発者";
  localStorage.setItem("daifugo-name", state.name);
  connect(DEV_CODE, { type: "enter", playerId: state.playerId, name: state.name, code: DEV_CODE });
};
W.startGame = () => send({ type: "start", testMode: effTestMode(), asPlayerId: null });
W.addCPU = () => send({ type: "addCPU", asPlayerId: null });
W.removeCPU = () => send({ type: "removeCPU", asPlayerId: null });
W.addDummy = () => send({ type: "addDummy", asPlayerId: null });
W.removeDummy = () => send({ type: "removeDummy", asPlayerId: null });
W.rematch = () => send({ type: "rematch", asPlayerId: null });
// スタート画面に戻る。ロビーなら席も空ける（対戦中はサーバーが退出を受け付けないので、
// 接続だけ切って抜ける。playerId は端末に残るので、同じ部屋コードで入り直せば席に戻れる）
W.leaveRoom = () => {
  if (state.room && state.room.status === "waiting") send({ type: "leave", asPlayerId: null });
  resetToTitle();
};
W.toggleMenu = (v) => { state.menu = v || null; render(); };
W.closeMenu = (e) => { if (e.target.classList.contains("overlay")) { state.menu = null; render(); } };
W.abortGame = () => { state.menu = null; send({ type: "abort", asPlayerId: null }); };
W.disbandRoom = () => { state.menu = null; send({ type: "disband", asPlayerId: null }); };
W.toggleTestMode = () => { state.testMode = !state.testMode; render(); };
W.toggleRulesPanel = () => { state.showRules = !state.showRules; render(); };
W.toggleCat = (id) => { state.openCat = state.openCat === id ? null : id; render(); };
W.toggleNight = () => {
  state.night = !state.night;
  localStorage.setItem("daifugo-night", state.night ? "1" : "0");
  document.body.classList.toggle("night", state.night);
  render();
};
W.setRule = (key, group, value) => {
  if (group === "forbidden") state.draftRules.forbidden[key] = value;
  else state.draftRules[key] = value;
  render();
};
W.applyPreset = (id) => {
  const p = allPresets().find((x) => x.id === id);
  if (!p) return;
  state.draftRules = presetRules(p);
  send({ type: "setRules", rules: state.draftRules, asPlayerId: null });
};
W.saveAsPreset = () => {
  const input = document.getElementById("preset-name");
  const label = (input ? input.value : "").trim();
  if (!label) { state.error = "プリセット名を入力してください"; return render(); }
  const list = loadCustomPresets();
  const existing = list.findIndex((p) => p.label === label);
  const entry = { id: existing >= 0 ? list[existing].id : `my-${Date.now()}`, label, custom: true,
    desc: "自分で保存した設定", apply: JSON.parse(JSON.stringify(state.draftRules)) };
  if (existing >= 0) list[existing] = entry; else list.push(entry);
  saveCustomPresets(list);
  state.error = "";
  render();
};
W.deletePreset = (id) => {
  saveCustomPresets(loadCustomPresets().filter((p) => p.id !== id));
  render();
};
W.toggleGameRules = () => { state.showGameRules = !state.showGameRules; render(); };
W.applyRules = () => send({ type: "setRules", rules: state.draftRules, asPlayerId: null });
W.toggleSelect = (json) => {
  const card = JSON.parse(decodeURIComponent(json));
  const i = state.selected.findIndex((c) => c.id === card.id);
  if (i >= 0) state.selected.splice(i, 1); else state.selected.push(card);
  render();
};
W.submitPlay = () => {
  if (!state.selected.length) { state.error = "カードを選んでください"; return render(); }
  send({ type: "play", cards: state.selected });
  state.selected = [];
};
W.submitPass = () => send({ type: "pass" });
W.submitPending = () => {
  send({ type: "resolve", payload: { cards: state.selected } });
  state.selected = [];
};
W.submitBomber = (rank) => send({ type: "resolve", payload: { rank: Number(rank) } });
W.submitExchange = () => {
  send({ type: "exchange", cards: state.selected });
  state.selected = [];
};

// ---------- 描画パーツ ----------
// 画面に出す部屋の呼び名。身内ルームは部屋コードを持たない（渡すと合言葉が意味を失う）ので名前を出す
const roomLabel = (r) => (!r ? "" : r.private ? r.name || "身内ルーム" : r.code || "");
function nightBtn() {
  return `<button onclick="toggleNight()" class="btn-sub px-3 py-1 rounded-lg text-sm">${state.night ? "☀︎" : "☾"}</button>`;
}
function cardFace(card, selected, clickable, small) {
  const isJoker = card.suit === "JOKER";
  const cls = `card ${small ? "small" : ""} ${isJoker ? "card-joker" : ""} ${selected ? "card-sel" : "card-normal"} ${clickable ? "clickable" : ""}`;
  const oc = clickable ? `onclick="toggleSelect('${encodeURIComponent(JSON.stringify(card))}')"` : "";
  if (isJoker) {
    return `<button ${oc} class="${cls}"><span class="jk-face">🃏</span><span class="jk-txt">JOKER</span></button>`;
  }
  return `<button ${oc} class="${cls}">
    <span class="cd-rank ${SUIT_COLOR[card.suit]}">${RANK_LABEL(card.rank)}</span>
    <span class="cd-suit ${SUIT_COLOR[card.suit]}">${SUIT_SYMBOL[card.suit]}</span></button>`;
}
// 手札は何枚でも必ず1行。カードを重ねて幅に収める（CSSの .hand-row 参照）
function handRow(hand) {
  return `<div class="hand-row">${hand.map((c) =>
    cardFace(c, state.selected.some((s) => s.id === c.id), true, false)).join("")}</div>`;
}
// 重なり量と文字サイズは、描画後の実際の幅から決める。
// 枚数が多いほど詰まり、左端に残る帯（＝見える幅）に収まるところまで数字を縮める。
const CARD_W = 56;
function layoutHand() {
  for (const row of document.querySelectorAll(".hand-row")) {
    const n = row.children.length;
    if (!n) continue;
    const w = row.clientWidth - 1; // 端数で横スクロールが出ないよう1px余らせる
    const strip = n > 1 ? Math.min(CARD_W + 4, (w - CARD_W) / (n - 1)) : CARD_W;
    // 「10」が帯に収まる大きさ。1.2 は太字2桁のおおよその幅（em）
    const fs = Math.max(10, Math.min(17.6, (strip - 3) / 1.2));
    row.style.setProperty("--hand-m", (strip - CARD_W).toFixed(2) + "px");
    row.style.setProperty("--hand-fs", fs.toFixed(1) + "px");
  }
}
window.addEventListener("resize", layoutHand);
// 場は、いま場が流れずに続いている間に出た手をまとめて見せる（room.pile）。
// 最後の1手だけ大きく、それより前の手は小さく薄く左に並べる。
// 場が流れると pile はサーバー側で空になるので、ここも自動的に「場は空です」に戻る。
function fieldDisplay(r) {
  const pile = r.pile || [];
  if (!pile.length) return `<p class="field-empty">場は空です（自由に出せます）</p>`;
  const lastIdx = pile.length - 1;
  return `<div class="pile">${pile.map((g, i) => `<div class="pile-g ${i === lastIdx ? "now" : "old"}">${
    g.cards.map((c) => cardFace(c, false, false, true)).join("")}</div>`).join("")}</div>`;
}
function rulesSummary(rules) {
  let n = 0;
  for (const cat of RULE_CATEGORIES) for (const r of cat.rules) {
    if (r.type !== "bool") continue;
    const v = r.group === "forbidden" ? rules.forbidden[r.key] : rules[r.key];
    if (v) n++;
  }
  return `${n}項目ON`;
}
function ruleRow(rule, rules, editable) {
  const val = rule.group === "forbidden" ? rules.forbidden[rule.key] : rules[rule.key];
  const dis = editable ? "" : "disabled";
  const g = rule.group || "";
  if (rule.type === "select") {
    const opt = rule.options.find((o) => String(o.v) === String(val));
    return `<label class="rule-row rule-sel">
      <span class="flex-1"><span class="rule-label">${rule.label}<span class="rule-val">${esc(opt ? opt.l : "")}</span></span>
      ${rule.desc ? `<span class="rule-desc">${rule.desc}</span>` : ""}</span>
      <select ${dis} onchange="setRule('${rule.key}','${g}', this.value === String(Number(this.value)) ? Number(this.value) : this.value)" class="inp text-xs rounded px-2 py-1 ml-2">
        ${rule.options.map((o) => `<option value="${o.v}" ${String(val) === String(o.v) ? "selected" : ""}>${o.l}</option>`).join("")}
      </select></label>`;
  }
  return `<label class="rule-row ${val ? "rule-on" : ""} ${editable ? "cursor-pointer" : ""}">
    <input type="checkbox" ${val ? "checked" : ""} ${dis} onchange="setRule('${rule.key}','${g}', this.checked)" class="rule-check" />
    <span class="flex-1"><span class="rule-label">${rule.label}</span>
    ${rule.desc ? `<span class="rule-desc">${rule.desc}</span>` : ""}</span></label>`;
}
// ゲーム中に現在のルールを確認するための重ね表示
function gameRulesOverlay() {
  if (!state.showGameRules) return "";
  return `<div class="overlay" onclick="toggleGameRules()">
    <div class="overlay-body" onclick="event.stopPropagation()">
      <div class="overlay-head"><span>現在のルール</span>
        <button onclick="toggleGameRules()" class="btn-sub px-3 py-1 rounded-lg text-xs">閉じる</button></div>
      ${rulesPanel(false)}
    </div></div>`;
}
// どの画面からでも抜けられるようにするメニュー。
// 「中断」「解散」は取り返しがつかないので、必ず確認をはさむ（state.menu が段階を持つ）
function menuBtn() {
  return `<button onclick="toggleMenu('main')" class="btn-sub menu-btn" title="メニュー">☰</button>`;
}
function confirmBox(title, body, okLabel, fn) {
  return `<div class="overlay overlay-center"><div class="overlay-body">
    <p class="pop-t">${title}</p>
    <p class="pop-d">${body}</p>
    <div class="flex gap-2 mt-4">
      <button onclick="toggleMenu('main')" class="btn-sub rounded-lg py-3 font-bold" style="flex:1">やめる</button>
      <button onclick="${fn}()" class="btn-play rounded-lg py-3 font-bold" style="flex:1">${okLabel}</button>
    </div></div></div>`;
}
function menuOverlay() {
  if (!state.menu) return "";
  const r = state.room;
  const isHost = !!r && r.hostId === state.playerId;
  const playing = !!r && (r.status === "playing" || r.status === "exchange");
  if (state.menu === "abort") return confirmBox("対戦を中断しますか？",
    "いまの対戦をやめて、全員ロビーに戻します。手札と順位は失われます。", "中断する", "abortGame");
  if (state.menu === "disband") return confirmBox("部屋を解散しますか？",
    "部屋そのものを消します。全員がスタート画面に戻り、この部屋コードは使えなくなります。", "解散する", "disbandRoom");
  return `<div class="overlay overlay-center" onclick="closeMenu(event)"><div class="overlay-body">
    <div class="overlay-head"><span>メニュー</span>
      <button onclick="toggleMenu()" class="btn-sub px-3 py-1 rounded-lg text-sm">閉じる</button></div>
    <div class="menu-list">
      ${isHost && playing ? `<button onclick="toggleMenu('abort')" class="btn-sub menu-item">対戦を中断してロビーへ</button>` : ""}
      ${isHost && !(r && r.private) ? `<button onclick="toggleMenu('disband')" class="btn-sub menu-item">部屋を解散する</button>` : ""}
      <button onclick="leaveRoom()" class="btn-sub menu-item">タイトルに戻る</button>
      ${r && r.private && localStorage.getItem(PASS_KEY)
        ? `<button onclick="forgetPass()" class="btn-sub menu-item">合言葉をこの端末から消す</button>` : ""}
    </div>
    <p class="dev-note">「タイトルに戻る」は自分だけが抜けます。${r && r.private
      ? "同じ合言葉で入り直せば席に戻れます。身内ルームは解散できません（消すのは管理画面から）。"
      : "同じ端末なら、同じ部屋コードで入り直せば席に戻れます。"}
    ${isHost ? "" : "「中断」はホストだけが操作できます。"}</p>
  </div></div>`;
}
// 管理画面。ここに出る合言葉は、ヨコさんが相手に伝えるためのもの。
// マスターキーは端末に保存せず、画面を閉じたら消える
function adminScreen() {
  if (!state.admin) {
    return `<div class="min-h-screen flex items-center justify-center p-4">
      <div class="w-full max-w-sm panel rounded-2xl p-6">
        <h1 class="title">管理</h1>
        <p class="t-dim text-center text-sm mb-6">身内ルームの合言葉を発行・停止します</p>
        <input id="admin-key" type="password" autocomplete="off" placeholder="管理キー"
          onkeydown="if(event.key==='Enter')adminLogin()" class="inp w-full mb-3 px-3 py-2 rounded-lg text-center" />
        <button onclick="adminLogin()" ${state.busy ? "disabled" : ""}
          class="btn-play w-full py-3 rounded-lg font-bold mb-3">${state.busy ? "確認中…" : "開く"}</button>
        <button onclick="resetToTitleBtn()" class="btn-sub w-full py-2 rounded-lg text-sm">← タイトルに戻る</button>
        ${state.error ? `<p class="err mt-4 text-center">${esc(state.error)}</p>` : ""}
      </div></div>`;
  }
  const ask = state.adminAsk;
  const askBox = !ask ? "" : `<div class="overlay overlay-center"><div class="overlay-body">
    <p class="pop-t">この人を削除しますか？</p>
    <p class="pop-d">合言葉が消え、この人の部屋も開けなくなります。
    もう一度使ってもらうには、登録し直して新しい合言葉を伝えることになります。</p>
    <div class="flex gap-2 mt-4">
      <button onclick="adminAskNo()" class="btn-sub rounded-lg py-3 font-bold" style="flex:1">やめる</button>
      <button onclick="adminAskYes()" class="btn-play rounded-lg py-3 font-bold" style="flex:1">削除する</button>
    </div></div></div>`;

  return `<div class="min-h-screen p-4"><div class="max-w-lg mx-auto">
    <div class="admin-head">
      <h2 class="t-accent text-lg font-bold">身内ルーム管理</h2>
      <span class="flex gap-2">${nightBtn()}
        <button onclick="resetToTitleBtn()" class="btn-sub px-3 py-1 rounded-lg text-sm">閉じる</button></span>
    </div>
    ${state.error ? `<p class="err mb-3 text-center text-sm">${esc(state.error)}</p>` : ""}
    <div class="panel rounded-xl p-4 mb-3">
      <p class="t-dim text-sm mb-2">部屋を開ける人（この人たちだけが合言葉を持ちます）</p>
      ${state.admin.length ? `<ul class="mb-3">${state.admin.map((k) => {
        const nowOpen = (state.adminOpen || []).find((o) => o.id === k.id);
        return `<li class="mem-row ${k.disabled ? "mem-off" : ""}">
          <span class="mem-name">${esc(k.name)}
            ${nowOpen ? `<span class="open-badge">いま開いています・${nowOpen.count}人</span>` : ""}
            ${k.disabled ? '<span class="err text-xs">停止中</span>' : ""}</span>
          <code class="mem-pass">${esc(k.pass)}</code>
          <span class="mem-btns">
            <button onclick="copyPass('${k.id}')" class="btn-sub">コピー</button>
            <button onclick="adminAct('regenPass','${k.id}')" class="btn-sub">再発行</button>
            <button onclick="adminToggle('${k.id}',${!k.disabled})" class="btn-sub">${k.disabled ? "再開" : "停止"}</button>
            <button onclick="adminAsk('deleteKey','${k.id}')" class="btn-sub">削除</button>
          </span>
        </li>`;
      }).join("")}</ul>` : `<p class="t-dim text-sm mb-3">まだ誰も登録されていません</p>`}
      <div class="mem-add">
        <input id="new-key" placeholder="名前（例：タロウ）"
          onkeydown="if(event.key==='Enter')adminAddKey()" class="inp px-2 py-1 rounded text-sm" />
        <button onclick="adminAddKey()" class="btn-sub px-3 py-1 rounded text-sm font-bold">追加</button>
      </div>
    </div>
    <p class="dev-note">合言葉を渡すのはここに並んでいる人だけです。<strong>その友達には何も渡しません。</strong>
    この人が部屋を開けている間、友達は ♠ の一覧からタップするだけで入れます。<br>
    漏れたと思ったら「再発行」で、その人の分だけ変わります（他の人はそのまま遊べます）。
    「停止」は登録を残したまま開けなくします。</p>
  </div>${askBox}</div>`;
}
function rulesPanel(editable) {
  const rules = editable ? state.draftRules : state.room.rules;
  const activeId = activePresetId(rules);
  return `<div class="panel rounded-xl p-3 mb-3 text-left">
    ${editable ? `<div class="mb-3">
      <div class="preset-head">
        <span class="t-dim text-xs">プリセット</span>
        <span class="preset-now">${activeId
          ? `適用中：${esc((allPresets().find((p) => p.id === activeId) || {}).label || "")}`
          : "カスタム設定（プリセットと不一致）"}</span>
      </div>
      <div class="grid grid-cols-2 gap-2">
        ${allPresets().map((p) => `<button onclick="applyPreset('${p.id}')" class="btn-sub preset ${p.id === activeId ? "preset-on" : ""} py-2 px-2 rounded-lg text-xs text-left">
          ${p.id === activeId ? '<span class="preset-check">✓</span>' : ""}
          ${p.custom ? `<span class="preset-del" onclick="event.stopPropagation();deletePreset('${p.id}')">×</span>` : ""}
          <span class="block font-bold">${esc(p.label)}</span>
          <span class="t-dim block text-[10px] leading-tight mt-0.5">${esc(p.desc || "")}</span></button>`).join("")}
      </div>
      <div class="preset-save">
        <input id="preset-name" placeholder="この設定に名前を付けて保存" class="inp flex-1 rounded px-2 py-1 text-xs" />
        <button onclick="saveAsPreset()" class="btn-sub px-3 py-1 rounded text-xs font-bold">保存</button>
      </div>
      <p class="t-dim text-[10px] mt-1">保存した設定はこの端末に残り、次回もここから選べます</p>
    </div>` : `<p class="t-dim text-xs mb-2">ホストが設定したルール（閲覧のみ）</p>`}
    ${RULE_CATEGORIES.map((cat) => {
      const open = state.openCat === cat.id;
      const onCount = cat.rules.filter((r) => r.type === "bool" && (r.group === "forbidden" ? rules.forbidden[r.key] : rules[r.key])).length;
      return `<div class="cat">
        <button onclick="toggleCat('${cat.id}')" class="cat-head">
          <span>${cat.label}</span>
          <span class="t-dim text-xs">${onCount > 0 ? onCount + "個ON" : "—"} ${open ? "▲" : "▼"}</span>
        </button>
        ${open ? `<div class="cat-body">
          ${cat.note ? `<p class="t-dim text-[11px] mb-2">${cat.note}</p>` : ""}
          ${cat.rules.map((r) => ruleRow(r, rules, editable)).join("")}
        </div>` : ""}
      </div>`;
    }).join("")}
    ${editable ? `<button onclick="applyRules()" class="btn-play w-full mt-3 py-2 rounded-lg font-bold text-sm">この設定を適用</button>` : ""}
  </div>`;
}

// ---------- 画面 ----------
// 描画したあとに手札の重なりを実測で調整する（paint は途中で return するので外側で呼ぶ）
// rAF でもう一度測るのは、描画直後だと幅がまだ確定していないことがあるため
function render() { paint(); layoutHand(); requestAnimationFrame(layoutHand); }
function paint() {
  const app = document.getElementById("app");

  if (state.screen === "home") {
    app.innerHTML = `<div class="min-h-screen flex items-center justify-center p-4">
      <div class="w-full max-w-sm panel rounded-2xl p-6">
        <div class="flex justify-end mb-2">${nightBtn()}</div>
        <h1 class="title">大富豪</h1>
        <p class="t-dim text-center text-sm mb-6">友達とオンライン対戦</p>
        <label class="block t-dim text-sm mb-1">名前</label>
        <input id="name-input" value="${esc(state.name)}" placeholder="あなたの名前を入力" class="inp w-full mb-4 px-3 py-2 rounded-lg" />
        <button onclick="createRoom()" class="btn-play w-full py-3 rounded-lg font-bold mb-3">部屋を作る</button>
        <div class="divider"><span>または</span></div>
        <input id="code-input" placeholder="部屋コード" maxlength="4" class="inp w-full mb-3 px-3 py-2 rounded-lg tracking-widest text-center uppercase" />
        <button onclick="joinRoom()" class="btn-sub w-full py-3 rounded-lg font-bold">部屋に参加する</button>
        ${IS_DEV ? `<div class="devbox mt-4">
          <p class="dev-t">開発者メニュー</p>
          <button onclick="devEnter()" class="btn-sub w-full py-2 rounded-lg font-bold text-sm">開発部屋に入る</button>
          <p class="dev-note">部屋コードなしで固定の部屋「${DEV_CODE}」に直行します。
          無ければその場で作られ、すでにあれば参加します。名前が空なら「開発者」になります。</p>
        </div>` : ""}
        ${state.error ? `<p class="err mt-4 text-center">${esc(state.error)}</p>` : ""}
      </div>
      <button onclick="openGate()" class="corner-mark" title="身内用">♠</button></div>`;
    return;
  }

  // 身内ルームの入口。上が友達用（開いている部屋を選ぶ）、下が鍵を持つ人用（合言葉）
  if (state.screen === "gate") {
    const rooms = state.openRooms;
    const list = rooms === null
      ? `<p class="t-dim text-center text-sm py-3">確認中…</p>`
      : rooms.length === 0
        ? `<p class="t-dim text-center text-sm py-3">いま開いている部屋はありません。<br>知り合いが入るまで待ってください。</p>`
        : rooms.map((rm) => `<button onclick="joinOpen('${rm.id}')" ${state.busy ? "disabled" : ""} class="open-room">
            <span class="open-dot"></span><span class="open-name">${esc(rm.name)}</span>
            <span class="open-count">${rm.count}人</span></button>`).join("");

    app.innerHTML = `<div class="min-h-screen flex items-center justify-center p-4">
      <div class="w-full max-w-sm panel rounded-2xl p-6">
        <div class="flex justify-end mb-2">${nightBtn()}</div>
        <h2 class="t-accent text-center font-bold mb-1">いま遊べる部屋</h2>
        <p class="t-dim text-center text-xs mb-3">選んでそのまま入れます</p>
        <div class="open-list mb-3">${list}</div>
        <input id="guest-name" value="${esc(state.name)}" placeholder="あなたの名前"
          class="inp w-full mb-2 px-3 py-2 rounded-lg" />
        <button onclick="reloadOpen()" class="btn-sub w-full py-2 rounded-lg text-xs mb-4">一覧を更新</button>

        <div class="divider"><span>部屋を開ける人はこちら</span></div>
        <input id="pass-input" type="password" autocomplete="off" placeholder="合言葉" value="${esc(state.passDraft || "")}"
          onkeydown="if(event.key==='Enter')enterPass()" class="inp w-full mb-2 px-3 py-2 rounded-lg text-center" />
        <label class="gate-remember"><input type="checkbox" id="pass-remember" checked class="rule-check" />
          <span>この端末に覚えておく（次回から入力なしで開けます）</span></label>
        <button onclick="enterPass()" ${state.busy ? "disabled" : ""}
          class="btn-play w-full py-3 rounded-lg font-bold mb-3 mt-3">${state.busy ? "確認中…" : "部屋を開く"}</button>
        <button onclick="resetToTitleBtn()" class="btn-sub w-full py-2 rounded-lg text-sm">← タイトルに戻る</button>
        ${state.error ? `<p class="err mt-4 text-center">${esc(state.error)}</p>` : ""}
        <button onclick="openAdmin()" class="gate-admin">管理</button>
      </div></div>`;
    return;
  }

  if (state.screen === "admin") { app.innerHTML = adminScreen(); return; }

  const r = state.room;
  // 接続待ちのまま返事が来ないこともあるので、ここにも部屋コードと脱出口を置く
  if (!r) {
    app.innerHTML = `<div class="min-h-screen flex flex-col items-center justify-center gap-3">
      ${state.code ? `<span class="t-dim text-sm">部屋コード</span><div class="roomcode">${esc(state.code)}</div>` : ""}
      ${state.roomName ? `<span class="t-dim text-sm">身内ルーム</span><div class="roomname">${esc(state.roomName)}</div>` : ""}
      <span class="t-dim">接続中…</span>
      <button onclick="leaveRoom()" class="btn-sub px-6 py-2 rounded-lg text-sm mt-2">タイトルに戻る</button>
    </div>`;
    return;
  }
  const isHost = r.hostId === state.playerId;
  const me = r.players.find((p) => p.id === state.playerId);

  if (state.screen === "lobby") {
    const hasDummy = r.players.some((p) => p.isDummy);
    const testOn = effTestMode();
    const minPlayers = testOn ? 2 : 3;
    app.innerHTML = `<div class="min-h-screen p-4"><div class="max-w-sm mx-auto">
      <div class="flex justify-between items-center mb-2">
        <button onclick="leaveRoom()" class="btn-sub px-3 py-1 rounded-lg text-xs">← 戻る</button>
        <span class="flex gap-2 items-center">${menuBtn()}${nightBtn()}</span>
      </div>
      ${r.private ? `<h2 class="t-accent text-center text-sm mb-1">身内ルーム</h2>
      <div class="roomname">${esc(r.name || "")}</div>
      <p class="t-dim text-center text-xs mb-5">${r.keyPresent
        ? "開いています。友達は ♠ の一覧からそのまま入れます"
        : "閉じています。部屋の持ち主が入るまで新しい人は入れません"}</p>`
      : `<h2 class="t-accent text-center text-sm mb-1">部屋コード</h2>
      <div class="roomcode">${r.code}</div>
      <p class="t-dim text-center text-xs mb-5">友達にこのコードを伝えてください</p>`}
      <div class="panel rounded-xl p-4 mb-3">
        <p class="t-dim text-sm mb-2">参加者（${r.players.length}/6）</p>
        <ul class="space-y-1">${r.players.map((p) => `<li class="flex items-center gap-2 t-main text-sm">
          <span class="dot ${p.isCPU ? "dot-cpu" : p.isDummy ? "dot-dummy" : "dot-human"}"></span>${esc(p.name)}
          ${p.isCPU ? '<span class="tag-cpu">CPU</span>' : ""}
          ${p.isDummy ? '<span class="tag-dummy">手動</span>' : ""}
          ${p.id === r.hostId ? '<span class="t-accent text-xs">ホスト</span>' : ""}
          ${p.id === state.playerId ? '<span class="t-dim text-xs">あなた</span>' : ""}
          ${r.classes && r.classes[p.id] ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${badgeColor(r.classes[p.id])}">${r.classes[p.id]}</span>` : ""}
          ${isHost && r.private && p.id !== r.roomId && p.id !== state.playerId
            ? `<button onclick="kickPlayer('${p.id}')" class="btn-sub kick-btn">外す</button>` : ""}
        </li>`).join("")}</ul>
      </div>
      ${isHost ? `<div class="flex gap-2 mb-2">
        <button onclick="addCPU()" ${r.players.length >= 6 ? "disabled" : ""} class="btn-sub flex-1 py-2 rounded-lg text-sm font-bold">CPUを追加</button>
        <button onclick="removeCPU()" ${!r.players.some((p) => p.isCPU) ? "disabled" : ""} class="btn-sub flex-1 py-2 rounded-lg text-sm font-bold">CPUを削除</button>
      </div>` : ""}
      ${isHost && IS_DEV ? `<div class="devbox">
        <p class="dev-t">開発者メニュー</p>
        <button onclick="toggleTestMode()" ${hasDummy ? "disabled" : ""} class="btn-sub w-full py-2 mb-2 rounded-lg text-sm flex justify-between px-4">
          <span>テストモード</span><span class="${testOn ? "err font-bold" : "t-dim"} text-xs">${
            hasDummy ? "ON（ダミー席のため自動）" : testOn ? "ON（全員の手札が見える）" : "OFF"}</span></button>
        <div class="flex gap-2">
          <button onclick="addDummy()" ${r.players.length >= 6 ? "disabled" : ""} class="btn-sub flex-1 py-2 rounded-lg text-sm font-bold">ダミー席を追加</button>
          <button onclick="removeDummy()" ${!hasDummy ? "disabled" : ""} class="btn-sub flex-1 py-2 rounded-lg text-sm font-bold">ダミー席を削除</button>
        </div>
        <p class="dev-note">ダミー席は自動で着手しません。全員分を自分で操作できます。</p>
      </div>` : ""}
      <button onclick="toggleRulesPanel()" class="btn-sub w-full py-2 mb-2 rounded-lg text-sm flex justify-between px-4">
        <span>ルール設定を${state.showRules ? "隠す" : "表示"}</span><span class="t-dim text-xs">${rulesSummary(r.rules)}</span></button>
      ${state.showRules ? rulesPanel(isHost) : ""}
      ${isHost ? `<button onclick="startGame()" ${r.players.length < minPlayers ? "disabled" : ""} class="btn-play w-full py-3 rounded-lg font-bold">
        ${r.players.length < minPlayers ? `${minPlayers}人以上で開始できます` : testOn ? "テストモードで開始" : "ゲーム開始"}</button>`
      : `<p class="t-dim text-center">ホストの開始を待っています…</p>`}
      ${state.error ? `<p class="err mt-3 text-center text-sm">${esc(state.error)}</p>` : ""}
    </div>${menuOverlay()}</div>`;
    return;
  }

  if (state.screen === "game" && me) {
    const isTest = !!r.testMode;
    const rev = effRev(r);
    const actId = actingId();
    const act = r.players.find((p) => p.id === actId) || me;
    const canAct = isTest ? !act.isCPU : actId === state.playerId;
    const hand = sortHand((isTest ? act.hand : me.hand) || []);
    // 席順はシャッフルされるので、参加順ではなく手番が回る順（r.order）で並べる。
    // 自分の次に打つ人が先頭。自分が席にいないとき（観戦等）は order の先頭から
    const mySeat = r.order.indexOf(state.playerId);
    const seatOf = (id) => {
      const i = r.order.indexOf(id);
      if (i < 0) return 99;
      return mySeat < 0 ? i : (i - mySeat + r.order.length) % r.order.length;
    };
    const others = r.players.filter((p) => p.id !== state.playerId).sort((a, b) => seatOf(a.id) - seatOf(b.id));

    // 交換フェーズ
    if (r.status === "exchange") {
      const task = r.exchangeNeeded[0];
      const mine = task && (isTest || task.upperId === state.playerId);
      app.innerHTML = `<div class="min-h-screen p-4 flex flex-col">
        <div class="flex justify-between items-center mb-3">
          <span class="flex gap-2 items-center">${menuBtn()}<span class="t-dim text-sm">部屋 ${esc(roomLabel(r))}・カード交換</span></span>
          <span class="flex gap-2 items-center">
            <button onclick="toggleGameRules()" class="btn-sub px-3 py-1 rounded-lg text-xs">ルール</button>${nightBtn()}
          </span></div>
        <div class="panel rounded-xl p-4 mb-3 text-center">
          <p class="t-main text-sm">${mine ? `${esc(act.name)} は下位に返すカードを <b>${task.n}枚</b> 選んでください` : "他のプレイヤーが交換中…"}</p>
        </div>
        ${mine ? `<div class="panel p-3 mt-auto">
          ${handRow(hand)}
          ${state.error ? `<p class="err text-xs mb-2 text-center">${esc(state.error)}</p>` : ""}
          <button onclick="submitExchange()" class="btn-play w-full py-3 rounded-lg font-bold">${state.selected.length}/${task.n} 枚を渡す</button>
        </div>` : ""}${gameRulesOverlay()}${menuOverlay()}</div>`;
      return;
    }

    // 保留アクション（7渡し / 10捨て / Qボンバー）は通常と違う操作なので、
    // 見落とさないようポップアップで出す。
    // ・Qボンバー … 数字を選ぶだけなので中央のモーダル（画面を塞いでよい）
    // ・7渡し/10捨て … 手札から選ぶ必要があるので、手札のすぐ上に浮かせる
    //   （画面を塞ぐモーダルにすると札を選べなくなる）
    let popFloat = "", popModal = "";
    if (r.pending) {
      const pl = r.players.find((p) => p.id === r.pending.playerId);
      const mine = isTest || r.pending.playerId === state.playerId;
      const waiting = `<p class="t-dim text-sm text-center mt-2">${esc(pl.name)} を待っています…</p>`;
      if (r.pending.type === "bomber") {
        popModal = `<div class="overlay overlay-center"><div class="overlay-body">
          <p class="pop-t">Qボンバー</p>
          <p class="pop-d">${esc(pl.name)} が、全員に捨てさせる数字を選びます</p>
          ${mine ? `<div class="flex flex-wrap gap-1 justify-center mt-3">
            ${PICK_RANKS.map((rk) => `<button onclick="submitBomber(${rk})" class="btn-sub px-3 py-2 rounded font-bold" style="min-width:46px">${RANK_LABEL(rk)}</button>`).join("")}
          </div>` : waiting}</div></div>`;
      } else {
        const give = r.pending.type === "give";
        const lbl = give ? "次の人に渡す" : "捨てる";
        popFloat = `<div class="pop-above">
          <p class="pop-t">${give ? "7渡し" : "10捨て"}</p>
          <p class="pop-d">${esc(pl.name)} が手札から ${r.pending.count}枚 を${lbl}</p>
          ${mine ? `<button onclick="submitPending()" class="btn-play w-full mt-2 py-2 rounded-lg font-bold">${state.selected.length}/${r.pending.count} 枚を${lbl}</button>`
            : waiting}</div>`;
      }
    }

    app.innerHTML = `<div class="min-h-screen flex flex-col">
      <div class="topbar">
        <span class="flex gap-2 items-center">${menuBtn()}部屋 ${esc(roomLabel(r))}${isTest ? ' <b class="err">TEST</b>' : ""}</span>
        <span class="flex gap-2 items-center">
          <button onclick="toggleGameRules()" class="btn-sub px-3 py-1 rounded-lg text-sm">ルール</button>
          ${nightBtn()}
        </span>
      </div>
      <div class="status">
        ${r.revolution ? '<span class="chip chip-rev" title="カードの強弱が逆転しています">革命中（強弱が逆）</span>' : ""}
        ${r.tempReverse ? '<span class="chip chip-rev" title="場が流れるまで強弱が逆になります">一時反転（場が流れるまで）</span>' : ""}
        ${r.suitLockActive ? `<span class="chip chip-lock" title="このスートしか出せません">${SUIT_SYMBOL[r.suitLockActive]} のみ（スート縛り）</span>` : ""}
        ${r.numberLockActive != null ? `<span class="chip chip-lock" title="この数字しか出せません">${RANK_LABEL(r.numberLockActive)} のみ（数縛り）</span>` : ""}
        <span class="chip" title="手番が回る向き。9リバース・12リバースで反転します">${
          r.direction === 1 ? "↻ 順回り" : "↺ 逆回り"}</span>
      </div>
      <div class="players">${others.map((p) => `<div class="pcard ${r.order[r.currentTurnIndex] === p.id ? "turn" : ""}">
        <div class="pname">${esc(p.name)}${p.isCPU ? '<span class="tag-cpu">CPU</span>' : ""}${p.isDummy ? '<span class="tag-dummy">手動</span>' : ""}</div>
        <div class="t-dim text-xs">${p.finished ? "あがり" : `残${p.handCount}枚`}</div>
      </div>`).join("")}</div>
      <div class="field ${rev ? "rev" : ""}">${fieldDisplay(r)}</div>
      <div class="logline">${esc(r.log[r.log.length - 1] || "")}</div>
      <div class="turnline ${canAct ? "t-accent" : "t-dim"}">
        ${isTest ? `操作中：${esc(act.name)}${act.isCPU ? "（CPU思考中…）" : ""}` : canAct ? "あなたの番です" : `${esc((r.players.find((p) => p.id === r.order[r.currentTurnIndex]) || {}).name || "")} の番`}
      </div>
      <div class="panel p-3 panel-bottom">
        ${popFloat}
        ${isTest ? `<p class="t-dim text-xs mb-1 text-center">${esc(act.name)} の手札</p>` : ""}
        ${handRow(hand)}
        ${state.error ? `<p class="err text-xs mb-2 text-center">${esc(state.error)}</p>` : ""}
        ${r.pending ? "" : `<div class="flex gap-2">
          <button onclick="submitPass()" ${!canAct || !r.field ? "disabled" : ""} class="btn-pass rounded-lg font-bold" style="flex:4 1 0%">パス</button>
          <button onclick="submitPlay()" ${!canAct ? "disabled" : ""} class="btn-play rounded-lg font-bold" style="flex:6 1 0%">出す</button>
        </div>`}
      </div>${popModal}${gameRulesOverlay()}${menuOverlay()}</div>`;
    return;
  }

  if (state.screen === "finished") {
    const ranked = [...r.players].sort((a, b) => (a.finishOrder || 99) - (b.finishOrder || 99));
    app.innerHTML = `<div class="min-h-screen p-4 flex flex-col items-center justify-center">
      <div class="w-full max-w-sm flex justify-between items-center mb-2">
        <span class="flex gap-2 items-center">${menuBtn()}<span class="t-dim text-sm">部屋 ${esc(roomLabel(r))}</span></span>
        ${nightBtn()}
      </div>
      <h2 class="title mb-4">結果発表</h2>
      <div class="w-full max-w-sm space-y-2 mb-5">
        ${ranked.map((p) => {
          const label = (r.classes && r.classes[p.id]) || "";
          return `<div class="panel flex items-center justify-between rounded-xl px-4 py-3">
            <span class="t-main font-medium text-sm">${esc(p.name)}${p.isCPU ? '<span class="tag-cpu">CPU</span>' : ""}${p.foul ? '<span class="err text-xs ml-1">反則</span>' : ""}</span>
            <span class="flex items-center gap-2">
              ${p.id === r.demotedPlayerId ? '<span class="err text-[10px]">都落ち</span>' : ""}
              <span class="px-3 py-1 rounded-full text-xs font-bold ${badgeColor(label)}">${label}</span></span>
          </div>`;
        }).join("")}
      </div>
      ${isHost ? `<button onclick="rematch()" class="btn-play px-6 py-3 rounded-lg font-bold">もう一度遊ぶ</button>` : `<p class="t-dim text-sm">ホストの操作を待っています…</p>`}
      <button onclick="leaveRoom()" class="btn-sub px-6 py-2 rounded-lg text-sm mt-3">タイトルに戻る</button>
    </div>${menuOverlay()}`;
    return;
  }

  // どの画面にも当てはまらないとき（席が無くなった等）。真っ白のまま操作不能にしない
  app.innerHTML = `<div class="min-h-screen flex flex-col items-center justify-center gap-3">
    ${roomLabel(r) ? `<span class="t-dim text-sm">${r.private ? "身内ルーム" : "部屋コード"}</span>
      <div class="${r.private ? "roomname" : "roomcode"}">${esc(roomLabel(r))}</div>` : ""}
    <span class="t-dim">この部屋の席がありません</span>
    <button onclick="leaveRoom()" class="btn-sub px-6 py-2 rounded-lg text-sm mt-2">タイトルに戻る</button>
  </div>`;
}

document.body.classList.toggle("night", state.night);
render();
