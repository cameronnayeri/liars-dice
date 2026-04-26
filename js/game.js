// ============================================================
//  Game page — full state machine
// ============================================================

const sb         = getSB();
const lobbyCode  = localStorage.getItem('lobbyCode');
const myPlayerId = localStorage.getItem('playerId');

let players          = [];
let lobby            = null;
let myPlayer         = null;
let myDice           = [];
let prevPhase        = null;
let waitingForReveal = false;
let broadcastChannel = null;
let skipTimer        = null;
let botTurnTimer     = null;

// Bid state
let bidCount = 1;
let bidFace  = 2;

// Bot constants
const BOT_NAMES   = ['Petrov','Volkov','Sokolov','Kozlov','Lebedev','Morozov','Novikov','Popov'];
const BOT_COLORS  = ['#8b1a1a','#1a4a8b','#2a6a2a','#6a2a8a','#8a6a1a','#1a6a6a','#8a3a1a','#4a1a6a'];

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
  if (!lobbyCode || !myPlayerId) { window.location.href = 'index.html'; return; }

  const stored = localStorage.getItem('myDice');
  if (stored) myDice = JSON.parse(stored);

  const [{ data: lobbyData }, { data: playerData }] = await Promise.all([
    sb.from('lobbies').select('*').eq('code', lobbyCode).maybeSingle(),
    sb.from('players').select('*').eq('lobby_code', lobbyCode).order('seat_order')
  ]);

  if (!lobbyData) { alert('Game not found'); window.location.href = 'index.html'; return; }

  lobby   = lobbyData;
  players = playerData || [];
  myPlayer = players.find(p => p.id === myPlayerId);
  if (!myPlayer) { alert('You are not in this game'); window.location.href = 'index.html'; return; }

  wireUI();
  subscribeToLobby();
  subscribeToPlayers();
  broadcastChannel = subscribeToBroadcast();

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
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'lobbies', filter: `code=eq.${lobbyCode}` },
      ({ new: updated }) => {
        if (!updated) return;
        const oldPhase   = lobby?.game_state?.phase;
        const oldIndex   = lobby?.game_state?.currentPlayerIndex;
        lobby = updated;
        handleGameStateChange(lobby.game_state, oldPhase);
        renderAll();

        // Re-trigger bot turn when bidding index advances (phase doesn't change)
        const gs = lobby.game_state;
        if (myPlayer?.is_host && gs?.phase === 'bidding' &&
            oldPhase === 'bidding' && gs.currentPlayerIndex !== oldIndex) {
          const currentId = gs.playerOrder?.[gs.currentPlayerIndex];
          if (isBotPlayer(currentId)) {
            clearTimeout(botTurnTimer);
            botTurnTimer = setTimeout(() => takeBotTurn(gs), 1200 + Math.random() * 1000);
          }
        }
      })
    .subscribe();
}
function subscribeToPlayers() {
  sb.channel(`game-${lobbyCode}-players`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: `lobby_code=eq.${lobbyCode}` },
      async () => {
        players  = await fetchPlayers();
        myPlayer = players.find(p => p.id === myPlayerId) || myPlayer;
        renderAll();
        checkAllDiceRevealed();
      })
    .subscribe();
}
function subscribeToBroadcast() {
  return sb.channel(`game-${lobbyCode}-broadcast`)
    .on('broadcast', { event: 'emote' }, ({ payload }) => receiveEmote(payload.playerId, payload.emote))
    .subscribe();
}

// ── Main state machine ────────────────────────────────────────
async function handleGameStateChange(gs, oldPhase) {
  if (!gs?.phase) return;
  const phase = gs.phase;
  if (phase === prevPhase) return;
  prevPhase = phase;
  switch (phase) {
    case 'rolling':          await enterRolling(gs); break;
    case 'bidding':          enterBidding(gs); break;
    case 'challenge_called': await enterChallengeCalled(gs); break;
    case 'revealing':        await enterRevealing(gs); break;
    case 'round_result':     await enterRoundResult(gs); break;
    case 'game_over':        enterGameOver(gs); break;
  }
}

// ── Phase: ROLLING ────────────────────────────────────────────
async function enterRolling(gs) {
  SoundEngine.newRound();
  addLog(`— Round ${gs.round} —`, 'system');

  document.getElementById('palafico-badge').classList.toggle('active', !!gs.palaficoActive);
  if (gs.palaficoActive) addLog('⚑ Palafico round — no wild ones', 'system');

  // Roll our dice
  const diceCount = myPlayer?.dice_count || lobby?.settings?.startingDice || 5;
  myDice = rollDice(diceCount);
  localStorage.setItem('myDice', JSON.stringify(myDice));

  // In dev mode, publish our dice immediately for visibility
  if (isDevMode()) {
    await sb.from('players').update({ revealed_dice: myDice }).eq('id', myPlayerId);
  }

  renderYourDice(myDice, true);
  setTurnIndicator('rolling', '🎲 Rolling dice…');

  // Host: roll for bots + advance to bidding
  if (myPlayer?.is_host) {
    await rollBotDice(gs);
    await delay(2200);
    const fresh = await fetchLobby();
    if (fresh?.game_state?.phase === 'rolling' && fresh.game_state.round === gs.round) {
      await updateGameState({ ...fresh.game_state, phase: 'bidding' });
    }
  }
}

