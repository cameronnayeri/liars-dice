// ============================================================
//  Game page — full state machine
// ============================================================

const sb         = getSB();
const lobbyCode  = localStorage.getItem('lobbyCode');
const myPlayerId = localStorage.getItem('playerId');

let players       = [];
let lobby         = null;
let myPlayer      = null;
let myDice        = [];
let prevPhase     = null;
let waitingForReveal = false;
let broadcastChannel = null;
let skipTimer     = null;

// Selected bid state
let bidCount = 1;
let bidFace  = 2;

const EMOTES = ['💀','👻','😂','😱','🔥','👁️','🤔','🎯','🤡','😈','🍀','☠️'];

// ── Notification ──────────────────────────────────────────────
const notifEl = document.getElementById('notification');
let notifTimer;
function showNotif(msg, type = 'info') {
  notifEl.textContent = msg;
  notifEl.className = `show notif--${type}`;
  clearTimeout(notifTimer);
  notifTimer = setTimeout(() => notifEl.className = '', 3500);
}

// ── Boot ──────────────────────────────────────────────────────
async function init() {
  if (!lobbyCode || !myPlayerId) {
    window.location.href = 'index.html';
    return;
  }

  // Restore dice from localStorage if we have them
  const stored = localStorage.getItem('myDice');
  if (stored) myDice = JSON.parse(stored);

  // Load data
  const [{ data: lobbyData }, { data: playerData }] = await Promise.all([
    sb.from('lobbies').select('*').eq('code', lobbyCode).maybeSingle(),
    sb.from('players').select('*').eq('lobby_code', lobbyCode).order('seat_order')
  ]);

  if (!lobbyData) {
    alert('Game not found');
    window.location.href = 'index.html';
    return;
  }

  lobby   = lobbyData;
  players = playerData || [];
  myPlayer = players.find(p => p.id === myPlayerId);

  if (!myPlayer) {
    alert('You are not in this game');
    window.location.href = 'index.html';
    return;
  }

  wireUI();
  subscribeToLobby();
  subscribeToPlayers();
  broadcastChannel = subscribeToBroadcast();

  // Handle current state
  await handleGameStateChange(lobby.game_state, null);
  renderAll();

  setInterval(pingLastSeen, 15000);
}

// ── Supabase helpers ──────────────────────────────────────────
async function fetchLobby() {
  const { data } = await sb.from('lobbies').select('*').eq('code', lobbyCode).maybeSingle();
  return data;
}
async function fetchPlayers() {
  const { data } = await sb.from('players').select('*').eq('lobby_code', lobbyCode).order('seat_order');
  return data || [];
}

async function updateGameState(newState) {
  return sb.from('lobbies').update({ game_state: newState }).eq('code', lobbyCode);
}

async function pingLastSeen() {
  await sb.from('players').update({ last_seen: new Date().toISOString() }).eq('id', myPlayerId);
}

// ── Subscriptions ─────────────────────────────────────────────
function subscribeToLobby() {
  sb.channel(`game-${lobbyCode}-lobby`)
    .on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'lobbies',
      filter: `code=eq.${lobbyCode}`
    }, ({ new: updated }) => {
      if (!updated) return;
      const oldPhase = lobby?.game_state?.phase;
      lobby = updated;
      handleGameStateChange(lobby.game_state, oldPhase);
      renderAll();
    })
    .subscribe();
}

function subscribeToPlayers() {
  sb.channel(`game-${lobbyCode}-players`)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'players',
      filter: `lobby_code=eq.${lobbyCode}`
    }, async () => {
      players  = await fetchPlayers();
      myPlayer = players.find(p => p.id === myPlayerId) || myPlayer;
      renderAll();
      checkAllDiceRevealed();
    })
    .subscribe();
}

function subscribeToBroadcast() {
  return sb.channel(`game-${lobbyCode}-broadcast`)
    .on('broadcast', { event: 'emote' }, ({ payload }) => {
      receiveEmote(payload.playerId, payload.emote);
    })
    .subscribe();
}

