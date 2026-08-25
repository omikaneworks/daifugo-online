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

// --- 個人ID ---
// サーバーが発行する8桁の数字。重複しないことはサーバー側が確認してから渡してくれる。
// 先頭が0の番号（"00123456"）も正規のIDなので、必ず文字列のまま扱うこと。
// 端末側で作っていた頃の36文字のUUID（旧キー daifugo-pid）は引き継がない。
// 引き継ぐと、昔から遊んでいる端末にはいつまでも8桁が出てこないため
const ID_KEY = "daifugo-personal-id";
const readPersonalId = () => localStorage.getItem(ID_KEY) || "";
// 見せるときだけ4桁ずつに区切る。コピー・QR・サーバーに送る値は区切り無しのまま
const formatPersonalId = (id) => (/^\d{8}$/.test(id) ? id.slice(0, 4) + " " + id.slice(4) : id);
// 名前は「個人IDに紐づくもの」としてサーバーが持つ。localStorage の daifugo-name は手元の控えで、
// 起動時にサーバーから取り直す。name を渡すと保存もする（部屋の外で改名したとき用）
async function fetchProfileName(id, name) {
  try {
    const r = await fetch("/api/id/profile", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(name ? { id, name } : { id }),
    });
    const d = await r.json();
    if (d.ok && d.name) return String(d.name);
  } catch { /* 通信できなければ手元の控えのまま使う */ }
  return "";
}
// --- 最近の部屋 ---
// この端末が入った部屋の合言葉を覚えておく。作った部屋だけでなく**参加した部屋も**覚える
// （うっかりタイトルに戻ったとき、どの部屋にいたか分からなくなるため）。
// 合言葉だけを持ち、中身はその都度サーバーに尋ねる
const ROOMS_KEY = "daifugo-myrooms";
const ROOMS_MAX = 8;
function loadMyRooms() {
  try { return JSON.parse(localStorage.getItem(ROOMS_KEY)) || []; } catch { return []; }
}
function rememberRoom(code) {
  if (!code) return;
  const list = loadMyRooms().filter((r) => r.code !== code);
  list.unshift({ code, at: Date.now() });
  localStorage.setItem(ROOMS_KEY, JSON.stringify(list.slice(0, ROOMS_MAX)));
}
function forgetRoom(code) {
  localStorage.setItem(ROOMS_KEY, JSON.stringify(loadMyRooms().filter((r) => r.code !== code)));
}
// 覚えている合言葉の今の様子を尋ねる。もう無い部屋は覚えるのをやめる
async function refreshMyRooms() {
  const list = loadMyRooms();
  if (!list.length) { state.myRooms = []; return; }
  const out = [];
  for (const r of list) {
    try {
      const res = await fetch(`/api/room/${encodeURIComponent(r.code)}/status`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ playerId: state.playerId }),
      });
      const d = await res.json();
      if (d.ok && d.exists) out.push({ ...d, code: r.code });
      else forgetRoom(r.code);
    } catch { out.push({ code: r.code, unknown: true }); }
  }
  state.myRooms = out;
  // 入力中は画面を作り直さない（打っている字が消えるため。名前の取得と同じ約束）
  const ae = document.activeElement;
  if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")) return;
  render();
}

async function issuePersonalId() {
  try {
    const r = await fetch("/api/id/issue", { method: "POST" });
    const d = await r.json();
    if (d.ok && d.id) return String(d.id);
  } catch { /* 下のフォールバックへ */ }
  // 発行に失敗してもアプリが始まらない事態にはしない（遊べなくなる方が害が大きい）。
  // この経路で作ったIDだけは一意性が保証されない
  return String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
}
const effRev = (r) => !!r.revolution !== !!r.tempReverse;
// カードの強さ。革命・一時反転のときは大小が逆になる（src/index.js と同じ考え方）
const strength = (rank, rev) => (rev ? -rank : rank);
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
  playerId: readPersonalId(),
  name: localStorage.getItem("daifugo-name") || "",
  night: localStorage.getItem("daifugo-night") === "1",
  screen: "home", room: null, error: "", selected: [], ws: null,
  showRules: false, openCat: null, draftRules: null,
  testMode: false, showGameRules: false, menu: null, code: "",
  // マイページ。null="閉じている"・"show"="IDを見せる面"・"paste"="他の端末に合わせる面"
  idPanel: null, idPasteConfirm: null,
  // 最近の部屋（この端末が入った部屋）。中身はサーバーに尋ねて入れ直す
  myRooms: [], roomBusy: "", closeConfirm: null,
  // 管理画面（プレイヤー台帳・活動ログ・部屋）。プレイヤー向けのどの画面にもリンクしない隠しページ
  adminKey: "", adminData: null, adminTab: "players", adminBusy: false, adminRooms: null,
};