// ── Phase: BIDDING ────────────────────────────────────────────
function enterBidding(gs) {
  document.getElementById('reveal-overlay').classList.remove('active');
  renderBidDisplay(gs.currentBid, gs);
  updateTurnUI(gs);

  // Reset default bid to one higher than current
  const cb = gs.currentBid;
  bidCount = cb ? cb.count + 1 : 1;
  bidFace  = cb ? cb.face : 2;
  refreshBidInputs();

  // Bot turn?
  if (myPlayer?.is_host) {
    clearTimeout(botTurnTimer);
    const currentId = gs.playerOrder?.[gs.currentPlayerIndex];
    if (isBotPlayer(currentId)) {
      botTurnTimer = setTimeout(() => takeBotTurn(gs), 1400 + Math.random() * 1400);
    }
  }
}

// ── Phase: CHALLENGE CALLED ───────────────────────────────────
async function enterChallengeCalled(gs) {
  const type = gs.challengeType;
  addLog(`${playerName(gs.challengerId)} called ${type === 'liar' ? '☠ LIAR' : '🎯 SPOT-ON'}!`,
    type === 'liar' ? 'challenge' : 'spoton');
  if (type === 'liar') SoundEngine.liar(); else SoundEngine.spotOnCall();

  setTurnIndicator('rolling', 'Revealing dice…');
  hideControls();

  await revealMyDice();

  if (myPlayer?.is_host) {
    // Submit dice for all bots
    await revealBotDice();
    waitingForReveal = true;
    setTimeout(checkAllDiceRevealed, 700);
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
  if (!allIn) return;

  waitingForReveal = false;
  const revealData = {};
  activePlayers.forEach(p => { revealData[p.id] = p.revealed_dice; });

  const gs = fresh.game_state;
  const onesWild = fresh.settings.onesWild && fresh.settings.mode === 'perudo' && !gs.palaficoActive;
  const actualCount = countFace(revealData, gs.currentBid.face, onesWild);
  const roundResult = buildRoundResult(gs, actualCount);

  await updateGameState({ ...gs, phase: 'revealing', revealData, roundResult });
}

function buildRoundResult(gs, actualCount) {
  const { currentBid: bid, challengerId, challengeType } = gs;
  const bidderId = bid.playerId;
  if (challengeType === 'liar') {
    return actualCount < bid.count
      ? { type: 'liar_correct', loserId: bidderId,    gainerId: null,       actualCount, bidCount: bid.count }
      : { type: 'liar_wrong',   loserId: challengerId, gainerId: null,       actualCount, bidCount: bid.count };
  } else {
    return actualCount === bid.count
      ? { type: 'spoton_correct', loserId: null,        gainerId: challengerId, actualCount, bidCount: bid.count }
      : { type: 'spoton_wrong',   loserId: challengerId, gainerId: null,        actualCount, bidCount: bid.count };
  }
}

// ── Phase: REVEALING ─────────────────────────────────────────
async function enterRevealing(gs) {
  const overlay    = document.getElementById('reveal-overlay');
  const titleEl    = document.getElementById('reveal-title');
  const playersEl  = document.getElementById('reveal-players');
  const tallyEl    = document.getElementById('reveal-tally');
  const resultEl   = document.getElementById('reveal-result');
  const hintEl     = document.getElementById('reveal-close-hint');

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
  const onesWild = lobby.settings.onesWild && lobby.settings.mode === 'perudo' && !palaficoActive;

  const order = gs.playerOrder || [];
  const activePlayers = players.filter(p => !p.is_eliminated)
    .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

  for (const player of activePlayers) {
    const dice = revealData?.[player.id] || [];

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
    await delay(300);

    const diceContainer = row.querySelector(`#reveal-dice-${player.id}`);

    // Show face-down first
    for (let i = 0; i < dice.length; i++) {
      diceContainer.insertAdjacentHTML('beforeend',
        makeDieHTML(1, player.dice_color, { faceDown: true, size: 54 }));
    }

    // Flip one at a time
    const dieEls = diceContainer.querySelectorAll('.die');
    for (let i = 0; i < dieEls.length; i++) {
      await delay(360);
      SoundEngine.flip();
      const val = dice[i];
      const isMatch = val === currentBid.face;
      const isWild  = onesWild && currentBid.face !== 1 && val === 1;

      dieEls[i].classList.remove('die--facedown');
      dieEls[i].classList.add('die--flipping');
      const pipColor = lightenHex(player.dice_color, 0.85);
      dieEls[i].innerHTML = (PIP_MAP[val] || PIP_MAP[1]).map(on =>
        `<div class="pip ${on ? 'pip--on' : 'pip--off'}" style="background:${pipColor}"></div>`
      ).join('');
      dieEls[i].dataset.value = val;

      if (isMatch || isWild) {
        await delay(150);
        SoundEngine.highlight();
        dieEls[i].classList.add('die--highlight');
      }
    }
    await delay(250);
  }

  // Tally
  await delay(550);
  const onesCount = onesWild ? countFace(revealData, 1, false) : 0;
  const faceCount = countFace(revealData, currentBid.face, false);
  const actual    = onesWild && currentBid.face !== 1 ? faceCount + onesCount : faceCount;

  document.getElementById('tally-bid-label').textContent =
    `Bid: ${currentBid.count} × ${FACE_UNICODE[currentBid.face]} ${FACE_NAME[currentBid.face]}`;
  if (onesWild && currentBid.face !== 1) {
    document.getElementById('tally-count').innerHTML =
      `<span class="actual">${actual} matching</span> <span class="needed"> (${faceCount} face + ${onesCount} wild) / needed ${currentBid.count}</span>`;
  } else {
    document.getElementById('tally-count').innerHTML =
      `<span class="actual">${actual} ${FACE_NAME[currentBid.face]}</span> <span class="needed"> / needed ${currentBid.count}</span>`;
  }
  tallyEl.classList.add('show');
  await delay(1100);

  // Result
  const rr = roundResult;
  const loser  = rr.loserId  ? players.find(p => p.id === rr.loserId)  : null;
  const gainer = rr.gainerId ? players.find(p => p.id === rr.gainerId) : null;

  let resultClass, headline, detail;
  if (rr.type === 'liar_correct') {
    SoundEngine.roundWin();
    resultClass = 'result--correct';
    headline    = 'The Lie Exposed!';
    detail      = `${escapeHtml(loser?.name || '?')} loses a die.`;
    addLog(`☠ Liar confirmed! ${loser?.name} loses a die.`, 'result');
  } else if (rr.type === 'liar_wrong') {
    SoundEngine.roundLose();
    resultClass = 'result--wrong';
    headline    = 'The Bid Holds!';
    detail      = `${escapeHtml(loser?.name || '?')} loses a die — the bid was true.`;
    addLog(`The bid held. ${loser?.name} loses a die.`, 'result');
  } else if (rr.type === 'spoton_correct') {
    SoundEngine.spotOnWin();
    resultClass = 'result--spoton-win';
    headline    = 'Spot On!';
    detail      = `${escapeHtml(gainer?.name || '?')} gains a die!`;
    addLog(`🎯 Spot-on! ${gainer?.name} gains a die.`, 'result');
  } else {
    SoundEngine.spotOnLose();
    resultClass = 'result--correct';
    headline    = 'Off The Mark!';
    detail      = `${escapeHtml(loser?.name || '?')} loses a die.`;
    addLog(`Spot-on missed. ${loser?.name} loses a die.`, 'result');
  }

  resultEl.className = `reveal-result ${resultClass}`;
  document.getElementById('result-headline').textContent = headline;
  document.getElementById('result-detail').textContent   = detail;
  await delay(200);
  resultEl.classList.add('show');
  await delay(2200);
  hintEl.style.display = 'block';

  // Host advances to round_result
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
  if (rr.gainerId) {
    const gainer = players.find(p => p.id === rr.gainerId);
    if (gainer && lobby.settings.spotOnEnabled) {
      const cap = lobby.settings.unlimitedDice ? 99 : lobby.settings.startingDice;
      const newCount = Math.min(cap, gainer.dice_count + 1);
      await sb.from('players').update({ dice_count: newCount }).eq('id', rr.gainerId);
    }
  }

  await sb.from('players').update({ revealed_dice: null }).eq('lobby_code', lobbyCode);

  players  = await fetchPlayers();
  myPlayer = players.find(p => p.id === myPlayerId) || myPlayer;

  const alive = players.filter(p => !p.is_eliminated);
  if (alive.length <= 1) {
    const winnerId = alive[0]?.id || null;
    await updateGameState({ ...gs, phase: 'game_over', winnerId });
    return;
  }

  await delay(1500);
  const fresh = await fetchLobby();
  if (fresh?.game_state?.phase === 'round_result') {
    await startNextRound(fresh.game_state, fresh.settings);
  }
}

async function startNextRound(gs, settings) {
  players = await fetchPlayers();
  const alive = players.filter(p => !p.is_eliminated);

  let firstId = gs.roundResult?.loserId || gs.roundResult?.gainerId;
  if (!firstId || !alive.find(p => p.id === firstId)) firstId = alive[0]?.id;

  let newOrder = buildPlayerOrder(alive, firstId);

  let palaficoActive = false, palaficoPlayerId = null;
  if (settings.palaficoEnabled && settings.mode === 'perudo') {
    const pal = alive.find(p => p.dice_count === 1);
    if (pal) {
      palaficoActive = true;
      palaficoPlayerId = pal.id;
      newOrder = buildPlayerOrder(alive, pal.id);
    }
  }

  await updateGameState({
    phase: 'rolling',
    round: gs.round + 1,
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
  const winner = players.find(p => p.id === gs.winnerId);
  const isMe   = gs.winnerId === myPlayerId;
  if (isMe) SoundEngine.gameWin(); else SoundEngine.gameLose();

  document.getElementById('gameover-winner').textContent = winner?.name || 'Unknown';
  document.getElementById('gameover-winner').style.color = winner?.dice_color || 'var(--red)';
  document.getElementById('gameover-overlay').classList.add('active');
  addLog(`🏆 ${winner?.name || '?'} wins the game!`, 'result');
}

// ── Player actions ────────────────────────────────────────────
async function submitBid() {
  const gs = lobby.game_state;
  if (!isMyTurn(gs)) return;

  const newBid = { count: bidCount, face: bidFace, playerId: myPlayerId };
  if (!isValidBid(newBid, gs.currentBid, lobby.settings, gs.palaficoActive || false)) {
    showBidError('Invalid bid — must be higher than the current bid');
    return;
  }
  hideBidError();
  SoundEngine.bid();

  const nextIndex = (gs.currentPlayerIndex + 1) % gs.playerOrder.length;
  await updateGameState({ ...gs, currentBid: newBid, currentPlayerIndex: nextIndex });
  addLog(`${escapeHtml(myPlayer.name)} bid ${describeBid(newBid)}`, 'bid');
}

async function callChallenge(type) {
  const gs = lobby.game_state;
  if (!isMyTurn(gs) || !gs.currentBid) return;
  hideControls();
  await updateGameState({ ...gs, phase: 'challenge_called', challengerId: myPlayerId, challengeType: type });
}

async function skipCurrentPlayer() {
  if (!myPlayer?.is_host) return;
  const gs = lobby.game_state;
  if (gs.phase !== 'bidding') return;
  const order = gs.playerOrder;
  showNotif(`Skipped ${playerName(order[gs.currentPlayerIndex])}`, 'info');
  await updateGameState({ ...gs, currentPlayerIndex: (gs.currentPlayerIndex + 1) % order.length });
}

// ── Bot system ────────────────────────────────────────────────
function getBotList()          { return JSON.parse(localStorage.getItem('botPlayers') || '[]'); }
function saveBotList(arr)      { localStorage.setItem('botPlayers', JSON.stringify(arr)); }
function getBotDice(id)        { return JSON.parse(localStorage.getItem(`botDice_${id}`) || '[]'); }
function saveBotDice(id, dice) { localStorage.setItem(`botDice_${id}`, JSON.stringify(dice)); }
function isBotPlayer(id)       { return getBotList().includes(id); }

async function addBot() {
  const gs = lobby?.game_state;
  if (!myPlayer?.is_host) return showNotif('Only the host can add bots', 'error');

  const activeBotCount = getBotList().filter(id => players.find(p => p.id === id && !p.is_eliminated)).length;
  if (players.length >= (lobby?.settings?.maxPlayers || 8)) return showNotif('Lobby is full', 'error');

  // Pick unused name/color
  const usedNames = players.map(p => p.name);
  const availableNames = BOT_NAMES.filter(n => !usedNames.includes(`Bot ${n}`));
  const name  = availableNames.length ? `Bot ${availableNames[0]}` : `Bot ${activeBotCount + 1}`;
  const color = BOT_COLORS[activeBotCount % BOT_COLORS.length];

  const usedSeats = players.map(p => p.seat_order);
  let seat = 0;
  while (usedSeats.includes(seat)) seat++;

  const startDice = lobby.settings.startingDice;
  const botId = generateId();

  const { error } = await sb.from('players').insert({
    id: botId,
    lobby_code: lobbyCode,
    name,
    dice_color: color,
    seat_order: seat,
    is_host: false,
    dice_count: startDice,
    is_eliminated: false,
    last_seen: new Date().toISOString()
  });
  if (error) { showNotif('Failed to add bot'); return; }

  const bots = getBotList();
  bots.push(botId);
  SoundEngine.join();
  saveBotList(bots);

  // If game is running, add to playerOrder
  if (gs?.phase === 'bidding' || gs?.phase === 'rolling') {
    const fresh = await fetchLobby();
    if (fresh) {
      const updatedOrder = [...(fresh.game_state.playerOrder || []), botId];
      await updateGameState({ ...fresh.game_state, playerOrder: updatedOrder });
    }
  }

  showNotif(`${name} joined`, 'success');
  renderDevPanel();
}

async function removeBot(botId) {
  await sb.from('players').delete().eq('id', botId);
  const bots = getBotList().filter(id => id !== botId);
  saveBotList(bots);
  localStorage.removeItem(`botDice_${botId}`);
  renderDevPanel();
}

async function rollBotDice(gs) {
  const bots = getBotList();
  for (const botId of bots) {
    const bot = players.find(p => p.id === botId && !p.is_eliminated);
    if (!bot) continue;
    const dice = rollDice(bot.dice_count);
    saveBotDice(botId, dice);
    if (isDevMode()) {
      await sb.from('players').update({ revealed_dice: dice }).eq('id', botId);
    }
  }
}

async function revealBotDice() {
  const bots = getBotList();
  for (const botId of bots) {
    const bot = players.find(p => p.id === botId && !p.is_eliminated);
    if (!bot) continue;
    const dice = getBotDice(botId);
    if (dice.length) {
      await sb.from('players').update({ revealed_dice: dice }).eq('id', botId);
    }
  }
}

async function takeBotTurn(gs) {
  // Re-check phase is still bidding and it's still this bot's turn
  const fresh = await fetchLobby();
  if (!fresh || fresh.game_state.phase !== 'bidding') return;
  const currentId = fresh.game_state.playerOrder?.[fresh.game_state.currentPlayerIndex];
  if (!isBotPlayer(currentId)) return;

  const botDice   = getBotDice(currentId);
  const bot       = players.find(p => p.id === currentId);
  const cb        = fresh.game_state.currentBid;
  const settings  = fresh.settings;
  const palafico  = fresh.game_state.palaficoActive || false;

  // Total dice on the table
  const totalDice = players.filter(p => !p.is_eliminated).reduce((s, p) => s + p.dice_count, 0);

  // Decide: call liar or bid?
  if (cb && shouldBotCallLiar(cb, botDice, totalDice, settings, palafico)) {
    await updateGameState({
      ...fresh.game_state,
      phase: 'challenge_called',
      challengerId: currentId,
      challengeType: 'liar'
    });
    addLog(`${playerName(currentId)} called ☠ LIAR!`, 'challenge');
    return;
  }

  const newBid = getBotBid(bot, cb, totalDice, settings, palafico, botDice);
  const nextIndex = (fresh.game_state.currentPlayerIndex + 1) % fresh.game_state.playerOrder.length;
  await updateGameState({
    ...fresh.game_state,
    currentBid: { ...newBid, playerId: currentId },
    currentPlayerIndex: nextIndex
  });
  addLog(`${playerName(currentId)} bid ${describeBid(newBid)}`, 'bid');
}

function shouldBotCallLiar(bid, botDice, totalDice, settings, palafico) {
  if (!bid) return false;
  const onesWild = settings.onesWild && settings.mode === 'perudo' && !palafico;
  const prob = onesWild && bid.face !== 1 ? 2/6 : 1/6;
  const expected = totalDice * prob;
  // Call liar if bid is way over expected, scaled by aggression
  const aggressionFactor = 1.4;
  return bid.count > expected * aggressionFactor && Math.random() < 0.65;
}

function getBotBid(bot, currentBid, totalDice, settings, palafico, botDice) {
  if (!currentBid) {
    // First bid: bid something reasonable based on own dice
    const faceCounts = [0,0,0,0,0,0,0];
    botDice.forEach(d => faceCounts[d]++);
    // Find most common face
    let bestFace = 2, bestCount = 0;
    for (let f = 2; f <= 6; f++) {
      let cnt = faceCounts[f];
      if (settings.onesWild && settings.mode === 'perudo' && !palafico) cnt += faceCounts[1];
      if (cnt > bestCount) { bestCount = cnt; bestFace = f; }
    }
    const count = Math.max(1, Math.round(bestCount * 1.2 + Math.random()));
    return { count, face: bestFace };
  }

  // Try to raise count on same face
  const raisedCount = { count: currentBid.count + 1, face: currentBid.face };
  if (isValidBid(raisedCount, currentBid, settings, palafico)) {
    if (Math.random() < 0.7) return raisedCount;
  }

  // Try higher face same count
  for (let f = currentBid.face + 1; f <= 6; f++) {
    const bid = { count: currentBid.count, face: f };
    if (isValidBid(bid, currentBid, settings, palafico)) return bid;
  }

  // Fall back to +1 count any face
  return raisedCount;
}

// ── Dev mode ──────────────────────────────────────────────────
function isDevMode() {
  return document.getElementById('dev-panel').classList.contains('open');
}

function toggleDevPanel() {
  const panel  = document.getElementById('dev-panel');
  const btn    = document.getElementById('dev-toggle');
  const open   = panel.classList.toggle('open');
  btn.classList.toggle('active', open);
  if (open) renderDevPanel();
}

function renderDevPanel() {
  if (!isDevMode()) return;

  // Update unlimited dice status
  const ulStatus = document.getElementById('dev-unlimited-status');
  if (ulStatus) ulStatus.textContent = lobby?.settings?.unlimitedDice ? 'ON' : 'OFF';

  // Dice display
  const diceDisplay = document.getElementById('dev-dice-display');
  if (diceDisplay) {
    diceDisplay.innerHTML = '';

    // My dice
    const myRow = document.createElement('div');
    myRow.className = 'dev-dice-row';
    myRow.innerHTML = `<span class="dev-dice-name">${escapeHtml(myPlayer?.name || 'You')}</span>`;
    myDice.forEach(val => {
      myRow.insertAdjacentHTML('beforeend', makeDieHTML(val, myPlayer?.dice_color || '#c41e3a', { size: 32 }));
    });
    diceDisplay.appendChild(myRow);

    // Bot dice
    getBotList().forEach(botId => {
      const bot  = players.find(p => p.id === botId);
      if (!bot || bot.is_eliminated) return;
      const dice = getBotDice(botId);
      const row  = document.createElement('div');
      row.className = 'dev-dice-row';
      row.innerHTML = `<span class="dev-dice-name">${escapeHtml(bot.name)}</span>`;
      if (dice.length) {
        dice.forEach(val => row.insertAdjacentHTML('beforeend', makeDieHTML(val, bot.dice_color, { size: 32 })));
      } else {
        row.insertAdjacentHTML('beforeend', `<span class="dev-dice-hidden">not yet rolled</span>`);
      }
      diceDisplay.appendChild(row);
    });

    // Human players (not self, not bots)
    players.filter(p => p.id !== myPlayerId && !isBotPlayer(p.id) && !p.is_eliminated).forEach(p => {
      const row = document.createElement('div');
      row.className = 'dev-dice-row';
      row.innerHTML = `<span class="dev-dice-name">${escapeHtml(p.name)}</span><span class="dev-dice-hidden">hidden (human)</span>`;
      diceDisplay.appendChild(row);
    });
  }

  // Bot list
  const botList = document.getElementById('bot-list');
  if (botList) {
    botList.innerHTML = '';
    getBotList().forEach(botId => {
      const bot = players.find(p => p.id === botId);
      if (!bot) return;
      const entry = document.createElement('div');
      entry.className = 'bot-entry';
      entry.innerHTML = `
        <span class="bot-entry__name" style="color:${bot.dice_color}">${escapeHtml(bot.name)}</span>
        <button class="btn--dev-remove" onclick="removeBot('${botId}')">Remove</button>
      `;
      botList.appendChild(entry);
    });
    if (!getBotList().length) {
      botList.innerHTML = '<div style="font-size:0.78rem;color:var(--text-muted)">No bots added</div>';
    }
  }
}

// ── Bid UI helpers ────────────────────────────────────────────
function refreshBidInputs() {
  document.getElementById('count-val').textContent = bidCount;
  document.querySelectorAll('.face-btn').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.face) === bidFace);
  });
}
function showBidError(msg) {
  const el = document.getElementById('bid-error');
  el.textContent = msg; el.classList.remove('hidden');
}
function hideBidError() { document.getElementById('bid-error').classList.add('hidden'); }