// ── Main state machine ────────────────────────────────────────
async function handleGameStateChange(gs, oldPhase) {
  if (!gs || !gs.phase) return;
  const phase = gs.phase;
  if (phase === prevPhase) return;
  prevPhase = phase;

  switch (phase) {
    case 'rolling':         await enterRolling(gs); break;
    case 'bidding':         enterBidding(gs); break;
    case 'challenge_called': await enterChallengeCalled(gs); break;
    case 'revealing':       await enterRevealing(gs); break;
    case 'round_result':    await enterRoundResult(gs); break;
    case 'game_over':       enterGameOver(gs); break;
  }
}

// ── Phase: ROLLING ────────────────────────────────────────────
async function enterRolling(gs) {
  addLog(`— Round ${gs.round} —`, 'system');

  // Check palafico
  if (gs.palaficoActive) {
    document.getElementById('palafico-badge').classList.add('active');
    addLog('⚑ Palafico round — no wild ones', 'system');
  } else {
    document.getElementById('palafico-badge').classList.remove('active');
  }

  // Roll our dice
  const diceCount = myPlayer?.dice_count || lobby?.settings?.startingDice || 5;
  myDice = rollDice(diceCount);
  localStorage.setItem('myDice', JSON.stringify(myDice));

  renderYourDice(myDice);
  setTurnIndicator('rolling', 'Rolling dice…');

  // Show rolling animation on your dice
  document.querySelectorAll('#your-dice-row .die').forEach(d => {
    d.classList.add('die--rolling');
    setTimeout(() => d.classList.remove('die--rolling'), 700);
  });

  // Host auto-advances to bidding after 2.5s
  if (myPlayer?.is_host) {
    await delay(2500);
    const fresh = await fetchLobby();
    if (fresh?.game_state?.phase === 'rolling' && fresh.game_state.round === gs.round) {
      await updateGameState({ ...fresh.game_state, phase: 'bidding' });
    }
  }
}

// ── Phase: BIDDING ────────────────────────────────────────────
function enterBidding(gs) {
  document.getElementById('reveal-overlay').classList.remove('active');
  resetBidUI(gs);
  renderBidDisplay(gs.currentBid, gs);
  updateTurnUI(gs);
}

function resetBidUI(gs) {
  // Set sensible default bid: one higher than current
  const cb = gs.currentBid;
  if (!cb) {
    bidCount = 1;
    bidFace  = 2;
  } else {
    // Default: same face +1 count
    bidCount = cb.count + 1;
    bidFace  = cb.face;
  }
  refreshBidInputs();
}

// ── Phase: CHALLENGE CALLED ───────────────────────────────────
async function enterChallengeCalled(gs) {
  addLog(
    `${playerName(gs.challengerId)} called ${gs.challengeType === 'liar' ? '☠ LIAR' : '🎯 SPOT-ON'}!`,
    gs.challengeType === 'liar' ? 'challenge' : 'spoton'
  );

  setTurnIndicator('rolling', 'Revealing dice…');
  hideControls();

  // Every player submits their own dice
  await revealMyDice();

  // Host watches for all dice to be in, then advances
  if (myPlayer?.is_host) {
    waitingForReveal = true;
    // Immediately check in case all are already in (small game)
    setTimeout(checkAllDiceRevealed, 600);
  }
}

async function revealMyDice() {
  const dice = myDice.length ? myDice : rollDice(myPlayer?.dice_count || 1);
  await sb.from('players').update({ revealed_dice: dice }).eq('id', myPlayerId);
}