// 開発者モード：URLに ?dev=1 が付いているときだけテスト機能が見える。
// 端末に記憶はしない（通常URLで開けば必ずOFF）。記憶すると、通常URLを開いた
// つもりでも開発者メニューが出続けて紛らわしいため。
const IS_DEV = new URLSearchParams(location.search).get("dev") === "1";
// ローカル開発（wrangler dev）かどうか。管理画面の管理キー入力欄を省くためだけに使う。
// 実際に通すか決めるのはサーバー側（.dev.vars の DAIFUGO_DEV）なので、ここは見た目だけ
const IS_LOCAL = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
// 管理画面の入口。読んだら消す（履歴やスクリーンショットにURLの跡を残さないため）
const ENTRY_ADMIN = new URLSearchParams(location.search).get("admin") === "1";
if (ENTRY_ADMIN) {
  const q = new URLSearchParams(location.search);
  q.delete("admin");
  const rest = q.toString();
  history.replaceState(null, "", location.pathname + (rest ? "?" + rest : ""));
  state.screen = "adminlog";
}
// 使わなくなった値の後始末（開発者モードの記憶方式・身内ルームの合言葉と部屋コード・
// 端末側で作っていた頃の個人ID）
for (const k of ["daifugo-dev", "daifugo-pass", "daifugo-code", "daifugo-pid"]) localStorage.removeItem(k);

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
  if (r.status === "exchange" && r.exchangeNeeded && r.exchangeNeeded[0]) return r.exchangeNeeded[0].playerId;
  if (r.order && r.order.length) return r.order[r.currentTurnIndex];
  return state.playerId;
}
function connect(code, first) {
  // 部屋の状態が来る前でも部屋コードを出せるように控えておく（固まったときの確認用）
  state.code = code;
  // 合言葉は日本語も通すので、経路に乗せるときは必ずエンコードする
  openSocket(`/api/room/${encodeURIComponent(code)}/ws`, first, `部屋 ${code} に接続できませんでした`, "home");
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
      // 入り直した1回目は、部屋に残っている過去の効果を再生しない（番号だけ控える）
      const firstState = !state.room;
      state.room = d.room;
      showFlash(d.room.flash, firstState);
      // 入った部屋は覚えておく（作った部屋も参加した部屋も）。うっかり抜けても戻れるように
      rememberRoom(d.room.code);
      state.error = "";
      if (!state.draftRules) state.draftRules = JSON.parse(JSON.stringify(d.room.rules));
      if (prevActor !== actingId()) state.selected = [];
      if (d.room.status === "playing" || d.room.status === "exchange") state.screen = "game";
      else if (d.room.status === "finished") state.screen = "finished";
      else state.screen = "lobby";
    } else if (d.type === "disbanded") { resetToTitle("部屋が解散されました"); return; }
    else if (d.type === "error") {
      state.error = d.message;
      // 部屋に入れないまま返ってきたエラー（合言葉が使用中・部屋が無い・満員・開始済み）。
      // サーバーは接続を閉じないので、放っておくと「接続中…」の画面に留まって理由が伝わらない。
      // onclose と同じくスタート画面へ戻す（メッセージ自体が「別の言葉にするか、参加するを
      // 試して」＝スタート画面での行動を促している）
      if (!state.room) {
        // 先に参照を外す。そうしないと下の onclose が failMsg で理由を上書きしてしまう
        state.ws = null;
        try { ws.close(); } catch { /* 既に閉じていれば何もしない */ }
        state.screen = "home";
      }
    }
    render();
  };
  state.ws = ws;
}

// ---------- 場の効果を大きく出す（8切り・革命など） ----------
// ログの小さい1行だけだと見落とすので、画面いっぱいにドンと出す。
// **描画は paint() を通さず、#app の外の要素を直接いじる。** paint() は画面のHTMLを
// 作り直すので、中に入れると再生中のアニメーションが途切れる
let flashSeen = 0;      // ここまで見せた効果の番号
let flashTimer = null;
function showFlash(flash, skip) {
  if (!flash || flash.id === flashSeen) return;
  flashSeen = flash.id;
  if (skip) return;                       // 入り直した1回目は番号を合わせるだけ
  const el = document.getElementById("flash");
  if (!el) return;
  const kind = (flash.items[0] && flash.items[0].kind) || "cut";
  el.innerHTML = flash.items.map((it) => `<span class="fx-line">${esc(it.label)}</span>`).join("")
    + (flash.by ? `<span class="fx-by">${esc(flash.by)}</span>` : "");
  // 一度クラスを外して実寸を読み、アニメーションを頭から再生させる
  // （付けっぱなしだと、続けて効果が出たとき2回目が動かない）
  el.className = "";
  void el.offsetWidth;
  el.className = "flash-on fx-" + kind;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.className = ""; el.innerHTML = ""; }, 1300);
}

// 部屋との接続を切ってスタート画面へ。詰まったときの共通の脱出口
function resetToTitle(message) {
  if (state.ws) { try { state.ws.close(); } catch { /* 切れていれば何もしない */ } }
  // 出しかけの効果を消す（部屋を出たのにスタート画面で「8切り！」が残らないように）
  flashSeen = 0;
  clearTimeout(flashTimer);
  const fl = document.getElementById("flash");
  if (fl) { fl.className = ""; fl.innerHTML = ""; }
  Object.assign(state, {
    ws: null, room: null, code: "", draftRules: null, selected: [], menu: null,
    showRules: false, openCat: null, testMode: false, showGameRules: false,
    idPanel: null, idPasteConfirm: null,
    error: message || "", screen: "home", closeConfirm: null, roomBusy: "",
  });
  render();
  // スタート画面に戻ったら「最近の部屋」を取り直す（さっきまでいた部屋がここに出る）
  refreshMyRooms();
}

