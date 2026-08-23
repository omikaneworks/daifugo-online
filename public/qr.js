// ============ QRコード生成（短い文字列を見せるためだけの最小実装） ============
// 外部ライブラリを足したくないので自前で持つ。用途は「端末のIDをその場で見せる」ことだけ。
//
// バージョン5・誤り訂正L（37×37・最大106バイト）に固定してある。UUID（36文字）は
// 十分収まる。固定にするとブロック分割もバージョン情報パターンも要らなくなり、
// 実装がぐっと短くなる（V7以上だとどちらも必要になる）。

const SIZE = 37;         // 4 * 5 + 17
const DATA_BYTES = 108;  // V5-L のデータ語数
const EC_BYTES = 26;     // V5-L の誤り訂正語数
export const QR_MAX_BYTES = DATA_BYTES - 2; // モード指示子と文字数カウントの分を引く

// ---- GF(256)。QRの誤り訂正はこの体の上で計算する ----
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x; LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // 原始多項式
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

// 生成多項式 ∏(x - α^i) を次数の高い順で返す
function genPoly(len) {
  let g = [1];
  for (let i = 0; i < len; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];                    // x を掛けた分
      next[j + 1] ^= mul(g[j], EXP[i]);   // α^i を掛けた分
    }
    g = next;
  }
  return g;
}

// 誤り訂正語＝データを生成多項式で割った余り
function ecWords(data) {
  const g = genPoly(EC_BYTES);
  const buf = new Uint8Array(data.length + EC_BYTES);
  buf.set(data);
  for (let i = 0; i < data.length; i++) {
    const c = buf[i];
    if (c === 0) continue;
    for (let j = 0; j < g.length; j++) buf[i + j] ^= mul(g[j], c);
  }
  return buf.slice(data.length);
}

// バイトモードでビット列に詰め、余りを埋め草で埋める
function encodeData(bytes) {
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4);       // バイトモード
  push(bytes.length, 8); // 文字数（V1〜V9のバイトモードは8ビット）
  for (const b of bytes) push(b, 8);
  const cap = DATA_BYTES * 8;
  for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0); // ターミネータ
  while (bits.length % 8) bits.push(0);

  const data = new Uint8Array(DATA_BYTES);
  for (let i = 0; i < bits.length; i++) if (bits[i]) data[i >> 3] |= 0x80 >> (i & 7);
  const pad = [0xec, 0x11];
  for (let i = bits.length / 8, k = 0; i < DATA_BYTES; i++, k++) data[i] = pad[k % 2];
  return data;
}

// ---- 模様の配置 ----
// mods は「黒かどうか」、fixed は「機能パターンなので触らない」
function newGrid() {
  return {
    mods: Array.from({ length: SIZE }, () => new Array(SIZE).fill(false)),
    fixed: Array.from({ length: SIZE }, () => new Array(SIZE).fill(false)),
  };
}
function put(g, r, c, on) {
  if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return;
  g.mods[r][c] = on;
  g.fixed[r][c] = true;
}

function drawFunction(g) {
  // 位置検出パターン3つ（セパレータの空白も一緒に置く）
  for (const [fr, fc] of [[0, 0], [0, SIZE - 7], [SIZE - 7, 0]]) {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const inRing = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 &&
          (dr === 0 || dr === 6 || dc === 0 || dc === 6);
        const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        put(g, fr + dr, fc + dc, inRing || inCore);
      }
    }
  }
  // 位置合わせパターン。V5 は右下の1つだけ（他は位置検出パターンと重なるので置かない）
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      put(g, 30 + dr, 30 + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
    }
  }
  // タイミングパターン（行6と列6の交互）
  for (let i = 8; i < SIZE - 8; i++) {
    put(g, 6, i, i % 2 === 0);
    put(g, i, 6, i % 2 === 0);
  }
  // 形式情報の場所を先に押さえる（値は後で入れる）。
  // 行6・列6はタイミングパターンなので上書きしないこと（潰すと読み取れなくなる）
  for (let i = 0; i < 9; i++) {
    if (i === 6) continue;
    put(g, 8, i, false); put(g, i, 8, false);
  }
  for (let i = 0; i < 8; i++) { put(g, 8, SIZE - 1 - i, false); put(g, SIZE - 1 - i, 8, false); }
  put(g, SIZE - 8, 8, true); // 常に黒いモジュール
}