async function checkAllDiceRevealed() {
  if (!waitingForReveal || !myPlayer?.is_host) return;
  const fresh = await fetchLobby();
  if (!fresh || fresh.game_state?.phase !== 'challenge_called') return;

  const activePlayers = players.filter(p => !p.is_eliminated);
  const allIn = activePlayers.every(p => p.revealed_dice !== null && p.revealed_dice !== undefined);

  if (allIn) {
    waitingForReveal = false;
    const revealData = {};
    activePlayers.forEach(p => { revealData[p.id] = p.revealed_dice; });
    const gs = fresh.game_state;
    const onesWild = fresh.settings.onesWild && fresh.settings.mode === 'perudo' && !gs.palaficoActive;
    const actualCount = countFace(revealData, gs.currentBid.face, onesWild);
    const roundResult = buildRoundResult(gs, revealData, actualCount, fresh.settings);

    await updateGameState({ ...gs, phase: 'revealing', revealData, roundResult });
  }
}

function buildRoundResult(gs, revealData, actualCount, settings) {
  const { currentBid: bid, challengerId, challengeType } = gs;
  const bidderId = bid.playerId;
  const bidCount = bid.count;

  if (challengeType === 'liar') {
    if (actualCount < bidCount) {
      // Liar confirmed — bidder was over
      return { type: 'liar_correct', loserId: bidderId, gainerId: null, actualCount, bidCount };
    } else {
      // Bid holds — challenger was wrong
      return { type: 'liar_wrong', loserId: challengerId, gainerId: null, actualCount, bidCount };
    }
  } else {
    // Spot-on
    if (actualCount === bidCount) {
      return { type: 'spoton_correct', loserId: null, gainerId: challengerId, actualCount, bidCount };
    } else {
      return { type: 'spoton_wrong', loserId: challengerId, gainerId: null, actualCount, bidCount };
    }
  }
}