// ---------- 操作 ----------
const W = window;
W.createRoom = () => {
  state.name = document.getElementById("name-input").value.trim();
  const code = (document.getElementById("new-code-input").value || "").trim().toUpperCase();
  if (!state.name) { state.error = "名前を入力してください"; return render(); }
  if (code.length < 2 || code.length > 16) { state.error = "合言葉は2〜16文字で入力してください"; return render(); }
  localStorage.setItem("daifugo-name", state.name);
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
W.resetToTitleBtn = () => resetToTitle();

// ---------- 最近の部屋（入り直す／片付ける） ----------
W.enterMyRoom = (code) => {
  state.name = (document.getElementById("name-input") || {}).value || state.name;
  if (!state.name) { state.error = "名前を入力してください"; return render(); }
  localStorage.setItem("daifugo-name", state.name);
  connect(code, { type: "join", playerId: state.playerId, name: state.name });
};
W.askCloseRoom = (code) => { state.closeConfirm = code; state.error = ""; render(); };
W.cancelCloseRoom = () => { state.closeConfirm = null; render(); };
W.closeMyRoom = () => {
  const code = state.closeConfirm;
  state.closeConfirm = null;
  state.roomBusy = code;
  state.error = "";
  render();
  fetch(`/api/room/${encodeURIComponent(code)}/close`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ playerId: state.playerId }),
  })
    .then((r) => r.json())
    .then((d) => {
      state.roomBusy = "";
      if (!d.ok) { state.error = d.error || "消せませんでした"; return render(); }
      forgetRoom(code);
      state.error = `部屋「${code}」を消しました`;
      refreshMyRooms();
      render();
    })
    .catch(() => { state.roomBusy = ""; state.error = "つながりませんでした"; render(); });
};
W.forgetMyRoom = (code) => { forgetRoom(code); refreshMyRooms(); render(); };

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

// ---------- マイページ（名前の変更／個人IDを他の端末と合わせる） ----------
// 個人IDは「本人確認」ではなく「今回はこの人として扱う」というラベルでしかないので、
// 値をそのままコピーして別の端末に上書きすれば、それだけで同じ人として扱われる
W.openIdPanel = () => { state.menu = null; state.idPanel = "show"; state.idPasteConfirm = null; render(); };
W.closeIdPanel = (e) => { if (!e || e.target.classList.contains("overlay")) { state.idPanel = null; render(); } };
W.showIdPasteMode = () => { state.idPanel = "paste"; render(); };
W.showIdShowMode = () => { state.idPanel = "show"; render(); };
W.copyMyId = () => {
  navigator.clipboard.writeText(state.playerId).then(
    () => { state.error = "IDをコピーしました"; render(); },
    () => { state.error = "コピーできませんでした。長押しで選択してください"; render(); });
};
W.confirmIdPaste = () => {
  const el = document.getElementById("id-paste-input");
  // 画面は「1234 5678」と区切って見せているので、空白ごと打ち込まれる前提で取り除く
  const v = ((el ? el.value : "") || "").replace(/\s/g, "");
  // ここは秘密情報ではないので厳密な検証は要らない。8桁の数字かどうかだけ見る
  if (!/^\d{8}$/.test(v)) { state.error = "個人IDは8桁の数字です"; return render(); }
  if (v === state.playerId) { state.error = "もう同じIDです"; return render(); }
  state.idPasteConfirm = v;
  render();
};
W.cancelIdPasteConfirm = () => { state.idPasteConfirm = null; render(); };
W.applyIdPaste = () => {
  localStorage.setItem(ID_KEY, state.idPasteConfirm);
  // 別人のIDに切り替える以上、前の名前は持ち越さない。
  // 消しておけば、開き直したときにサーバーからそのIDの名前が入る
  localStorage.removeItem("daifugo-name");
  location.reload();
};

// 名前を変える。どちらの経路でもサーバー側の「今の名前」が更新される
//   部屋にいる  … rename を送る（その場で全員の画面に反映され、台帳も更新される）
//   部屋にいない … /api/id/profile に保存する（これが無いと他の端末に伝わらない）
W.confirmRename = () => {
  const el = document.getElementById("rename-input");
  const v = ((el ? el.value : "") || "").trim();
  if (!v) { state.error = "名前を入力してください"; return render(); }
  if (v === state.name) { state.error = "もう同じ名前です"; return render(); }
  state.name = v;
  localStorage.setItem("daifugo-name", v);
  if (state.ws) send({ type: "rename", name: v, asPlayerId: null });
  else fetchProfileName(state.playerId, v);
  state.error = `名前を「${v}」に変更しました`;
  render();
};

