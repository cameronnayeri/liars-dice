// ============================================================
//  Shared utilities — loaded on every page
// ============================================================

// ── Supabase client ──────────────────────────────────────────
let _sb = null;
function getSB() {
  if (!_sb) _sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return _sb;
}

// ── ID / Code generation ─────────────────────────────────────
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I, O
function generateCode() {
  return Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
}
function generateId() {
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
}

// ── Dice helpers ─────────────────────────────────────────────
function rollDice(count) {
  return Array.from({ length: count }, () => Math.floor(Math.random() * 6) + 1);
}

// pip grid: 9 cells (3×3), 1 = show pip, 0 = hide
const PIP_MAP = {
  1: [0,0,0, 0,1,0, 0,0,0],
  2: [0,0,1, 0,0,0, 1,0,0],
  3: [0,0,1, 0,1,0, 1,0,0],
  4: [1,0,1, 0,0,0, 1,0,1],
  5: [1,0,1, 0,1,0, 1,0,1],
  6: [1,0,1, 1,0,1, 1,0,1],
};

function makeDieHTML(value, color, opts = {}) {
  const { faceDown = false, highlight = false, size = 56, animating = false } = opts;
  const classes = ['die'];
  if (highlight)  classes.push('die--highlight');
  if (faceDown)   classes.push('die--facedown');
  if (animating)  classes.push('die--rolling');

  const pipColor = lightenHex(color, 0.85);
  let inner = '';

  if (faceDown) {
    inner = `<span class="die__q">?</span>`;
  } else {
    const pips = PIP_MAP[value] || PIP_MAP[1];
    inner = pips.map(on =>
      `<div class="pip ${on ? 'pip--on' : 'pip--off'}" style="background:${pipColor}"></div>`
    ).join('');
  }

  return `<div class="${classes.join(' ')}"
    style="--die-color:${color};width:${size}px;height:${size}px;min-width:${size}px"
    data-value="${value}">
    ${inner}
  </div>`;
}

// ── Bid validation ────────────────────────────────────────────
function isValidBid(newBid, currentBid, settings, palaficoActive) {
  const { count: nc, face: nf } = newBid;
  if (nc < 1 || nf < 1 || nf > 6) return false;
  if (!currentBid) return true;

  const { count: cc, face: cf } = currentBid;

  // Classic mode or Palafico round: simple raise (count up, or same count + higher face)
  if (settings.mode === 'classic' || palaficoActive) {
    if (nf === cf) return nc > cc;
    if (nc === cc) return nf > cf;
    return nc > cc;
  }

  // Perudo mode
  if (cf === 1) {
    // Current bid is ONES
    if (nf === 1) return nc > cc;                 // raise ones count
    return nc >= cc * 2 + 1;                       // switch to non-ones: need ≥ 2× + 1
  } else {
    // Current bid is NON-ONES
    if (nf === cf) return nc > cc;                 // same face, more
    if (nf === 1)  return nc >= Math.ceil(cc / 2); // switch to ones: at least ⌈half⌉
    if (nc > cc)   return true;                    // more dice, any face
    if (nc === cc) return nf > cf;                 // same count, higher face
    return false;
  }
}

// ── Reveal math ───────────────────────────────────────────────
function countFace(revealData, face, onesWild) {
  let n = 0;
  for (const dice of Object.values(revealData)) {
    for (const d of dice) {
      if (d === face) n++;
      else if (onesWild && face !== 1 && d === 1) n++;
    }
  }
  return n;
}

// ── Color helpers ─────────────────────────────────────────────
function hexToRgb(hex) {
  const r = parseInt(hex.slice(1,3), 16);
  const g = parseInt(hex.slice(3,5), 16);
  const b = parseInt(hex.slice(5,7), 16);
  return { r, g, b };
}
function hexToRgba(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}
function lightenHex(hex, amount) {
  const { r, g, b } = hexToRgb(hex);
  const mix = (c) => Math.min(255, Math.round(c + (255 - c) * amount));
  return `#${mix(r).toString(16).padStart(2,'0')}${mix(g).toString(16).padStart(2,'0')}${mix(b).toString(16).padStart(2,'0')}`;
}

// ── Face display helpers ──────────────────────────────────────
const FACE_UNICODE = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
const FACE_NAME    = ['', 'Ones', 'Twos', 'Threes', 'Fours', 'Fives', 'Sixes'];

function describeBid(bid) {
  if (!bid) return '—';
  return `${bid.count} × ${FACE_UNICODE[bid.face]} ${FACE_NAME[bid.face]}`;
}

// ── Misc ──────────────────────────────────────────────────────
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function $(id) { return document.getElementById(id); }

function escapeHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