// ── Phase: REVEALING ─────────────────────────────────────────
async function enterRevealing(gs) {
  const overlay = document.getElementById('reveal-overlay');
  const titleEl = document.getElementById('reveal-title');
  const playersEl = document.getElementById('reveal-players');
  const tallyEl = document.getElementById('reveal-tally');
  const resultEl = document.getElementById('reveal-result');
  const hintEl = document.getElementById('reveal-close-hint');

  // Reset overlay
  titleEl.classList.remove('show');
  playersEl.innerHTML = '';
  tallyEl.classList.remove('show');
  resultEl.className = 'reveal-result';
  resultEl.classList.remove('show');
  hintEl.style.display = 'none';

  overlay.classList.add('active');
  await delay(400);
  titleEl.classList.add('show');
  await delay(1100);

  const { revealData, currentBid, roundResult, palaficoActive } = gs;
  const settings = lobby.settings;
  const onesWild = settings.onesWild && settings.mode === 'perudo' && !palaficoActive;
  const activePlayers = players.filter(p => !p.is_eliminated).sort((a, b) => {
    const order = gs.playerOrder || [];
    return order.indexOf(a.id) - order.indexOf(b.id);
  });

  // Reveal each player row
  for (const player of activePlayers) {
    const dice = (revealData && revealData[player.id]) ? revealData[player.id] : [];

    const row = document.createElement('div');
    row.className = 'reveal-player-row';
    row.innerHTML = `
      <div class="reveal-player-row__name" style="color:${player.dice_color}">
        ${escapeHtml(player.name)}${player.id === myPlayerId ? ' (you)' : ''}
      </div>
      <div class="reveal-player-row__dice" id="reveal-dice-${player.id}"></div>
    `;
    playersEl.appendChild(row);
    await delay(80);
    row.classList.add('show');
    await delay(350);

    const diceContainer = row.querySelector(`#reveal-dice-${player.id}`);

    // Show all dice face-down first
    dice.forEach(() => {
      diceContainer.insertAdjacentHTML('beforeend', makeDieHTML(1, player.dice_color, { faceDown: true, size: 56 }));
    });

    // Flip one by one
    const dieEls = diceContainer.querySelectorAll('.die');
    for (let i = 0; i < dieEls.length; i++) {
      await delay(380);
      const val = dice[i];
      const isMatch = val === currentBid.face;
      const isWild  = onesWild && currentBid.face !== 1 && val === 1;
      const highlight = isMatch || isWild;

      // Rebuild die as face-up
      dieEls[i].classList.remove('die--facedown');
      dieEls[i].classList.add('die--flipping');
      const pips = PIP_MAP[val] || PIP_MAP[1];
      const pipColor = lightenHex(player.dice_color, 0.85);
      dieEls[i].innerHTML = pips.map(on =>
        `<div class="pip ${on ? 'pip--on' : 'pip--off'}" style="background:${pipColor}"></div>`
      ).join('');
      dieEls[i].dataset.value = val;

      if (highlight) {
        await delay(150);
        dieEls[i].classList.add('die--highlight');
      }
    }

    await delay(300);
  }

  // Tally
  await delay(600);
  const onesCount = onesWild ? countFace(revealData, 1, false) : 0;
  const faceCount = countFace(revealData, currentBid.face, false);
  const actual    = onesWild && currentBid.face !== 1 ? faceCount + onesCount : faceCount;

  const tallyBid = document.getElementById('tally-bid-label');
  const tallyCount = document.getElementById('tally-count');
  tallyBid.textContent = `Bid: ${currentBid.count} × ${FACE_UNICODE[currentBid.face]} ${FACE_NAME[currentBid.face]}`;
  if (onesWild && currentBid.face !== 1) {
    tallyCount.innerHTML = `<span class="actual">${actual} matching</span> <span class="needed"> (${faceCount} ${FACE_NAME[currentBid.face]} + ${onesCount} wild ones) / needed ${currentBid.count}</span>`;
  } else {
    tallyCount.innerHTML = `<span class="actual">${actual} ${FACE_NAME[currentBid.face]}</span> <span class="needed"> / needed ${currentBid.count}</span>`;
  }
  tallyEl.classList.add('show');
  await delay(1200);

  // Result
  const rr = roundResult;
  const loser = rr.loserId ? players.find(p => p.id === rr.loserId) : null;
  const gainer = rr.gainerId ? players.find(p => p.id === rr.gainerId) : null;

  let resultClass, headline, detail;
  if (rr.type === 'liar_correct') {
    resultClass = 'result--correct';
    headline    = 'The Lie Exposed!';
    detail      = `${escapeHtml(loser?.name || '?')} loses a die — the bid was false.`;
    addLog(`☠ Liar confirmed! ${loser?.name} loses a die.`, 'result');
  } else if (rr.type === 'liar_wrong') {
    resultClass = 'result--wrong';
    headline    = 'The Bid Holds!';
    detail      = `${escapeHtml(loser?.name || '?')} loses a die — the bid was true.`;
    addLog(`The bid held. ${loser?.name} loses a die.`, 'result');
  } else if (rr.type === 'spoton_correct') {
    resultClass = 'result--spoton-win';
    headline    = 'Spot On!';
    detail      = `${escapeHtml(gainer?.name || '?')} gains a die — exact count!`;
    addLog(`🎯 Spot-on! ${gainer?.name} gains a die.`, 'result');
  } else {
    resultClass = 'result--correct';
    headline    = 'Off The Mark!';
    detail      = `${escapeHtml(loser?.name || '?')} loses a die — wrong count.`;
    addLog(`Spot-on missed. ${loser?.name} loses a die.`, 'result');
  }

  resultEl.className = `reveal-result ${resultClass}`;
  document.getElementById('result-headline').textContent = headline;
  document.getElementById('result-detail').textContent   = detail;
  await delay(200);
  resultEl.classList.add('show');

  await delay(2400);
  hintEl.style.display = 'block';

  // Host advances to round_result phase so all clients apply die changes
  if (myPlayer?.is_host) {
    const fresh = await fetchLobby();
    if (fresh?.game_state?.phase === 'revealing') {
      await updateGameState({ ...fresh.game_state, phase: 'round_result' });
    }
  }
}

