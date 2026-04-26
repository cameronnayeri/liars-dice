// ============================================================
//  Lobby page logic
// ============================================================

const PRESET_COLORS = [
  { name: 'Crimson',   hex: '#c41e3a' },
  { name: 'Ember',     hex: '#d05010' },
  { name: 'Gold',      hex: '#c8a030' },
  { name: 'Venom',     hex: '#3a8a1a' },
  { name: 'Sapphire',  hex: '#1a60c0' },
  { name: 'Amethyst',  hex: '#8a1ab0' },
  { name: 'Teal',      hex: '#1a8a88' },
  { name: 'Bone',      hex: '#c8b880' },
  { name: 'Ash',       hex: '#707080' },
  { name: 'Violet',    hex: '#6a1a9a' },
];

const sb       = getSB();
const lobbyCode  = localStorage.getItem('lobbyCode');
const myPlayerId = localStorage.getItem('playerId');

let players   = [];
let lobby     = null;
let myPlayer  = null;
let settingsDebounce = null;

// ── Notification ─────────────────────────────────────────────
const notifEl = document.getElementById('notification');
let notifTimer;
function showNotif(msg, type = 'error') {
  notifEl.textContent = msg;
  notifEl.className = `show notif--${type}`;
  clearTimeout(notifTimer);
  notifTimer = setTimeout(() => notifEl.className = '', 3200);
}

// ── Boot ─────────────────────────────────────────────────────
async function init() {
  if (!lobbyCode || !myPlayerId) {
    window.location.href = 'index.html';
    return;
  }

  document.getElementById('lobby-code-display').textContent = lobbyCode;

  buildColorPicker();

  // Load data
  const [{ data: lobbyData }, { data: playerData }] = await Promise.all([
    sb.from('lobbies').select('*').eq('code', lobbyCode).maybeSingle(),
    sb.from('players').select('*').eq('lobby_code', lobbyCode).order('seat_order')
  ]);

  if (!lobbyData) {
    alert('Lobby not found');
    window.location.href = 'index.html';
    return;
  }

  lobby   = lobbyData;
  players = playerData || [];
  myPlayer = players.find(p => p.id === myPlayerId);

  if (!myPlayer) {
    alert('You are not in this lobby');
    window.location.href = 'index.html';
    return;
  }

  // If game already started, forward to game
  if (lobby.status === 'playing') {
    window.location.href = 'game.html';
    return;
  }

  render();
  setupSettings();
  subscribeToLobby();
  subscribeToPlayers();

  // Update last_seen
  setInterval(pingLastSeen, 15000);
}

// ── Color Picker ──────────────────────────────────────────────
function buildColorPicker() {
  const container = document.getElementById('color-picker');
  PRESET_COLORS.forEach(c => {
    const sw = document.createElement('div');
    sw.className = 'color-swatch';
    sw.style.background = c.hex;
    sw.title = c.name;
    sw.dataset.color = c.hex;
    sw.addEventListener('click', () => pickColor(c.hex));
    container.appendChild(sw);
  });
}

async function pickColor(hex) {
  document.querySelectorAll('.color-swatch').forEach(sw => {
    sw.classList.toggle('active', sw.dataset.color === hex);
  });
  await sb.from('players').update({ dice_color: hex }).eq('id', myPlayerId);
}

function syncColorSwatch(color) {
  document.querySelectorAll('.color-swatch').forEach(sw => {
    sw.classList.toggle('active', sw.dataset.color === color);
  });
}

// ── Render ────────────────────────────────────────────────────
function render() {
  renderPlayerList();
  renderSettingsPanel();
  renderFooter();
  syncColorSwatch(myPlayer?.dice_color || '#c41e3a');
}