// 形式情報15ビット（誤り訂正レベルL＝01 とマスク番号）
function formatBits(mask) {
  const data = (1 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ (((rem >> 9) & 1) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}
function drawFormat(g, mask) {
  const bits = formatBits(mask);
  const bit = (i) => ((bits >> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) put(g, i, 8, bit(i));
  put(g, 7, 8, bit(6));
  put(g, 8, 8, bit(7));
  put(g, 8, 7, bit(8));
  for (let i = 9; i < 15; i++) put(g, 8, 14 - i, bit(i));
  for (let i = 0; i < 8; i++) put(g, 8, SIZE - 1 - i, bit(i));
  for (let i = 8; i < 15; i++) put(g, SIZE - 15 + i, 8, bit(i));
  put(g, SIZE - 8, 8, true);
}

// データを右下から2列ずつ、上下に折り返しながら詰める
function drawData(g, words) {
  let idx = 0;
  let up = true;
  for (let col = SIZE - 1; col >= 1; col -= 2) {
    if (col === 6) col = 5; // 縦のタイミングパターンは飛ばす
    for (let i = 0; i < SIZE; i++) {
      const row = up ? SIZE - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (g.fixed[row][c]) continue;
        const byte = words[idx >> 3];
        g.mods[row][c] = byte !== undefined && ((byte >> (7 - (idx & 7))) & 1) === 1;
        idx++;
      }
    }
    up = !up;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => ((r >> 1) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

// 読み取りにくい模様ほど点が高い。一番低いマスクを選ぶ
function penalty(m) {
  let score = 0;
  const size = SIZE;
  // 同じ色が5つ以上並ぶ
  for (let i = 0; i < size; i++) {
    for (const line of [m[i], m.map((row) => row[i])]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        if (line[j] === line[j - 1]) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
        else run = 1;
      }
    }
  }
  // 2×2の塊
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }
  // 位置検出パターンに似た並び
  const pat1 = [true, false, true, true, true, false, true, false, false, false, false];
  const pat2 = [false, false, false, false, true, false, true, true, true, false, true];
  const match = (line, at, pat) => pat.every((v, k) => line[at + k] === v);
  for (let i = 0; i < size; i++) {
    const row = m[i];
    const col = m.map((r) => r[i]);
    for (let j = 0; j + 11 <= size; j++) {
      if (match(row, j, pat1) || match(row, j, pat2)) score += 40;
      if (match(col, j, pat1) || match(col, j, pat2)) score += 40;
    }
  }
  // 白黒の偏り
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r][c]) dark++;
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return score;
}

// テキストからモジュールの二次元配列（true=黒）を作る。長すぎるときは null
export function buildQR(text) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > QR_MAX_BYTES) return null;

  const data = encodeData(bytes);
  const words = new Uint8Array(DATA_BYTES + EC_BYTES);
  words.set(data);
  words.set(ecWords(data), DATA_BYTES);

  const base = newGrid();
  drawFunction(base);
  drawData(base, words);

  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const g = {
      mods: base.mods.map((row) => row.slice()),
      fixed: base.fixed.map((row) => row.slice()),
    };
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (!g.fixed[r][c] && MASKS[mask](r, c)) g.mods[r][c] = !g.mods[r][c];
      }
    }
    drawFormat(g, mask);
    const s = penalty(g.mods);
    if (s < bestScore) { bestScore = s; best = g.mods; }
  }
  return best;
}

// 表示用のSVG。ナイトモードでも読めるよう白地は固定にする
export function qrSVG(text, cls = "qr-svg") {
  const m = buildQR(text);
  if (!m) return "";
  const quiet = 4; // 静寂帯（これが無いと読み取り機が枠を見つけられない）
  const n = m.length;
  let d = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (m[r][c]) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  }
  const side = n + quiet * 2;
  return `<svg class="${cls}" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges" role="img" aria-label="QRコード">
    <rect width="${side}" height="${side}" fill="#ffffff"/><path d="${d}" fill="#000000"/></svg>`;
}