// ── Phase: ROUND RESULT ───────────────────────────────────────
async function enterRoundResult(gs) {
  const rr = gs.roundResult;
  if (!rr || !myPlayer?.is_host) return;

  // Only host applies die changes and drives next round
  if (rr.loserId) {
    const loser = players.find(p => p.id === rr.loserId);
    if (loser) {
      const newCount = Math.max(0, loser.dice_count - 1);
      await sb.from('players').update({
        dice_count: newCount,
        is_eliminated: newCount === 0
      }).eq('id', rr.loserId);
    }
  }
  if (rr.gainerId && lobby.settings.spotOnEnabled) {
    const gainer = players.find(p => p.id === rr.gainerId);
    if (gainer) {
      const newCount = Math.min(lobby.settings.startingDice, gainer.dice_count + 1);
      await sb.from('players').update({ dice_count: newCount }).eq('id', rr.gainerId);
    }
  }

  // Clear revealed_dice for all
  await sb.from('players').update({ revealed_dice: null }).eq('lobby_code', lobbyCode);

  // Refresh to get updated dice counts
  players  = await fetchPlayers();
  myPlayer = players.find(p => p.id === myPlayerId) || myPlayer;

  // Check game over
  const alive = players.filter(p => !p.is_eliminated);
  if (alive.length <= 1) {
    const winnerId = alive[0]?.id || null;
    await updateGameState({ ...gs, phase: 'game_over', winnerId });
    return;
  }

  // Wait then start next round
  await delay(5000);
  const fresh = await fetchLobby();
  if (fresh?.game_state?.phase === 'round_result') {
    await startNextRound(fresh.game_state, fresh.settings);
  }
}

async function startNextRound(gs, settings) {
  players = await fetchPlayers();
  const alive = players.filter(p => !p.is_eliminated);

  // Who starts next round? The loser goes first.
  let firstPlayerId = gs.roundResult?.loserId || gs.roundResult?.gainerId;
  if (!firstPlayerId || !alive.find(p => p.id === firstPlayerId)) {
    firstPlayerId = alive[0]?.id;
  }

  const newOrder = buildPlayerOrder(alive, firstPlayerId);
  const nextRound = gs.round + 1;

  // Check palafico
  let palaficoActive = false;
  let palaficoPlayerId = null;
  if (settings.palaficoEnabled && settings.mode === 'perudo') {
    const palPlayer = alive.find(p => p.dice_count === 1);
    if (palPlayer) {
      palaficoActive = true;
      palaficoPlayerId = palPlayer.id;
      // Palafico player goes first
      const palOrder = buildPlayerOrder(alive, palPlayer.id);
      newOrder.splice(0, newOrder.length, ...palOrder);
    }
  }

  await updateGameState({
    phase: 'rolling',
    round: nextRound,
    playerOrder: newOrder,
    currentPlayerIndex: 0,
    currentBid: null,
    challengerId: null,
    challengeType: null,
    revealData: null,
    roundResult: null,
    palaficoActive,
    palaficoPlayerId,
    winnerId: null,
  });
}

function buildPlayerOrder(alivePlayers, firstId) {
  const sorted = [...alivePlayers].sort((a, b) => a.seat_order - b.seat_order);
  const idx = sorted.findIndex(p => p.id === firstId);
  if (idx < 0) return sorted.map(p => p.id);
  return [...sorted.slice(idx), ...sorted.slice(0, idx)].map(p => p.id);
}

// ── Phase: GAME OVER ──────────────────────────────────────────
function enterGameOver(gs) {
  document.getElementById('reveal-overlay').classList.remove('active');
  const overlay = document.getElementById('gameover-overlay');
  const winner  = players.find(p => p.id === gs.winnerId);
  document.getElementById('gameover-winner').textContent = winner?.name || 'Unknown';
  document.getElementById('gameover-winner').style.color = winner?.dice_color || 'var(--red)';
  overlay.classList.add('active');
  addLog(`🏆 ${winner?.name || '?'} wins the game!`, 'result');
}