function renderPlayerList() {
  const list = document.getElementById('player-list');
  list.innerHTML = '';

  const sorted = [...players].sort((a, b) => a.seat_order - b.seat_order);

  sorted.forEach(p => {
    const div = document.createElement('div');
    div.className = `player-slot${p.id === myPlayerId ? ' is-me' : ''}`;
    div.style.borderColor = p.dice_color;
    div.style.boxShadow = `0 0 10px ${hexToRgba(p.dice_color, 0.25)}`;
    div.innerHTML = `
      <div class="player-slot__color" style="background:${p.dice_color}"></div>
      <div class="player-slot__name">${escapeHtml(p.name)}${p.id === myPlayerId ? ' <span style="font-size:0.7rem;color:var(--text-dim)">(you)</span>' : ''}</div>
      ${p.is_host ? '<span class="player-slot__host-badge">Host</span>' : ''}
    `;
    list.appendChild(div);
  });

  // Empty slots
  const maxP = lobby?.settings?.maxPlayers || 8;
  for (let i = players.length; i < Math.min(maxP, 8); i++) {
    const div = document.createElement('div');
    div.className = 'player-slot player-slot--empty';
    div.innerHTML = `<div class="player-slot__name" style="font-size:0.8rem">Waiting for player…</div>`;
    list.appendChild(div);
  }
}

function renderSettingsPanel() {
  const isHost = myPlayer?.is_host;
  document.getElementById('settings-form').classList.toggle('hidden', !isHost);
  document.getElementById('settings-readonly').classList.toggle('hidden', isHost);

  if (!isHost && lobby) {
    const s = lobby.settings;
    const display = document.getElementById('settings-display');
    display.innerHTML = `
      <div>Mode: <b>${s.mode === 'perudo' ? 'Perudo' : 'Classic'}</b></div>
      <div>Starting Dice: <b>${s.startingDice}</b></div>
      <div>Ones Wild: <b>${s.onesWild ? 'Yes' : 'No'}</b></div>
      <div>Spot-On: <b>${s.spotOnEnabled ? 'Enabled' : 'Disabled'}</b></div>
      ${s.mode === 'perudo' ? `<div>Palafico: <b>${s.palaficoEnabled ? 'Enabled' : 'Disabled'}</b></div>` : ''}
      <div>Max Players: <b>${s.maxPlayers}</b></div>
    `;
  }

  if (isHost && lobby) {
    const s = lobby.settings;
    document.getElementById('s-mode').value = s.mode;
    document.getElementById('s-dice').value = String(s.startingDice);
    document.getElementById('s-oneswild').checked = s.onesWild;
    document.getElementById('s-spoton').checked = s.spotOnEnabled;
    document.getElementById('s-palafico').checked = s.palaficoEnabled;
    document.getElementById('s-maxplayers').value = String(s.maxPlayers);
    syncSettingsUI();
  }
}

function syncSettingsUI() {
  const mode = document.getElementById('s-mode')?.value;
  document.getElementById('row-ones-wild').style.opacity  = mode === 'perudo' ? '1' : '0.4';
  document.getElementById('row-palafico').style.opacity   = mode === 'perudo' ? '1' : '0.4';
  document.getElementById('s-oneswild').disabled  = mode !== 'perudo';
  document.getElementById('s-palafico').disabled  = mode !== 'perudo';
}

function renderFooter() {
  const isHost = myPlayer?.is_host;
  const startBtn = document.getElementById('start-btn');
  const waitMsg  = document.getElementById('waiting-msg');

  if (isHost) {
    const canStart = players.length >= 2;
    startBtn.classList.toggle('hidden', false);
    startBtn.disabled = !canStart;
    waitMsg.textContent = canStart
      ? 'Ready to begin'
      : `Need at least 2 players (${players.length}/2)`;
  } else {
    startBtn.classList.add('hidden');
    waitMsg.textContent = `Waiting for host to start… (${players.length} player${players.length !== 1 ? 's' : ''})`;
  }
}

