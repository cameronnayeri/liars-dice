// ============================================================
//  File-based sound engine with RMS normalization
// ============================================================
const SoundEngine = (() => {
  let ctx = null;
  let masterGain = null;
  let masterVolume = 0.25;
  const loaded = {};

  // Sound file → event mapping
  const FILES = {
    roll:       'sounds/roll.wav',
    newRound:   'sounds/round start.wav',
    bid:        'sounds/general click sfx.wav',
    flip:       'sounds/1 off.wav',
    highlight:  'sounds/2 off.wav',
    liar:       'sounds/se_sys_decision.ogg',
    spotOnCall: 'sounds/big-shot.wav',
    roundWin:   'sounds/CORRECT.wav',
    roundLose:  'sounds/WRONG.wav',
    spotOnWin:  'sounds/se_gen_red_ok.ogg',
    spotOnLose: 'sounds/bad.wav',
    gameWin:    'sounds/you-win.wav',
    gameLose:   'sounds/loser.wav',
    emote:      'sounds/se_sys_cancel.ogg',
    join:       'sounds/lobby join.wav',
    uhOh:       'sounds/uh_oh.ogg',
  };

  // Target RMS level — all sounds normalised to this
  const TARGET_RMS = 0.05;

  function getCtx() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = ctx.createGain();
      masterGain.gain.value = masterVolume;
      masterGain.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function computeRMS(audioBuffer) {
    let sumSq = 0, total = 0;
    for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
      const data = audioBuffer.getChannelData(ch);
      for (let i = 0; i < data.length; i++) { sumSq += data[i] * data[i]; total++; }
    }
    return total > 0 ? Math.sqrt(sumSq / total) : 1;
  }

  async function load(name) {
    if (loaded[name]) return;
    try {
      const c    = getCtx();
      const res  = await fetch(FILES[name]);
      const buf  = await res.arrayBuffer();
      const decoded = await c.decodeAudioData(buf);
      const rms  = computeRMS(decoded);
      const normalizeGain = rms > 0.001 ? TARGET_RMS / rms : 1;
      loaded[name] = { buffer: decoded, gain: Math.min(normalizeGain, 8) }; // cap gain at 8×
    } catch (e) {
      console.warn(`SoundEngine: could not load "${name}"`, e);
      loaded[name] = null;
    }
  }

  // Pre-load all sounds on first user interaction
  let preloaded = false;
  function preloadAll() {
    if (preloaded) return;
    preloaded = true;
    Object.keys(FILES).forEach(name => load(name));
  }
  document.addEventListener('click', preloadAll, { once: true });
  document.addEventListener('keydown', preloadAll, { once: true });

  function play(name, extraGain = 1) {
    const s = loaded[name];
    if (!s) { load(name); return; } // try loading if missed
    const c = getCtx();
    const src  = c.createBufferSource();
    src.buffer = s.buffer;
    const gain = c.createGain();
    gain.gain.value = s.gain * extraGain;
    src.connect(gain);
    gain.connect(masterGain);
    src.start();
  }

  return {
    setVolume(v) {
      masterVolume = Math.max(0, Math.min(1, v));
      if (masterGain) masterGain.gain.value = masterVolume;
    },
    getVolume() { return masterVolume; },

    roll()       { play('roll'); },
    newRound()   { play('newRound'); },
    bid()        { play('bid', 0.9); },
    flip()       { play('flip', 1.1); },
    highlight()  { play('highlight'); },
    liar()       { play('liar'); },
    spotOnCall() { play('spotOnCall'); },
    roundWin()   { play('roundWin'); },
    roundLose()  { play('roundLose'); },
    spotOnWin()  { play('spotOnWin'); },
    spotOnLose() { play('spotOnLose'); },
    gameWin()    { play('gameWin'); },
    gameLose()   { play('gameLose'); },
    emote()      { play('emote', 0.6); },
    join()       { play('join'); },
    uhOh()       { play('uhOh'); },
  };
})();