// ── Actions ───────────────────────────────────────────────────
async function submitBid() {
  const gs = lobby.game_state;
  if (!isMyTurn(gs)) return;

  const newBid = { count: bidCount, face: bidFace, playerId: myPlayerId };
  const palafico = gs.palaficoActive || false;

  if (!isValidBid(newBid, gs.currentBid, lobby.settings, palafico)) {
    showBidError('Invalid bid — must be higher than the current bid');
    return;
  }

  hideBidError();

  // Advance to next player
  const order = gs.playerOrder;
  const nextIndex = (gs.currentPlayerIndex + 1) % order.length;

  await updateGameState({
    ...gs,
    currentBid: newBid,
    currentPlayerIndex: nextIndex,
  });

  addLog(`${escapeHtml(myPlayer.name)} bid ${describeBid(newBid)}`, 'bid');
}

async function callChallenge(type) {
  const gs = lobby.game_state;
  if (!isMyTurn(gs)) return;
  if (!gs.currentBid) return;

  hideControls();

  await updateGameState({
    ...gs,
    phase: 'challenge_called',
    challengerId: myPlayerId,
    challengeType: type,
  });
}

async function skipCurrentPlayer() {
  if (!myPlayer?.is_host) return;
  const gs = lobby.game_state;
  if (gs.phase !== 'bidding') return;

  const order = gs.playerOrder;
  const nextIndex = (gs.currentPlayerIndex + 1) % order.length;
  showNotif(`Skipped ${playerName(order[gs.currentPlayerIndex])}`, 'info');
  await updateGameState({ ...gs, currentPlayerIndex: nextIndex });
}

// ── Bid input helpers ─────────────────────────────────────────
function refreshBidInputs() {
  document.getElementById('count-val').textContent = bidCount;
  document.querySelectorAll('.face-btn').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.face) === bidFace);
  });
}