// ── Settings form wiring (host only) ──────────────────────────
function setupSettings() {
  if (!myPlayer?.is_host) return;

  const inputs = ['s-mode', 's-dice', 's-oneswild', 's-spoton', 's-palafico', 's-maxplayers'];
  inputs.forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => {
      syncSettingsUI();
      clearTimeout(settingsDebounce);
      settingsDebounce = setTimeout(saveSettings, 400);
    });
  });

  document.getElementById('start-btn').addEventListener('click', startGame);
}

async function saveSettings() {
  const mode = document.getElementById('s-mode').value;
  const settings = {
    mode,
    startingDice: parseInt(document.getElementById('s-dice').value),
    onesWild: mode === 'perudo' ? document.getElementById('s-oneswild').checked : false,
    spotOnEnabled: document.getElementById('s-spoton').checked,
    palaficoEnabled: mode === 'perudo' ? document.getElementById('s-palafico').checked : false,
    maxPlayers: parseInt(document.getElementById('s-maxplayers').value),
  };

  const { error } = await sb.from('lobbies').update({ settings }).eq('code', lobbyCode);
  if (error) showNotif('Failed to save settings');
}

// ── Start Game ────────────────────────────────────────────────
async function startGame() {
  if (players.length < 2) return;

  const btn = document.getElementById('start-btn');
  btn.disabled = true;
  btn.textContent = 'Starting…';

  // Assign fresh seat order and reset dice counts
  const sorted = [...players].sort((a, b) => a.seat_order - b.seat_order);
  const startingDice = lobby.settings.startingDice;
  const playerOrder  = sorted.map(p => p.id);

  // Reset all players
  for (const p of sorted) {
    await sb.from('players').update({
      dice_count: startingDice,
      is_eliminated: false,
      revealed_dice: null,
    }).eq('id', p.id);
  }

  // Randomize first player
  const firstIndex = Math.floor(Math.random() * playerOrder.length);

  const gameState = {
    phase: 'rolling',
    round: 1,
    playerOrder,
    currentPlayerIndex: firstIndex,
    currentBid: null,
    challengerId: null,
    challengeType: null,
    revealData: null,
    roundResult: null,
    palaficoActive: false,
    palaficoPlayerId: null,
    winnerId: null,
  };

  const { error } = await sb.from('lobbies').update({
    status: 'playing',
    game_state: gameState,
  }).eq('code', lobbyCode);

  if (error) {
    showNotif('Failed to start game');
    btn.disabled = false;
    btn.textContent = 'Start Game';
  }
  // lobby subscription will forward all clients to game.html
}

// ── Realtime subscriptions ────────────────────────────────────
function subscribeToLobby() {
  sb.channel(`lobby-${lobbyCode}-lobbies`)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'lobbies',
      filter: `code=eq.${lobbyCode}`
    }, ({ new: updated }) => {
      if (!updated) return;
      lobby = updated;

      if (updated.status === 'playing') {
        window.location.href = 'game.html';
        return;
      }
      render();
    })
    .subscribe();
}

function subscribeToPlayers() {
  sb.channel(`lobby-${lobbyCode}-players`)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'players',
      filter: `lobby_code=eq.${lobbyCode}`
    }, async () => {
      const { data } = await sb.from('players')
        .select('*').eq('lobby_code', lobbyCode).order('seat_order');
      players   = data || [];
      myPlayer  = players.find(p => p.id === myPlayerId) || myPlayer;
      render();
    })
    .subscribe();
}

// ── Leave ─────────────────────────────────────────────────────
document.getElementById('leave-btn').addEventListener('click', async () => {
  if (!confirm('Leave the lobby?')) return;
  await sb.from('players').delete().eq('id', myPlayerId);
  localStorage.removeItem('playerId');
  localStorage.removeItem('lobbyCode');
  window.location.href = 'index.html';
});

// ── Ping last_seen ────────────────────────────────────────────
async function pingLastSeen() {
  await sb.from('players').update({ last_seen: new Date().toISOString() }).eq('id', myPlayerId);
}

init();