// ---------- 管理画面（プレイヤー台帳・活動ログ） ----------
// プレイヤー向けのどの画面にもリンクしない隠しページ。?admin=1 でだけ入れる
W.adminLogin = () => {
  const el = document.getElementById("admin-key-input");
  state.adminKey = el ? el.value : "";
  state.adminBusy = true;
  state.error = "";
  render();
  fetch("/api/admin/log", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: state.adminKey }),
  })
    .then((r) => r.json())
    .then((d) => {
      state.adminBusy = false;
      if (!d.ok) { state.error = d.error || "失敗しました"; state.adminData = null; return render(); }
      state.adminData = d;
      state.error = "";
      render();
    })
    .catch(() => {
      state.adminBusy = false;
      state.error = "つながりませんでした";
      render();
    });
};
W.adminSetTab = (tab) => {
  state.adminTab = tab;
  render();
  // 部屋一覧は開いたときに取りに行く（生きているかを1部屋ずつ確かめるので、毎回は重い）
  if (tab === "rooms") W.adminLoadRooms();
};
W.adminLoadRooms = () => {
  state.adminRooms = "loading";
  render();
  fetch("/api/admin/rooms", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: state.adminKey }),
  })
    .then((r) => r.json())
    .then((d) => { state.adminRooms = d.ok ? d : null; if (!d.ok) state.error = d.error || "失敗しました"; render(); })
    .catch(() => { state.adminRooms = null; state.error = "つながりませんでした"; render(); });
};
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
const roomLabel = (r) => (r && r.code) || "";
function nightBtn() {
  return `<button onclick="toggleNight()" class="btn-sub px-3 py-1 rounded-lg text-sm">${state.night ? "☀︎" : "☾"}</button>`;
}
// tone は "on"（いま出せる＝目立たせる）／"off"（いまは出せない＝薄いグレー）／""（区別なし）
function cardFace(card, selected, clickable, small, tone) {
  const isJoker = card.suit === "JOKER";
  const cls = `card ${small ? "small" : ""} ${isJoker ? "card-joker" : ""} ${selected ? "card-sel" : "card-normal"} ${clickable ? "clickable" : ""} ${tone ? "card-" + tone : ""}`;
  const oc = clickable ? `onclick="toggleSelect('${encodeURIComponent(JSON.stringify(card))}')"` : "";
  if (isJoker) {
    return `<button ${oc} class="${cls}"><span class="jk-face">🃏</span><span class="jk-txt">JOKER</span></button>`;
  }
  return `<button ${oc} class="${cls}">
    <span class="cd-rank ${SUIT_COLOR[card.suit]}">${RANK_LABEL(card.rank)}</span>
    <span class="cd-suit ${SUIT_COLOR[card.suit]}">${SUIT_SYMBOL[card.suit]}</span></button>`;
}
// 手札は何枚でも必ず1行。カードを重ねて幅に収める（CSSの .hand-row 参照）。
// off に入れたIDは「いまは選べない札」。薄いグレーにして押せなくする。
// **1枚も off が無いときは何の色分けもしない** —— 全部出せる場面で全部を光らせても
// ただの飾りになるので、差があるときだけ出せる札を目立たせる
function handRow(hand, off) {
  const dim = !!(off && off.size);
  return `<div class="hand-row">${hand.map((c) => {
    const sel = state.selected.some((s) => s.id === c.id);
    const no = !sel && dim && off.has(c.id);
    return cardFace(c, sel, !no, false, no ? "off" : dim && !sel ? "on" : "");
  }).join("")}</div>`;
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
      ${isHost ? `<button onclick="toggleMenu('disband')" class="btn-sub menu-item">部屋を解散する</button>` : ""}
      <button onclick="leaveRoom()" class="btn-sub menu-item">タイトルに戻る</button>
      <button onclick="openIdPanel()" class="btn-sub menu-item">マイページ</button>
    </div>
    <p class="dev-note">「タイトルに戻る」は自分だけが抜けます。同じ端末なら、同じ部屋コードで入り直せば席に戻れます。
    ${isHost ? "" : "「中断」はホストだけが操作できます。"}</p>
  </div></div>`;
}
// パソコンとスマホを同じ人として使いたいときだけ使うパネル。普段は開く必要が無い
function idOverlay() {
  if (!state.idPanel) return "";
  if (state.idPasteConfirm) {
    return `<div class="overlay overlay-center"><div class="overlay-body">
      <p class="pop-t">この端末をこのIDに合わせますか？</p>
      <p class="id-text my-3">${esc(formatPersonalId(state.idPasteConfirm))}</p>
      <p class="pop-d">今までこの端末で遊んだ記録は、別のIDのまま残ります。
      以後この端末は、このIDの人として扱われます。</p>
      <div class="flex gap-2 mt-4">
        <button onclick="cancelIdPasteConfirm()" class="btn-sub rounded-lg py-3 font-bold" style="flex:1">やめる</button>
        <button onclick="applyIdPaste()" class="btn-play rounded-lg py-3 font-bold" style="flex:1">合わせる</button>
      </div>
    </div></div>`;
  }
  const showMode = state.idPanel === "show";
  return `<div class="overlay overlay-center" onclick="closeIdPanel(event)"><div class="overlay-body">
    <div class="overlay-head"><span>マイページ</span>
      <button onclick="closeIdPanel()" class="btn-sub px-3 py-1 rounded-lg text-sm">閉じる</button></div>

    <label class="block t-dim text-sm mb-1">名前</label>
    <div class="flex gap-2 mb-1">
      <input id="rename-input" value="${esc(state.name)}" placeholder="あなたの名前"
        maxlength="20" class="inp flex-1 px-3 py-2 rounded-lg" />
      <button onclick="confirmRename()" class="btn-play px-4 rounded-lg font-bold text-sm">変更</button>
    </div>

    <label class="block t-dim text-sm mb-1 mt-4">個人ID</label>
    <p class="t-dim text-xs mb-3">パソコンとスマホを同じ人として使うための番号です。</p>
    <div class="flex gap-2 mb-3">
      <button onclick="showIdShowMode()" class="btn-sub flex-1 py-2 rounded-lg text-sm ${showMode ? "font-bold" : ""}">このIDを見せる</button>
      <button onclick="showIdPasteMode()" class="btn-sub flex-1 py-2 rounded-lg text-sm ${!showMode ? "font-bold" : ""}">他の端末に合わせる</button>
    </div>
    ${showMode ? `
      <p class="t-dim text-xs text-center mb-2">別の端末で「他の端末に合わせる」に入力してください</p>
      <p class="id-text id-big">${esc(formatPersonalId(state.playerId))}</p>
      <button onclick="copyMyId()" class="btn-sub w-full py-2 mt-3 rounded-lg text-sm">IDをコピー</button>
    ` : `
      <p class="t-dim text-xs text-center mb-2">もう一方の端末に出ている番号を入力してください</p>
      <input id="id-paste-input" placeholder="例：1234 5678" autocomplete="off" spellcheck="false"
        inputmode="numeric" class="inp w-full mb-2 px-3 py-2 rounded-lg text-center id-text" />
      <button onclick="confirmIdPaste()" class="btn-play w-full py-3 rounded-lg font-bold">このIDに合わせる</button>
    `}
    ${state.error ? `<p class="err mt-3 text-center text-sm">${esc(state.error)}</p>` : ""}
  </div></div>`;
}
// スタート画面に出す「最近の部屋」。この端末が入った部屋のうち、まだ生きているものだけ並ぶ。
// 作った部屋を片付けるためと、うっかり抜けたときに戻るための両方に使う
const ROOM_STATE_LABEL = { waiting: "待機中", playing: "対戦中", exchange: "カード交換中", finished: "結果表示中" };
function myRoomsBox() {
  if (state.closeConfirm) {
    return `<div class="myrooms">
      <p class="t-main text-sm text-center mb-1">部屋「${esc(state.closeConfirm)}」を消しますか？</p>
      <p class="t-dim text-[11px] text-center mb-2">中にいる人はスタート画面に戻ります。元には戻せません。</p>
      <div class="flex gap-2">
        <button onclick="cancelCloseRoom()" class="btn-sub flex-1 py-2 rounded-lg text-sm">やめる</button>
        <button onclick="closeMyRoom()" class="btn-play flex-1 py-2 rounded-lg text-sm font-bold">消す</button>
      </div></div>`;
  }
  if (!state.myRooms.length) return "";
  return `<div class="myrooms">
    <p class="t-dim text-xs mb-2">最近の部屋</p>
    ${state.myRooms.map((r) => {
      const busy = state.roomBusy === r.code;
      const label = r.unknown ? "様子が分かりません"
        : `${ROOM_STATE_LABEL[r.status] || r.status} ・ ${r.humans}人${r.connected === 0 ? "（誰もいません）" : ""}`;
      return `<div class="myroom">
        <div class="myroom-main">
          <span class="myroom-code">${esc(r.code)}</span>
          <span class="myroom-state">${esc(label)}${r.mine ? " ・自分が作った部屋" : ""}</span>
        </div>
        <button onclick="enterMyRoom('${esc(r.code)}')" ${busy ? "disabled" : ""} class="btn-sub myroom-btn">入る</button>
        ${r.canClose
          ? `<button onclick="askCloseRoom('${esc(r.code)}')" ${busy ? "disabled" : ""} class="btn-sub myroom-btn myroom-del">${busy ? "…" : "消す"}</button>`
          : `<button onclick="forgetMyRoom('${esc(r.code)}')" class="btn-sub myroom-btn" title="一覧から外すだけで、部屋は消えません">×</button>`}
      </div>`;
    }).join("")}
  </div>`;
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

  // 初めて遊ぶ端末が個人IDをもらってくる間だけ出る。2回目以降は通信しないので出ない
  if (state.screen === "issuing") {
    app.innerHTML = `<div class="min-h-screen flex flex-col items-center justify-center gap-3">
      <h1 class="title">大富豪</h1>
      <span class="t-dim text-sm">はじめての準備をしています…</span>
    </div>`;
    return;
  }

  if (state.screen === "home") {
    app.innerHTML = `<div class="min-h-screen flex items-center justify-center p-4">
      <div class="w-full max-w-sm panel rounded-2xl p-6">
        <div class="flex justify-end mb-2">${nightBtn()}</div>
        <h1 class="title">大富豪</h1>
        <p class="t-dim text-center text-sm mb-6">友達とオンライン対戦</p>
        <label class="block t-dim text-sm mb-1">名前</label>
        <input id="name-input" value="${esc(state.name)}" placeholder="あなたの名前を入力" class="inp w-full mb-4 px-3 py-2 rounded-lg" />
        <label class="block t-dim text-sm mb-1">合言葉（自分で決める）</label>
        <input id="new-code-input" placeholder="例：やまだけ2026" maxlength="16" class="inp w-full mb-3 px-3 py-2 rounded-lg tracking-widest text-center uppercase" />
        <button onclick="createRoom()" class="btn-play w-full py-3 rounded-lg font-bold mb-3">部屋を作る</button>
        <div class="divider"><span>または</span></div>
        <input id="code-input" placeholder="部屋コード" maxlength="16" class="inp w-full mb-3 px-3 py-2 rounded-lg tracking-widest text-center uppercase" />
        <button onclick="joinRoom()" class="btn-sub w-full py-3 rounded-lg font-bold">部屋に参加する</button>
        ${myRoomsBox()}
        ${IS_DEV ? `<div class="devbox mt-4">
          <p class="dev-t">開発者メニュー</p>
          <button onclick="devEnter()" class="btn-sub w-full py-2 rounded-lg font-bold text-sm">開発部屋に入る</button>
          <p class="dev-note">部屋コードなしで固定の部屋「${DEV_CODE}」に直行します。
          無ければその場で作られ、すでにあれば参加します。名前が空なら「開発者」になります。</p>
        </div>` : ""}
        ${state.error ? `<p class="err mt-4 text-center">${esc(state.error)}</p>` : ""}
        <button onclick="openIdPanel()" class="id-link">マイページ</button>
      </div></div>${idOverlay()}`;
    return;
  }

  if (state.screen === "adminlog") {
    if (!state.adminData) {
      app.innerHTML = `<div class="min-h-screen flex items-center justify-center p-4">
        <div class="w-full max-w-sm panel rounded-2xl p-6">
          <h1 class="title">管理</h1>
          <p class="t-dim text-center text-sm mb-5">プレイヤー台帳・活動ログ</p>
          ${IS_LOCAL ? `<p class="t-dim text-center text-xs mb-3">ローカル開発中のため管理キーは要りません</p>` : `<input id="admin-key-input" type="password" autocomplete="off" placeholder="管理キー"
            onkeydown="if(event.key==='Enter')adminLogin()" class="inp w-full mb-3 px-3 py-2 rounded-lg text-center" />`}
          <button onclick="adminLogin()" ${state.adminBusy ? "disabled" : ""}
            class="btn-play w-full py-3 rounded-lg font-bold">${state.adminBusy ? "確認中…" : "開く"}</button>
          ${state.error ? `<p class="err mt-4 text-center">${esc(state.error)}</p>` : ""}
        </div></div>`;
      return;
    }
    const d = state.adminData;
    const players = Object.entries(d.players || {}).sort((a, b) => b[1].lastSeenAt - a[1].lastSeenAt);
    const fmt = (ts) => new Date(ts).toLocaleString("ja-JP");
    app.innerHTML = `<div class="min-h-screen p-4"><div class="max-w-2xl mx-auto">
      <div class="admin-head">
        <h2 class="t-accent text-lg font-bold">管理</h2>
        <span class="flex gap-2">${nightBtn()}
          <button onclick="location.reload()" class="btn-sub px-3 py-1 rounded-lg text-sm">閉じる</button></span>
      </div>
      <p class="t-dim text-xs mb-3">個人IDはサーバーが発行するので、番号が重複することはありません。
      ただしIDは端末のブラウザに保存されているだけなので、データを消す・別のブラウザを使うなどすると
      新しいIDになります（その場合は別人として記録されます）。マイページでIDを合わせた端末は同じ1件にまとまります。</p>
      <div class="flex gap-2 mb-3">
        <button onclick="adminSetTab('players')" class="btn-sub flex-1 py-2 rounded-lg text-sm ${state.adminTab === "players" ? "font-bold" : ""}">プレイヤー台帳</button>
        <button onclick="adminSetTab('events')" class="btn-sub flex-1 py-2 rounded-lg text-sm ${state.adminTab === "events" ? "font-bold" : ""}">最近の出来事</button>
        <button onclick="adminSetTab('rooms')" class="btn-sub flex-1 py-2 rounded-lg text-sm ${state.adminTab === "rooms" ? "font-bold" : ""}">部屋</button>
      </div>
      ${state.adminTab === "rooms" ? `
        <div class="panel rounded-xl p-3 admin-table-wrap">
          ${state.adminRooms === "loading" ? `<p class="t-dim text-center py-3">1部屋ずつ生きているか確かめています…</p>`
            : !state.adminRooms ? `<p class="t-dim text-center py-3">読み込めませんでした
              <button onclick="adminLoadRooms()" class="btn-sub px-3 py-1 rounded-lg text-sm ml-2">やり直す</button></p>`
            : `<div class="admin-head">
                 <span class="t-dim text-xs">いま生きている部屋だけを出しています${
                   state.adminRooms.removed ? `（もう無い${state.adminRooms.removed}件は一覧から外しました）` : ""}</span>
                 <button onclick="adminLoadRooms()" class="btn-sub px-3 py-1 rounded-lg text-sm">更新</button>
               </div>
               <table class="admin-table"><thead><tr>
                 <th>部屋コード</th><th>作った人</th><th>作成</th><th>状態</th><th>人数</th><th>接続中</th>
               </tr></thead><tbody>
                 ${state.adminRooms.rooms.length ? state.adminRooms.rooms.map((r) => `<tr>
                   <td>${esc(r.code)}</td>
                   <td>${esc(r.by || "—")}</td>
                   <td>${r.createdAt ? fmt(r.createdAt) : "—"}</td>
                   <td>${esc(ROOM_STATE_LABEL[r.status] || r.status || "—")}</td>
                   <td>${r.humans == null ? "—" : r.humans}</td>
                   <td>${r.connected == null ? "—" : r.connected}</td>
                 </tr>`).join("") : `<tr><td colspan="6" class="t-dim text-center py-3">いま生きている部屋はありません</td></tr>`}
               </tbody></table>`}
        </div>
      ` : state.adminTab === "players" ? `
        <div class="panel rounded-xl p-3 admin-table-wrap">
          <table class="admin-table"><thead><tr>
            <th>個人ID</th><th>今の名前</th><th>初回</th><th>最終</th><th>使った名前</th><th>作成/参加</th>
          </tr></thead><tbody>
            ${players.length ? players.map(([pid, p]) => `<tr>
              <td class="id-text-sm">${esc(pid.slice(0, 8))}</td>
              <td>${esc(p.name || "—")}</td>
              <td>${fmt(p.firstSeenAt)}</td>
              <td>${fmt(p.lastSeenAt)}</td>
              <td>${(p.names || []).map(esc).join("、")}</td>
              <td>${p.createCount || 0} / ${p.joinCount || 0}</td>
            </tr>`).join("") : `<tr><td colspan="6" class="t-dim text-center py-3">まだ記録がありません</td></tr>`}
          </tbody></table>
        </div>
      ` : `
        <div class="panel rounded-xl p-3 admin-table-wrap">
          <table class="admin-table"><thead><tr>
            <th>時刻</th><th>操作</th><th>名前</th><th>部屋コード</th><th>個人ID</th>
          </tr></thead><tbody>
            ${d.events && d.events.length ? d.events.map((e) => `<tr>
              <td>${fmt(e.ts)}</td>
              <td>${{ create: "作成", join: "参加", rename: "改名" }[e.kind] || esc(e.kind || "")}</td>
              <td>${esc(e.name)}</td>
              <td>${esc(e.code)}</td>
              <td class="id-text-sm">${esc((e.playerId || "").slice(0, 8))}</td>
            </tr>`).join("") : `<tr><td colspan="5" class="t-dim text-center py-3">まだ記録がありません</td></tr>`}
          </tbody></table>
        </div>
      `}
    </div></div>`;
    return;
  }

  const r = state.room;
  // 接続待ちのまま返事が来ないこともあるので、ここにも部屋コードと脱出口を置く
  if (!r) {
    app.innerHTML = `<div class="min-h-screen flex flex-col items-center justify-center gap-3">
      ${state.code ? `<span class="t-dim text-sm">部屋コード</span><div class="roomcode">${esc(state.code)}</div>` : ""}
      ${state.error
        ? `<p class="err text-center">${esc(state.error)}</p>`
        : `<span class="t-dim">接続中…</span>`}
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
      <h2 class="t-accent text-center text-sm mb-1">部屋コード</h2>
      <div class="roomcode">${r.code}</div>
      <p class="t-dim text-center text-xs mb-5">友達にこのコードを伝えてください</p>
      <div class="panel rounded-xl p-4 mb-3">
        <p class="t-dim text-sm mb-2">参加者（${r.players.length}/6）</p>
        <ul class="space-y-1">${r.players.map((p) => `<li class="flex items-center gap-2 t-main text-sm">
          <span class="dot ${p.isCPU ? "dot-cpu" : p.isDummy ? "dot-dummy" : "dot-human"}"></span>${esc(p.name)}
          ${p.isCPU ? '<span class="tag-cpu">CPU</span>' : ""}
          ${p.isDummy ? '<span class="tag-dummy">手動</span>' : ""}
          ${p.id === r.hostId ? '<span class="t-accent text-xs">ホスト</span>' : ""}
          ${p.id === state.playerId ? '<span class="t-dim text-xs">あなた</span>' : ""}
          ${r.classes && r.classes[p.id] ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${badgeColor(r.classes[p.id])}">${r.classes[p.id]}</span>` : ""}
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
    </div>${menuOverlay()}${idOverlay()}</div>`;
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

    // 交換フェーズ。差し出す側（下位）→ 返す側（上位）の順に1人ずつ操作する。
    // 下位も自分の手札を見て自分で選ぶ（何を取られたか分からないまま進まないように）
    if (r.status === "exchange") {
      const task = r.exchangeNeeded[0];
      const mine = !!task && (isTest || task.playerId === state.playerId);
      const give = !!task && task.role === "give";
      const to = (task && r.players.find((p) => p.id === task.toId)) || {};
      const label = give ? "渡す" : "返す";
      // 選べない札を伏せる。
      //  ・差し出す側 … 「一番強いところから n 枚」しか渡せない。同じ強さの札が
      //    並んでいるときだけ、どれを渡すか選べる（2が3枚あるとき等）。
      //    残り枠が「必ず渡さないといけない札の数」と同じになったら、そこだけに絞る
      //  ・返す側 … 何を返してもよい。必要な枚数を選び終えたらそれ以上は選べない
      const off = new Set();
      if (mine && task) {
        const st = (c) => (c.suit === "JOKER" ? 999 : strength(c.rank, rev));
        const picked = (c) => state.selected.some((s) => s.id === c.id);
        if (give) {
          const desc = [...hand].sort((a, b) => st(b) - st(a));
          const border = st(desc[Math.min(task.n, desc.length) - 1]);
          const slots = task.n - state.selected.length;
          const forcedLeft = hand.filter((c) => st(c) > border && !picked(c)).length;
          for (const c of hand) {
            if (picked(c)) continue;
            if (slots <= 0) { off.add(c.id); continue; }
            if (st(c) < border) off.add(c.id);
            // 残り枠が「必ず渡す札」の数に並んだら、同じ強さの札からはもう選べない
            else if (st(c) === border && slots <= forcedLeft) off.add(c.id);
          }
        } else if (state.selected.length >= task.n) {
          for (const c of hand) if (!picked(c)) off.add(c.id);
        }
      }
      const ready = mine && state.selected.length === task.n;
      app.innerHTML = `<div class="min-h-screen p-4 flex flex-col">
        <div class="flex justify-between items-center mb-3">
          <span class="flex gap-2 items-center">${menuBtn()}<span class="t-dim text-sm">部屋 ${esc(roomLabel(r))}・カード交換</span></span>
          <span class="flex gap-2 items-center">
            <button onclick="toggleGameRules()" class="btn-sub px-3 py-1 rounded-lg text-xs">ルール</button>${nightBtn()}
          </span></div>
        <div class="panel rounded-xl p-4 mb-3 text-center">
          ${!task ? `<p class="t-main text-sm">交換の準備中…</p>` : mine ? `
            <p class="t-main text-sm">${esc(act.name)} は ${esc(to.name || "相手")} に <b>${task.n}枚</b> ${label}</p>
            <p class="t-dim text-xs mt-1">${give
              ? "一番強いカードを渡します。同じ強さのカードが複数あるときは、どれを渡すか選べます"
              : "手札から好きなカードを選べます"}</p>`
            : `<p class="t-main text-sm">${esc((r.players.find((p) => p.id === task.playerId) || {}).name || "")} が交換中…</p>`}
        </div>
        ${mine ? `<div class="panel p-3 mt-auto">
          ${handRow(hand, off)}
          ${state.error ? `<p class="err text-xs mb-2 text-center">${esc(state.error)}</p>` : ""}
          <button onclick="submitExchange()" ${ready ? "" : "disabled"} class="btn-play w-full py-3 rounded-lg font-bold">${state.selected.length}/${task.n} 枚を${label}</button>
        </div>` : ""}${gameRulesOverlay()}${menuOverlay()}${idOverlay()}</div>`;
      return;
    }

    // いま選べる札を割り出す。r.moves はサーバーが並べた「いま出せる組み合わせ」
    // （カードidの配列の配列）で、手番の人にだけ届く。
    // **届いていなければ何も伏せない** —— 出せるはずの札を伏せて詰ませる方が害が大きい
    const selIds = state.selected.map((c) => c.id);
    const offIds = new Set();
    let canSubmit = state.selected.length > 0;
    let noMove = false;
    if (r.pending) {
      // 7渡し／10捨ては枚数だけが決まり。必要な枚数を選び終えたら、それ以上は選べない
      if (r.pending.type !== "bomber" && state.selected.length >= r.pending.count) {
        for (const c of hand) if (!selIds.includes(c.id)) offIds.add(c.id);
      }
    } else if (canAct && Array.isArray(r.moves)) {
      // いま選んでいる札を含んだまま完成できる手だけを見る。
      // そこに出てこない札は、これ以上足しても形にならないので伏せる
      const fits = r.moves.filter((m) => selIds.every((id) => m.includes(id)));
      const addable = new Set();
      for (const m of fits) for (const id of m) addable.add(id);
      for (const c of hand) if (!addable.has(c.id)) offIds.add(c.id);
      canSubmit = selIds.length > 0 && fits.some((m) => m.length === selIds.length);
      noMove = r.moves.length === 0;
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
          ${mine ? `<button onclick="submitPending()" ${state.selected.length === r.pending.count ? "" : "disabled"} class="btn-play w-full mt-2 py-2 rounded-lg font-bold">${state.selected.length}/${r.pending.count} 枚を${lbl}</button>`
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
        ${handRow(hand, offIds)}
        ${noMove ? `<p class="t-dim text-xs mb-2 text-center">出せるカードがありません。パスしてください</p>` : ""}
        ${state.error ? `<p class="err text-xs mb-2 text-center">${esc(state.error)}</p>` : ""}
        ${r.pending ? "" : `<div class="flex gap-2">
          <button onclick="submitPass()" ${!canAct || !r.field ? "disabled" : ""} class="btn-pass rounded-lg font-bold" style="flex:4 1 0%">パス</button>
          <button onclick="submitPlay()" ${!canAct || !canSubmit ? "disabled" : ""} class="btn-play rounded-lg font-bold" style="flex:6 1 0%">出す</button>
        </div>`}
      </div>${popModal}${gameRulesOverlay()}${menuOverlay()}${idOverlay()}</div>`;
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
      <div class="w-full max-w-sm flex gap-2 mt-3">
        <button onclick="leaveRoom()" class="btn-sub flex-1 py-2 rounded-lg text-sm">タイトルに戻る</button>
        ${isHost ? `<button onclick="toggleMenu('disband')" class="btn-sub err flex-1 py-2 rounded-lg text-sm">部屋を解散する</button>` : ""}
      </div>
      ${isHost ? `<p class="t-dim text-[11px] mt-2 text-center">「タイトルに戻る」は自分だけが抜けます。部屋は残るので、遊び終わったら解散してください。</p>` : ""}
    </div>${menuOverlay()}${idOverlay()}`;
    return;
  }

  // どの画面にも当てはまらないとき（席が無くなった等）。真っ白のまま操作不能にしない
  app.innerHTML = `<div class="min-h-screen flex flex-col items-center justify-center gap-3">
    ${roomLabel(r) ? `<span class="t-dim text-sm">部屋コード</span>
      <div class="roomcode">${esc(roomLabel(r))}</div>` : ""}
    <span class="t-dim">この部屋の席がありません</span>
    <button onclick="leaveRoom()" class="btn-sub px-6 py-2 rounded-lg text-sm mt-2">タイトルに戻る</button>
  </div>`;
}

// 個人IDを用意してからアプリを始める。
// 既にIDを持っている端末（2回目以降・旧UUID勢）では通信は起きず、そのまま描画に入る
async function bootstrap() {
  if (!state.playerId) {
    const back = state.screen;   // ?admin=1 で来た場合の行き先を潰さない
    state.screen = "issuing";
    render();
    state.playerId = await issuePersonalId();
    state.screen = back;
  }
  localStorage.setItem(ID_KEY, state.playerId);
  render();
  syncNameFromServer(state.playerId);
  refreshMyRooms();
}

// 名前はサーバー（個人IDに紐づく）が正。起動を止めないよう待たずに取りに行き、届いたら差し替える。
// ただし入力中なら触らない —— paint() は画面のHTMLを作り直すので、名前欄・合言葉欄に
// 打っている最中に render() が走ると入力が消えるため
function syncNameFromServer(id) {
  fetchProfileName(id).then((name) => {
    // サーバーがまだ名前を知らない番号（発行したて）。手元に控えがあるなら預けておく。
    // これが無いと、名前を持っているのに一度も遊んでいない端末のIDに合わせても
    // 引き継ぐものが無い（名前がサーバーに届くのは create/join/rename のときだけのため）
    if (!name) {
      if (state.name) fetchProfileName(id, state.name);
      return;
    }
    if (name === state.name) return;
    const ae = document.activeElement;
    if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")) return;
    state.name = name;
    localStorage.setItem("daifugo-name", name);
    render();
  });
}

document.body.classList.toggle("night", state.night);
bootstrap();