function showBidError(msg) {
  const el = document.getElementById('bid-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}
function hideBidError() {
  document.getElementById('bid-error').classList.add('hidden');
}

// ── UI wiring ──────────────────────────────────────────────────
function wireUI() {
  document.getElementById('count-dec').addEventListener('click', () => {
    if (bidCount > 1) { bidCount--; refreshBidInputs(); }
  });
  document.getElementById('count-inc').addEventListener('click', () => {
    const total = players.filter(p => !p.is_eliminated).reduce((s, p) => s + p.dice_count, 0);
    if (bidCount < total) { bidCount++; refreshBidInputs(); }
  });

  document.getElementById('face-selector').addEventListener('click', e => {
    const btn = e.target.closest('.face-btn');
    if (btn) {
      bidFace = parseInt(btn.dataset.face);
      refreshBidInputs();
    }
  });

  document.getElementById('bid-btn').addEventListener('click', submitBid);
  document.getElementById('liar-btn').addEventListener('click', () => callChallenge('liar'));
  document.getElementById('spoton-btn').addEventListener('click', () => callChallenge('spoton'));
  document.getElementById('skip-btn').addEventListener('click', skipCurrentPlayer);

  document.getElementById('leave-btn').addEventListener('click', async () => {
    if (!confirm('Leave the game?')) return;
    localStorage.removeItem('myDice');
    window.location.href = 'index.html';
  });

  document.getElementById('play-again-btn').addEventListener('click', async () => {
    await sb.from('lobbies').update({ status: 'waiting', game_state: {} }).eq('code', lobbyCode);
    await sb.from('players').update({ dice_count: lobby.settings.startingDice, is_eliminated: false, revealed_dice: null }).eq('lobby_code', lobbyCode);
    window.location.href = 'lobby.html';
  });

  document.getElementById('back-lobby-btn').addEventListener('click', () => {
    window.location.href = 'lobby.html';
  });

  // Emote picker
  document.getElementById('emote-toggle').addEventListener('click', () => {
    const picker = document.getElementById('emote-picker');
    picker.style.display = picker.style.display === 'none' ? 'flex' : 'none';
  });

  document.getElementById('emote-picker').addEventListener('click', async e => {
    const btn = e.target.closest('.emote-btn');
    if (!btn) return;
    const emote = btn.dataset.emote;
    document.getElementById('emote-picker').style.display = 'none';
    addLog(`${emote} ${escapeHtml(myPlayer?.name || 'You')}`, 'emote');
    showEmote(myPlayerId, emote);
    if (broadcastChannel) {
      broadcastChannel.send({ type: 'broadcast', event: 'emote', payload: { playerId: myPlayerId, emote } });
    }
  });
}

// ── Emotes ────────────────────────────────────────────────────
function receiveEmote(playerId, emote) {
  if (playerId === myPlayerId) return; // we already showed ours
  const player = players.find(p => p.id === playerId);
  addLog(`${emote} ${escapeHtml(player?.name || '?')}`, 'emote');
  showEmote(playerId, emote);
}

function showEmote(playerId, emote) {
  const card = document.querySelector(`[data-player-id="${playerId}"]`);
  if (!card) return;
  const bubble = document.createElement('div');
  bubble.className = 'emote-bubble';
  bubble.textContent = emote;
  card.appendChild(bubble);
  setTimeout(() => bubble.remove(), 3200);
}

// ── Log ───────────────────────────────────────────────────────
function addLog(text, type = 'info') {
  const log = document.getElementById('game-log');
  if (!log) return;
  const entry = document.createElement('div');
  entry.className = `log-entry log--${type}`;
  entry.textContent = text;
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
}

// ── Render ────────────────────────────────────────────────────
function renderAll() {
  renderHeader();
  renderPlayers();
  renderBidDisplay(lobby?.game_state?.currentBid, lobby?.game_state);
  renderYourDice(myDice);
  updateTurnUI(lobby?.game_state);
}

function renderHeader() {
  const gs = lobby?.game_state;
  document.getElementById('round-badge').textContent = gs?.round ? `Round ${gs.round}` : '—';
  const pB = document.getElementById('palafico-badge');
  if (gs?.palaficoActive) pB.classList.add('active');
  else pB.classList.remove('active');
}

function renderPlayers() {
  const gs  = lobby?.game_state;
  const row = document.getElementById('players-row');
  row.innerHTML = '';

  const order = gs?.playerOrder || players.map(p => p.id);
  const sorted = [...players].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

  sorted.forEach(player => {
    const isCurrentTurn = gs?.phase === 'bidding' &&
      gs.playerOrder?.[gs.currentPlayerIndex] === player.id;

    const card = document.createElement('div');
    card.className = ['player-card',
      isCurrentTurn ? 'current-turn' : '',
      player.id === myPlayerId ? 'is-me' : '',
      player.is_eliminated ? 'eliminated' : ''
    ].filter(Boolean).join(' ');
    card.dataset.playerId = player.id;
    card.style.borderColor = player.dice_color;
    card.style.boxShadow = `0 0 ${isCurrentTurn ? 22 : 8}px ${hexToRgba(player.dice_color, isCurrentTurn ? 0.6 : 0.25)}`;

    const miniPips = Array.from({ length: player.dice_count }, () =>
      `<div class="mini-pip" style="background:${player.dice_color}"></div>`
    ).join('');

    card.innerHTML = `
      ${player.id === myPlayerId ? '<div class="player-card__you-tag">You</div>' : ''}
      <div class="player-card__name">${escapeHtml(player.name)}</div>
      <div class="player-card__dice-count">${player.is_eliminated ? '☠ Eliminated' : `${player.dice_count} ${player.dice_count === 1 ? 'die' : 'dice'}`}</div>
      <div class="player-card__dice-pips">${miniPips}</div>
      <div class="player-card__turn-arrow">▼</div>
    `;
    row.appendChild(card);
  });
}

function renderBidDisplay(bid, gs) {
  const valEl = document.getElementById('bid-value');
  const byEl  = document.getElementById('bid-by');

  if (!bid) {
    valEl.innerHTML = '<span class="bid-display__no-bid">— No Bid Yet —</span>';
    byEl.textContent = '';
    return;
  }

  const prev = valEl.dataset.prev;
  valEl.innerHTML = `${bid.count} × ${FACE_UNICODE[bid.face]} <span style="font-size:1.4rem;font-weight:400">${FACE_NAME[bid.face]}</span>`;
  valEl.dataset.prev = JSON.stringify(bid);

  if (prev !== JSON.stringify(bid)) {
    valEl.classList.remove('updated');
    void valEl.offsetWidth; // reflow
    valEl.classList.add('updated');
  }

  const bidder = players.find(p => p.id === bid.playerId);
  byEl.textContent = bidder ? `by ${escapeHtml(bidder.name)}` : '';
}

function renderYourDice(dice) {
  if (!dice || !dice.length) return;
  const row = document.getElementById('your-dice-row');
  const gs  = lobby?.game_state;
  const bid = gs?.currentBid;
  const onesWild = lobby?.settings?.onesWild && lobby?.settings?.mode === 'perudo' && !gs?.palaficoActive;

  row.innerHTML = '';
  dice.forEach(val => {
    const hl = bid ? (val === bid.face || (onesWild && bid.face !== 1 && val === 1)) : false;
    row.insertAdjacentHTML('beforeend', makeDieHTML(val, myPlayer?.dice_color || '#c41e3a', {
      size: 60, highlight: hl
    }));
  });
}

function updateTurnUI(gs) {
  if (!gs) return;
  const phase = gs.phase;

  if (phase === 'rolling') {
    setTurnIndicator('rolling', '🎲 Rolling…');
    hideControls();
    return;
  }

  if (phase === 'bidding') {
    const mine = isMyTurn(gs);
    if (mine) {
      setTurnIndicator('my-turn', '⚡ Your Turn');
      showControls(gs);
    } else {
      const cp = getCurrentPlayer(gs);
      setTurnIndicator('other-turn', `${escapeHtml(cp?.name || '…')}'s turn`);
      hideControls();

      // Show skip button to host after timeout
      if (myPlayer?.is_host) {
        clearTimeout(skipTimer);
        skipTimer = setTimeout(() => {
          document.getElementById('skip-btn-wrap').classList.add('visible');
        }, 60000);
      }
    }
    return;
  }

  if (phase === 'challenge_called' || phase === 'revealing') {
    setTurnIndicator('rolling', '☠ Revealing…');
    hideControls();
    return;
  }

  if (phase === 'round_result') {
    setTurnIndicator('rolling', 'Round over…');
    hideControls();
    return;
  }
}

function showControls(gs) {
  document.getElementById('bid-controls').classList.remove('hidden');
  document.getElementById('waiting-panel').classList.add('hidden');
  document.getElementById('skip-btn-wrap').classList.remove('visible');
  clearTimeout(skipTimer);

  const hasBid = !!gs.currentBid;
  document.getElementById('liar-btn').classList.toggle('hidden', !hasBid);
  document.getElementById('spoton-btn').classList.toggle('hidden',
    !hasBid || !lobby?.settings?.spotOnEnabled);

  refreshBidInputs();
}

function hideControls() {
  document.getElementById('bid-controls').classList.add('hidden');
  document.getElementById('waiting-panel').classList.remove('hidden');
  document.getElementById('skip-btn-wrap').classList.remove('visible');
  clearTimeout(skipTimer);
}

function setTurnIndicator(type, text) {
  const el = document.getElementById('turn-indicator');
  el.className = `turn-indicator ${type}`;
  el.textContent = text;
}

// ── Utilities ─────────────────────────────────────────────────
function isMyTurn(gs) {
  if (!gs || gs.phase !== 'bidding') return false;
  return gs.playerOrder?.[gs.currentPlayerIndex] === myPlayerId;
}

function getCurrentPlayer(gs) {
  if (!gs?.playerOrder) return null;
  const id = gs.playerOrder[gs.currentPlayerIndex];
  return players.find(p => p.id === id) || null;
}

function playerName(id) {
  return escapeHtml(players.find(p => p.id === id)?.name || '?');
}

init();
