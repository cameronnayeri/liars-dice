// ============================================================
//  Procedural sound engine — Web Audio API, no files needed
// ============================================================
const SoundEngine = (() => {
  let ctx = null;
  let _enabled = true;

  function ctx_() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(freq, type, dur, vol, start = 0) {
    const c = ctx_();
    const osc  = c.createOscillator();
    const gain = c.createGain();
    const now  = c.currentTime + start;
    osc.connect(gain);
    gain.connect(c.destination);
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(vol, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.start(now);
    osc.stop(now + dur + 0.05);
  }

  function noise(dur, vol, freq = 1000, q = 0.5) {
    const c = ctx_();
    const buf  = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src  = c.createBufferSource();
    src.buffer = buf;
    const filt = c.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.value = freq;
    filt.Q.value = q;
    const gain = c.createGain();
    gain.gain.setValueAtTime(vol, c.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    src.connect(filt); filt.connect(gain); gain.connect(c.destination);
    src.start(); src.stop(c.currentTime + dur);
  }

  return {
    toggle()    { _enabled = !_enabled; return _enabled; },
    isEnabled() { return _enabled; },

    roll() {
      if (!_enabled) return;
      noise(0.22, 0.25, 900, 0.4);
      for (let i = 0; i < 5; i++)
        tone(150 + Math.random() * 120, 'square', 0.06, 0.12, i * 0.045);
    },

    bid() {
      if (!_enabled) return;
      tone(160, 'sine', 0.18, 0.28);
      tone(220, 'sine', 0.12, 0.16, 0.09);
    },

    liar() {
      if (!_enabled) return;
      tone(440, 'sawtooth', 0.25, 0.32);
      tone(330, 'sawtooth', 0.3,  0.28, 0.14);
      tone(220, 'sawtooth', 0.45, 0.30, 0.28);
      noise(0.35, 0.14, 180);
    },

    spotOnCall() {
      if (!_enabled) return;
      tone(660, 'triangle', 0.2, 0.3);
      tone(880, 'triangle', 0.2, 0.25, 0.1);
    },

    flip() {
      if (!_enabled) return;
      tone(500 + Math.random() * 300, 'square', 0.07, 0.18);
    },

    highlight() {
      if (!_enabled) return;
      tone(900, 'sine', 0.18, 0.12);
    },

    roundWin() {
      if (!_enabled) return;
      [330, 440, 550, 660].forEach((f, i) => tone(f, 'sine', 0.28, 0.2, i * 0.09));
    },

    roundLose() {
      if (!_enabled) return;
      [330, 294, 247, 220].forEach((f, i) => tone(f, 'sawtooth', 0.32, 0.22, i * 0.12));
    },

    spotOnWin() {
      if (!_enabled) return;
      [523, 659, 784, 1047].forEach((f, i) => tone(f, 'sine', 0.35, 0.22, i * 0.08));
    },

    gameWin() {
      if (!_enabled) return;
      [262, 330, 392, 523, 659, 784].forEach((f, i) => tone(f, 'sine', 0.5, 0.28, i * 0.1));
    },

    gameLose() {
      if (!_enabled) return;
      [330, 277, 247, 220, 196].forEach((f, i) => tone(f, 'sawtooth', 0.55, 0.22, i * 0.18));
    },

    emote() {
      if (!_enabled) return;
      tone(800, 'sine', 0.09, 0.08);
    },

    newRound() {
      if (!_enabled) return;
      tone(220, 'triangle', 0.25, 0.18);
      tone(330, 'triangle', 0.2,  0.14, 0.12);
    }
  };
})();
