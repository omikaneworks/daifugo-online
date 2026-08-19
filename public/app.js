import { RULE_CATEGORIES, buildDefaultRules, PRESETS } from "./rules.js";

const RANK_LABEL = (r) => ({ 11: "J", 12: "Q", 13: "K", 14: "A", 15: "2", 16: "Joker" }[r] || String(r));
const SUIT_SYMBOL = { S: "♠", H: "♥", D: "♦", C: "♣", JOKER: "★" };
const SUIT_COLOR = { S: "c-black", H: "c-red", D: "c-red", C: "c-black", JOKER: "c-joker" };
const PICK_RANKS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
const strength = (rank, rev) => (rev ? -rank : rank);
const effRev = (r) => !!r.revolution !== !!r.tempReverse;
function sortHand(hand, rev) {
  return [...hand].sort((a, b) => {
    const sa = a.suit === "JOKER" ? 999 : strength(a.rank, rev);
    const sb = b.suit === "JOKER" ? 999 : strength(b.rank, rev);
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
  testMode: false,
};
localStorage.setItem("daifugo-pid", state.playerId);

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
  if (state.ws) state.ws.close();
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/api/room/${code}/ws`);
  ws.onopen = () => ws.send(JSON.stringify(first));
  ws.onmessage = (evt) => {
    const d = JSON.parse(evt.data);
    if (d.type === "state") {
      const prevActor = state.room ? actingId() : null;
      state.room = d.room;
      state.error = "";
      if (!state.draftRules) state.draftRules = JSON.parse(JSON.stringify(d.room.rules));
      if (prevActor !== actingId()) state.selected = [];
      if (d.room.status === "playing" || d.room.status === "exchange") state.screen = "game";
      else if (d.room.status === "finished") state.screen = "finished";
      else state.screen = "lobby";
    } else if (d.type === "error") state.error = d.message;
    render();
  };
  state.ws = ws;
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
W.startGame = () => send({ type: "start", testMode: state.testMode, asPlayerId: null });
W.addCPU = () => send({ type: "addCPU", asPlayerId: null });
W.removeCPU = () => send({ type: "removeCPU", asPlayerId: null });
W.rematch = () => send({ type: "rematch", asPlayerId: null });
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
  const p = PRESETS.find((x) => x.id === id);
  if (!p) return;
  const base = buildDefaultRules();
  state.draftRules = { ...base, ...p.apply, forbidden: { ...base.forbidden, ...(p.apply.forbidden || {}) } };
  send({ type: "setRules", rules: state.draftRules, asPlayerId: null });
};
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
function nightBtn() {
  return `<button onclick="toggleNight()" class="btn-sub px-3 py-1 rounded-lg text-xs">${state.night ? "☀︎" : "☾"}</button>`;
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
function fieldDisplay(f) {
  if (!f) return `<p class="field-empty">場は空です（自由に出せます）</p>`;
  if (f.cards && f.cards.length) return `<div class="flex gap-1 flex-wrap justify-center">${f.cards.map((c) => cardFace(c, false, false, true)).join("")}</div>`;
  return `<div class="flex gap-1">${Array.from({ length: f.count }).map(() => cardFace({ suit: "S", rank: f.rank || 3 }, false, false, true)).join("")}</div>`;
}
function miniHand(hand, rev) {
  return sortHand(hand, rev).map((c) => `<span class="mini ${SUIT_COLOR[c.suit]}">${c.suit === "JOKER" ? "🃏" : SUIT_SYMBOL[c.suit] + RANK_LABEL(c.rank)}</span>`).join("");
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
    return `<label class="rule-row">
      <span class="flex-1"><span class="rule-label">${rule.label}</span>
      ${rule.desc ? `<span class="rule-desc">${rule.desc}</span>` : ""}</span>
      <select ${dis} onchange="setRule('${rule.key}','${g}', this.value === String(Number(this.value)) ? Number(this.value) : this.value)" class="inp text-xs rounded px-2 py-1 ml-2">
        ${rule.options.map((o) => `<option value="${o.v}" ${String(val) === String(o.v) ? "selected" : ""}>${o.l}</option>`).join("")}
      </select></label>`;
  }
  return `<label class="rule-row ${editable ? "cursor-pointer" : ""}">
    <input type="checkbox" ${val ? "checked" : ""} ${dis} onchange="setRule('${rule.key}','${g}', this.checked)" class="rule-check" />
    <span class="flex-1"><span class="rule-label">${rule.label}</span>
    ${rule.desc ? `<span class="rule-desc">${rule.desc}</span>` : ""}</span></label>`;
}
function rulesPanel(editable) {
  const rules = editable ? state.draftRules : state.room.rules;
  return `<div class="panel rounded-xl p-3 mb-3 text-left">
    ${editable ? `<div class="mb-3">
      <p class="t-dim text-xs mb-2">プリセット（まとめて設定）</p>
      <div class="grid grid-cols-2 gap-2">
        ${PRESETS.map((p) => `<button onclick="applyPreset('${p.id}')" class="btn-sub py-2 px-2 rounded-lg text-xs text-left">
          <span class="block font-bold">${p.label}</span><span class="t-dim block text-[10px] leading-tight mt-0.5">${p.desc}</span></button>`).join("")}
      </div></div>` : `<p class="t-dim text-xs mb-2">ホストが設定したルール（閲覧のみ）</p>`}
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
function render() {
  const app = document.getElementById("app");

  if (state.screen === "home") {
    app.innerHTML = `<div class="min-h-screen flex items-center justify-center p-4">
      <div class="w-full max-w-sm panel rounded-2xl p-6">
        <div class="flex justify-end mb-2">${nightBtn()}</div>
        <h1 class="title">大富豪</h1>
        <p class="t-dim text-center text-sm mb-6">友達とオンライン対戦</p>
        <label class="block t-dim text-sm mb-1">名前</label>
        <input id="name-input" value="${esc(state.name)}" placeholder="例）コヤネ" class="inp w-full mb-4 px-3 py-2 rounded-lg" />
        <button onclick="createRoom()" class="btn-play w-full py-3 rounded-lg font-bold mb-3">部屋を作る</button>
        <div class="divider"><span>または</span></div>
        <input id="code-input" placeholder="部屋コード" maxlength="4" class="inp w-full mb-3 px-3 py-2 rounded-lg tracking-widest text-center uppercase" />
        <button onclick="joinRoom()" class="btn-sub w-full py-3 rounded-lg font-bold">部屋に参加する</button>
        ${state.error ? `<p class="err mt-4 text-center">${esc(state.error)}</p>` : ""}
      </div></div>`;
    return;
  }

  const r = state.room;
  if (!r) { app.innerHTML = `<div class="min-h-screen flex items-center justify-center t-dim">接続中…</div>`; return; }
  const isHost = r.hostId === state.playerId;
  const me = r.players.find((p) => p.id === state.playerId);

  if (state.screen === "lobby") {
    app.innerHTML = `<div class="min-h-screen p-4"><div class="max-w-sm mx-auto">
      <div class="flex justify-end mb-2">${nightBtn()}</div>
      <h2 class="t-accent text-center text-sm mb-1">部屋コード</h2>
      <div class="roomcode">${r.code}</div>
      <p class="t-dim text-center text-xs mb-5">友達にこのコードを伝えてください</p>
      <div class="panel rounded-xl p-4 mb-3">
        <p class="t-dim text-sm mb-2">参加者（${r.players.length}/6）</p>
        <ul class="space-y-1">${r.players.map((p) => `<li class="flex items-center gap-2 t-main text-sm">
          <span class="dot ${p.isCPU ? "dot-cpu" : "dot-human"}"></span>${esc(p.name)}
          ${p.isCPU ? '<span class="tag-cpu">CPU</span>' : ""}
          ${p.id === r.hostId ? '<span class="t-accent text-xs">ホスト</span>' : ""}
          ${p.id === state.playerId ? '<span class="t-dim text-xs">あなた</span>' : ""}
          ${r.classes && r.classes[p.id] ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${badgeColor(r.classes[p.id])}">${r.classes[p.id]}</span>` : ""}
        </li>`).join("")}</ul>
      </div>
      ${isHost ? `<div class="flex gap-2 mb-2">
        <button onclick="addCPU()" ${r.players.length >= 6 ? "disabled" : ""} class="btn-sub flex-1 py-2 rounded-lg text-sm font-bold">CPUを追加</button>
        <button onclick="removeCPU()" ${!r.players.some((p) => p.isCPU) ? "disabled" : ""} class="btn-sub flex-1 py-2 rounded-lg text-sm font-bold">CPUを削除</button>
      </div>
      <button onclick="toggleTestMode()" class="btn-sub w-full py-2 mb-2 rounded-lg text-sm flex justify-between px-4">
        <span>テストモード</span><span class="${state.testMode ? "err font-bold" : "t-dim"} text-xs">${state.testMode ? "ON（全員の手札が見える）" : "OFF"}</span></button>` : ""}
      <button onclick="toggleRulesPanel()" class="btn-sub w-full py-2 mb-2 rounded-lg text-sm flex justify-between px-4">
        <span>ルール設定を${state.showRules ? "隠す" : "表示"}</span><span class="t-dim text-xs">${rulesSummary(r.rules)}</span></button>
      ${state.showRules ? rulesPanel(isHost) : ""}
      ${isHost ? `<button onclick="startGame()" ${r.players.length < (state.testMode ? 2 : 3) ? "disabled" : ""} class="btn-play w-full py-3 rounded-lg font-bold">
        ${r.players.length < (state.testMode ? 2 : 3) ? `${state.testMode ? 2 : 3}人以上で開始できます` : state.testMode ? "テストモードで開始" : "ゲーム開始"}</button>`
      : `<p class="t-dim text-center">ホストの開始を待っています…</p>`}
      ${state.error ? `<p class="err mt-3 text-center text-sm">${esc(state.error)}</p>` : ""}
    </div></div>`;
    return;
  }

  if (state.screen === "game" && me) {
    const isTest = !!r.testMode;
    const rev = effRev(r);
    const actId = actingId();
    const act = r.players.find((p) => p.id === actId) || me;
    const canAct = isTest ? !act.isCPU : actId === state.playerId;
    const hand = sortHand((isTest ? act.hand : me.hand) || [], rev);
    const others = r.players.filter((p) => p.id !== state.playerId);

    // 交換フェーズ
    if (r.status === "exchange") {
      const task = r.exchangeNeeded[0];
      const mine = task && (isTest || task.upperId === state.playerId);
      app.innerHTML = `<div class="min-h-screen p-4 flex flex-col">
        <div class="flex justify-between items-center mb-3"><span class="t-dim text-xs">カード交換</span>${nightBtn()}</div>
        <div class="panel rounded-xl p-4 mb-3 text-center">
          <p class="t-main text-sm">${mine ? `${esc(act.name)} は下位に返すカードを <b>${task.n}枚</b> 選んでください` : "他のプレイヤーが交換中…"}</p>
        </div>
        ${mine ? `<div class="panel p-3 mt-auto">
          <div class="hand-row">${hand.map((c) => cardFace(c, state.selected.some((s) => s.id === c.id), true, false)).join("")}</div>
          ${state.error ? `<p class="err text-xs mb-2 text-center">${esc(state.error)}</p>` : ""}
          <button onclick="submitExchange()" class="btn-play w-full py-3 rounded-lg font-bold">${state.selected.length}/${task.n} 枚を渡す</button>
        </div>` : ""}</div>`;
      return;
    }

    // 保留アクション（7渡し / 10捨て / Qボンバー）
    let pendingUI = "";
    if (r.pending) {
      const pl = r.players.find((p) => p.id === r.pending.playerId);
      const mine = isTest || r.pending.playerId === state.playerId;
      if (r.pending.type === "bomber") {
        pendingUI = `<div class="pending">
          <p class="pending-t">${esc(pl.name)}：捨てさせる数字を選んでください（Qボンバー）</p>
          ${mine ? `<div class="flex flex-wrap gap-1 justify-center mt-2">
            ${PICK_RANKS.map((rk) => `<button onclick="submitBomber(${rk})" class="btn-sub px-3 py-2 rounded text-sm font-bold">${RANK_LABEL(rk)}</button>`).join("")}
          </div>` : `<p class="t-dim text-xs text-center mt-1">待っています…</p>`}</div>`;
      } else {
        const lbl = r.pending.type === "give" ? "次の人に渡す" : "捨てる";
        pendingUI = `<div class="pending">
          <p class="pending-t">${esc(pl.name)}：${r.pending.count}枚を${lbl}（${r.pending.type === "give" ? "7渡し" : "10捨て"}）</p>
          ${mine ? `<button onclick="submitPending()" class="btn-play w-full mt-2 py-2 rounded-lg font-bold text-sm">${state.selected.length}/${r.pending.count} 枚を${lbl}</button>`
            : `<p class="t-dim text-xs text-center mt-1">待っています…</p>`}</div>`;
      }
    }

    const dirIcon = r.direction === 1 ? "↻" : "↺";
    app.innerHTML = `<div class="min-h-screen flex flex-col">
      <div class="topbar">
        <span>部屋 ${r.code}${isTest ? ' <b class="err">TEST</b>' : ""}</span>
        <span class="flex gap-2 items-center">
          ${r.revolution ? '<span class="chip chip-rev">革命</span>' : ""}
          ${r.tempReverse ? '<span class="chip chip-rev">反転</span>' : ""}
          ${r.suitLockActive ? `<span class="chip chip-lock">縛${SUIT_SYMBOL[r.suitLockActive]}</span>` : ""}
          ${r.numberLockActive != null ? `<span class="chip chip-lock">数${RANK_LABEL(r.numberLockActive)}</span>` : ""}
          <span class="chip">${dirIcon}</span>${nightBtn()}
        </span>
      </div>
      <div class="players">${others.map((p) => `<div class="pcard ${r.order[r.currentTurnIndex] === p.id ? "turn" : ""}">
        <div class="pname">${esc(p.name)}${p.isCPU ? '<span class="tag-cpu">CPU</span>' : ""}</div>
        <div class="t-dim text-xs">${p.finished ? "あがり" : `残${p.handCount}枚`}</div>
        ${isTest && p.hand ? `<div class="mini-row">${miniHand(p.hand, rev)}</div>` : ""}
      </div>`).join("")}</div>
      <div class="field">${fieldDisplay(r.field)}</div>
      <div class="logline">${esc(r.log[r.log.length - 1] || "")}</div>
      <div class="turnline ${canAct ? "t-accent" : "t-dim"}">
        ${isTest ? `操作中：${esc(act.name)}${act.isCPU ? "（CPU思考中…）" : ""}` : canAct ? "あなたの番です" : `${esc((r.players.find((p) => p.id === r.order[r.currentTurnIndex]) || {}).name || "")} の番`}
      </div>
      <div class="panel p-3">
        ${pendingUI}
        ${isTest ? `<p class="t-dim text-xs mb-1 text-center">${esc(act.name)} の手札</p>` : ""}
        <div class="hand-row">${hand.map((c) => cardFace(c, state.selected.some((s) => s.id === c.id), true, false)).join("")}</div>
        ${state.error ? `<p class="err text-xs mb-2 text-center">${esc(state.error)}</p>` : ""}
        ${r.pending ? "" : `<div class="flex gap-2">
          <button onclick="submitPass()" ${!canAct || !r.field ? "disabled" : ""} class="btn-pass rounded-lg font-bold text-xs" style="flex:1 1 0%">パス</button>
          <button onclick="submitPlay()" ${!canAct ? "disabled" : ""} class="btn-play rounded-lg font-bold" style="flex:9 1 0%">出す</button>
        </div>`}
      </div></div>`;
    return;
  }

  if (state.screen === "finished") {
    const ranked = [...r.players].sort((a, b) => (a.finishOrder || 99) - (b.finishOrder || 99));
    app.innerHTML = `<div class="min-h-screen p-4 flex flex-col items-center justify-center">
      <div class="w-full max-w-sm flex justify-end mb-2">${nightBtn()}</div>
      <h2 class="title mb-5">結果発表</h2>
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
    </div>`;
    return;
  }
}

document.body.classList.toggle("night", state.night);
render();