// ── UI wiring ─────────────────────────────────────────────────
function wireUI() {
  document.getElementById('count-dec').addEventListener('click', () => {
    if (bidCount > 1) { bidCount--; refreshBidInputs(); }
  });
  document.getElementById('count-inc').addEventListener('click', () => {
    const total = players.filter(p => !p.is_eliminated).reduce((s, p) => s + p.dice_count, 0);
    if (bidCount < Math.max(total, 40)) { bidCount++; refreshBidInputs(); }
  });
  document.getElementById('face-selector').addEventListener('click', e => {
    const btn = e.target.closest('.face-btn');
    if (btn) { bidFace = parseInt(btn.dataset.face); refreshBidInputs(); }
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
  document.getElementById('back-lobby-btn').addEventListener('click', () => { window.location.href = 'lobby.html'; });
  document.getElementById('emote-picker').addEventListener('click', async e => {
    const btn = e.target.closest('.emote-btn');
    if (!btn) return;
    const emote = btn.dataset.emote;
    document.getElementById('emote-picker').style.display = 'none';
    SoundEngine.emote();
    addLog(`${emote} ${escapeHtml(myPlayer?.name || 'You')}`, 'emote');
    showEmote(myPlayerId, emote);
    broadcastChannel?.send({ type: 'broadcast', event: 'emote', payload: { playerId: myPlayerId, emote } });
  });

  // Volume slider
  const volSlider = document.getElementById('volume-slider');
  const volIcon   = document.getElementById('vol-icon');
  volSlider.addEventListener('input', () => {
    const v = parseInt(volSlider.value) / 100;
    SoundEngine.setVolume(v);
    volIcon.textContent = v === 0 ? '🔇' : v < 0.4 ? '🔉' : '🔊';
  });

  // Dev panel
  document.getElementById('dev-toggle').addEventListener('click', toggleDevPanel);
  document.getElementById('dev-close').addEventListener('click', toggleDevPanel);
  document.getElementById('add-bot-btn').addEventListener('click', addBot);
}

// ── Emotes ────────────────────────────────────────────────────
function receiveEmote(playerId, emote) {
  if (playerId === myPlayerId) return;
  const player = players.find(p => p.id === playerId);
  SoundEngine.emote();
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
  renderTablePlayers();
  renderBidDisplay(lobby?.game_state?.currentBid, lobby?.game_state);
  renderYourDice(myDice);
  updateTurnUI(lobby?.game_state);
  if (isDevMode()) renderDevPanel();
}

function renderHeader() {
  const gs = lobby?.game_state;
  document.getElementById('round-badge').textContent = gs?.round ? `Round ${gs.round}` : '—';
  document.getElementById('palafico-badge').classList.toggle('active', !!gs?.palaficoActive);
}

// ── Circular table render ─────────────────────────────────────
function renderTablePlayers() {
  const gs        = lobby?.game_state;
  const container = document.getElementById('table-players');
  const tableEl   = document.getElementById('game-table');
  if (!container || !tableEl) return;
  container.innerHTML = '';

  const W  = tableEl.offsetWidth  || 640;
  const H  = tableEl.offsetHeight || 420;
  const cx = W / 2;
  const cy = H / 2;
  // Ellipse radii (leave room for ~65px-wide cards on each side)
  const rx = (W / 2) - 72;
  const ry = (H / 2) - 56;

  const order  = gs?.playerOrder || players.map(p => p.id);
  const sorted = [...players].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const n      = sorted.length;

  let activeAngle = null;

  sorted.forEach((player, i) => {
    const angle = (i / n) * 2 * Math.PI - Math.PI / 2; // start top, clockwise
    const x = cx + rx * Math.cos(angle);
    const y = cy + ry * Math.sin(angle);

    const isCurrentTurn = gs?.phase === 'bidding' &&
      gs.playerOrder?.[gs.currentPlayerIndex] === player.id;
    const isActive = n <= 1 || isCurrentTurn;

    if (isCurrentTurn) activeAngle = angle;

    const card = document.createElement('div');
    card.className = [
      'table-player-card',
      player.id === myPlayerId  ? 'tpc--me' : '',
      isCurrentTurn             ? 'tpc--active' : '',
      !isCurrentTurn && n > 1 && gs?.phase === 'bidding' ? 'tpc--inactive' : '',
      player.is_eliminated      ? 'tpc--eliminated' : ''
    ].filter(Boolean).join(' ');
    card.dataset.playerId = player.id;
    card.style.left       = `${x}px`;
    card.style.top        = `${y}px`;
    card.style.borderColor = player.dice_color;
    card.style.boxShadow   = `0 0 ${isCurrentTurn ? 24 : 8}px ${hexToRgba(player.dice_color, isCurrentTurn ? 0.7 : 0.3)}`;

    const miniPips = Array.from({ length: player.dice_count }, () =>
      `<div class="tpc__pip" style="background:${player.dice_color}"></div>`
    ).join('');

    card.innerHTML = `
      ${player.id === myPlayerId ? '<div class="tpc__you">You</div>' : ''}
      <div class="tpc__name">${escapeHtml(player.name)}${isBotPlayer(player.id) ? ' 🤖' : ''}</div>
      <div class="tpc__dice-count">${player.is_eliminated ? '☠ Out' : `${player.dice_count} ${player.dice_count === 1 ? 'die' : 'dice'}`}</div>
      <div class="tpc__pips">${miniPips}</div>
      ${isCurrentTurn ? `<div class="tpc__turn-indicator" style="color:${player.dice_color}">▲ their turn</div>` : ''}
    `;
    container.appendChild(card);
  });

  // Update spotlight
  updateSpotlight(activeAngle);
}

function updateSpotlight(angle) {
  const beam = document.getElementById('spotlight-beam');
  if (!beam) return;
  if (angle === null) { beam.style.background = 'none'; return; }

  // Convert math angle (radians, +x right) to CSS conic angle (degrees, clockwise from top)
  const cssDeg = ((angle * 180 / Math.PI) + 90 + 360) % 360;
  const hw = 22; // half-width of beam in degrees
  beam.style.background = `conic-gradient(
    from ${cssDeg - hw - 3}deg at 50% 50%,
    transparent          0deg,
    rgba(255,210,80,0.04) ${3}deg,
    rgba(255,210,80,0.09) ${hw}deg,
    rgba(255,210,80,0.04) ${hw + 3}deg,
    transparent          ${hw * 2 + 6}deg,
    transparent          360deg
  )`;
}

function renderBidDisplay(bid, gs) {
  const valEl = document.getElementById('bid-value');
  const byEl  = document.getElementById('bid-by');
  if (!bid) {
    valEl.innerHTML = '<span class="bid-display__no-bid">— No Bid —</span>';
    byEl.textContent = '';
    return;
  }
  const prev = valEl.dataset.prev;
  const newStr = JSON.stringify(bid);
  valEl.innerHTML = `${bid.count} × ${FACE_UNICODE[bid.face]} <span style="font-size:1.1rem;font-weight:400">${FACE_NAME[bid.face]}</span>`;
  valEl.dataset.prev = newStr;
  if (prev !== newStr) {
    valEl.classList.remove('updated'); void valEl.offsetWidth; valEl.classList.add('updated');
  }
  const bidder = players.find(p => p.id === bid.playerId);
  byEl.textContent = bidder ? `by ${escapeHtml(bidder.name)}` : '';
}

function renderYourDice(dice, animate = false) {
  if (!dice?.length) return;
  const row = document.getElementById('your-dice-row');
  const gs  = lobby?.game_state;
  const bid = gs?.currentBid;
  const onesWild = lobby?.settings?.onesWild && lobby?.settings?.mode === 'perudo' && !gs?.palaficoActive;

  row.innerHTML = '';
  dice.forEach(val => {
    const hl = bid ? (val === bid.face || (onesWild && bid.face !== 1 && val === 1)) : false;
    row.insertAdjacentHTML('beforeend', makeDieHTML(val, myPlayer?.dice_color || '#c41e3a', {
      size: 60, highlight: hl, animating: animate
    }));
  });
}

function updateTurnUI(gs) {
  if (!gs) return;
  const phase = gs.phase;

  if (phase === 'rolling') {
    setTurnIndicator('rolling', '🎲 Rolling…');
    hideControls(); return;
  }
  if (phase === 'bidding') {
    const mine = isMyTurn(gs);
    if (mine) {
      setTurnIndicator('my-turn', '⚡ Your Turn — make your move');
      showControls(gs);
    } else {
      const cp = getCurrentPlayer(gs);
      setTurnIndicator('other-turn', `${escapeHtml(cp?.name || '…')}'s turn`);
      hideControls();
      if (myPlayer?.is_host) {
        clearTimeout(skipTimer);
        skipTimer = setTimeout(() => document.getElementById('skip-btn-wrap').classList.add('visible'), 10000);
      }
    }
    return;
  }
  if (phase === 'challenge_called' || phase === 'revealing') {
    setTurnIndicator('rolling', '☠ Revealing…'); hideControls(); return;
  }
  if (phase === 'round_result') {
    setTurnIndicator('rolling', 'Round over…'); hideControls(); return;
  }
}

function showControls(gs) {
  document.getElementById('bid-controls').classList.remove('hidden');
  document.getElementById('waiting-panel').classList.add('hidden');
  document.getElementById('skip-btn-wrap').classList.remove('visible');
  clearTimeout(skipTimer);
  const hasBid = !!gs.currentBid;
  document.getElementById('liar-btn').classList.toggle('hidden', !hasBid);
  document.getElementById('spoton-btn').classList.toggle('hidden', !hasBid || !lobby?.settings?.spotOnEnabled);
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
function isMyTurn(gs)       { return gs?.phase === 'bidding' && gs.playerOrder?.[gs.currentPlayerIndex] === myPlayerId; }
function getCurrentPlayer(gs) {
  if (!gs?.playerOrder) return null;
  return players.find(p => p.id === gs.playerOrder[gs.currentPlayerIndex]) || null;
}
function playerName(id)     { return escapeHtml(players.find(p => p.id === id)?.name || '?'); }

init();
