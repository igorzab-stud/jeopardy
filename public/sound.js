// Game sounds: real clips from JParty (public/sounds/*.wav) +
// synthesized fallback for moments JParty has no clip for (buzzer, wrong, blips).
// Works offline on LAN — files are served by our own server.
(function () {
  const FILES = {
    theme: '/sounds/intro.wav',       // 3-min theme, looped while waiting (JParty welcome screen)
    boardFill: '/sounds/board_fill.wav', // board loads a round
    dd: '/sounds/dd.wav',              // Daily Double jingle
    applause: '/sounds/applause.wav', // correct answer (JParty: DD correct)
    stumped: '/sounds/stumped.wav',   // question timer expired, nobody got it
    final: '/sounds/final.wav',        // Final Jeopardy think music (32s)
  };

  let muted = localStorage.getItem('j_muted') === '1';
  const els = {}; // name -> HTMLAudioElement (lazy)

  function el(name) {
    if (!els[name]) {
      const a = new Audio(FILES[name]);
      a.preload = 'auto';
      a.muted = muted;
      els[name] = a;
    }
    return els[name];
  }
  // Unlock audio on first user gesture (browser autoplay policy)
  window.addEventListener('pointerdown', function unlock() {
    Object.keys(FILES).forEach((n) => { try { el(n).load(); } catch {} });
    try { ac().resume(); } catch {}
    window.removeEventListener('pointerdown', unlock);
  });

  function playFile(name, { loop = false } = {}) {
    if (muted) return;
    try {
      const a = el(name);
      a.loop = loop;
      a.currentTime = 0;
      const p = a.play();
      if (p && p.catch) p.catch(() => {});
    } catch {}
  }
  function stopFile(name) {
    try { const a = els[name]; if (a) { a.pause(); a.currentTime = 0; } } catch {}
  }
  function applyMute() {
    Object.values(els).forEach((a) => (a.muted = muted));
  }

  // ---------- synthesized bits (JParty has no clips for these) ----------
  let ctx = null;
  function ac() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function tone(freq, t0, dur, type = 'square', vol = 0.2, slideTo = null) {
    if (muted) return;
    try {
      const c = ac(), o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, c.currentTime + t0);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, c.currentTime + t0 + dur);
      g.gain.setValueAtTime(vol, c.currentTime + t0);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + t0 + dur);
      o.connect(g).connect(c.destination);
      o.start(c.currentTime + t0); o.stop(c.currentTime + t0 + dur + 0.05);
    } catch {}
  }

  const synth = {
    buzz() {
      // Classic game-show "BZZZT": harsh low square/saw stack with fast tremolo.
      // (JParty ships no buzzer clip at all, so this one is all ours.)
      if (muted) return;
      try {
        const c = ac(), t = c.currentTime, DUR = 0.85;
        const g = c.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.4, t + 0.02);
        g.gain.setValueAtTime(0.4, t + DUR - 0.08);
        g.gain.exponentialRampToValueAtTime(0.001, t + DUR);
        // tremolo: 27Hz LFO chops the gain = the "rattle"
        const lfo = c.createOscillator(); lfo.type = 'square'; lfo.frequency.value = 27;
        const lg = c.createGain(); lg.gain.value = 0.22;
        lfo.connect(lg).connect(g.gain);
        const o1 = c.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 164;
        const o2 = c.createOscillator(); o2.type = 'square'; o2.frequency.value = 82;
        const o3 = c.createOscillator(); o3.type = 'square'; o3.frequency.value = 165.5; // beating
        const g2 = c.createGain(); g2.gain.value = 0.4; // tame the harshest osc
        o1.connect(g); o2.connect(g); o3.connect(g2).connect(g);
        g.connect(c.destination);
        [lfo, o1, o2, o3].forEach((o) => { o.start(t); o.stop(t + DUR + 0.05); });
      } catch {}
    },
    bell(freq, t0, dur = 0.7, vol = 0.22) {
      if (muted) return;
      try {
        const c = ac(), t = c.currentTime + t0;
        const o = c.createOscillator(); o.type = 'triangle'; o.frequency.value = freq;
        const o2 = c.createOscillator(); o2.type = 'sine'; o2.frequency.value = freq * 2; // shimmer
        const g = c.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        const g2 = c.createGain(); g2.gain.value = 0.25;
        o.connect(g); o2.connect(g2).connect(g); g.connect(c.destination);
        [o, o2].forEach((x) => { x.start(t); x.stop(t + dur + 0.05); });
      } catch {}
    },
    correct() {
      // Bright "ding-ding — correct!": two chimes + rising sparkle.
      const self = this;
      [880, 1174.66].forEach((f, i) => self.bell(f, i * 0.17, 0.8, 0.25));
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => self.bell(f, 0.38 + i * 0.09, 0.6, 0.14));
    },
    wrong() { tone(220, 0, 0.25, 'sawtooth', 0.3); tone(155, 0.22, 0.5, 'sawtooth', 0.3); },
    tile() { tone(660, 0, 0.12, 'square', 0.2); tone(880, 0.1, 0.18, 'square', 0.2); },
    reveal() { [392, 523, 659].forEach((f, i) => tone(f, i * 0.09, 0.3, 'sine', 0.3)); },
    join() { tone(784, 0, 0.15, 'sine', 0.25); tone(1047, 0.12, 0.2, 'sine', 0.25); },
    thinkFallback(seconds = 30) {
      const notes = [262, 294, 330, 262, 392, 370, 330, 294];
      let step = 0;
      const iv = setInterval(() => {
        if (muted) { clearInterval(iv); return; }
        const f = notes[step % notes.length];
        tone(f, 0, 0.4, 'triangle', 0.22); tone(f / 2, 0, 0.4, 'sine', 0.15);
        step++;
      }, 500);
      setTimeout(() => clearInterval(iv), seconds * 1000);
    },
  };

  // ---------- event routing ----------
  function handleEvent(event) {
    if (muted) return;
    switch (event) {
      case 'buzz_win': synth.buzz(); break;             // real game-show BZZZT (synth)
      case 'correct': synth.correct(); break;           // synthesized correct chime
      case 'applause': playFile('applause'); break;     // soundboard only
      case 'wrong': synth.wrong(); break;
      case 'tile_open': synth.tile(); break;
      case 'buzz_open': synth.tile(); break;
      case 'board_reset': playFile('boardFill'); break;
      case 'reveal_answer': synth.reveal(); break;
      case 'times_up': playFile('stumped'); break;      // question timeout, nobody answered
      case 'player_join': synth.join(); break;
      case 'dd': playFile('dd'); break;                  // daily-double jingle on open
      case 'dd_player': synth.tile(); break;              // host picked the DD player
      case 'wager_set': synth.reveal(); break;            // wager locked in
      case 'think': thinkMusic(); break;                 // soundboard: final-jeopardy music
      case 'theme_toggle': toggleTheme(); break;        // soundboard: theme on/off
      case 'show_start': themeStart(); break;           // opening parade: theme loops
      case 'show_done': stopMusic(); playFile('boardFill'); break; // values fill in
      default:
        if (synth[event]) synth[event]();
    }
  }

  // Theme song (intro.wav, looped like JParty's welcome screen)
  let themeOn = false;
  function themeStart() {
    if (themeOn || muted) return themeOn;
    stopFile('final');
    playFile('theme', { loop: true });
    themeOn = true;
    return true;
  }
  function themeStop() { stopFile('theme'); themeOn = false; }
  function toggleTheme() {
    if (themeOn) { themeStop(); return false; }
    return themeStart();
  }

  // Think music = real Final Jeopardy music (final.wav, 32s)
  function thinkMusic() {
    if (muted) return;
    stopFile('theme'); themeOn = false;
    playFile('final');
  }

  function stopMusic() { stopFile('theme'); stopFile('final'); themeOn = false; }

  // Background lounge loop (synth — JParty has none)
  let loungeIv = null;
  function toggleLounge() {
    if (loungeIv) { clearInterval(loungeIv); loungeIv = null; return false; }
    if (muted) return false;
    const bass = [131, 131, 165, 147, 131, 131, 196, 165];
    let i = 0;
    loungeIv = setInterval(() => {
      if (muted) return;
      tone(bass[i % bass.length], 0, 0.45, 'sine', 0.12);
      if (i % 2 === 0) tone(bass[(i + 4) % bass.length] * 2, 0.05, 0.3, 'triangle', 0.06);
      i++;
    }, 450);
    return true;
  }

  function isMuted() { return muted; }
  function setMuted(m) {
    muted = !!m;
    localStorage.setItem('j_muted', muted ? '1' : '0');
    applyMute();
    if (muted) { stopMusic(); if (loungeIv) { clearInterval(loungeIv); loungeIv = null; } }
    updateMuteBtns();
  }
  function updateMuteBtns() { document.querySelectorAll('[data-mute]').forEach((b) => (b.textContent = muted ? '🔇 Unmute' : '🔊 Mute')); }

  window.JSound = {
    handleEvent, thinkMusic, stopMusic, toggleLounge, toggleTheme, themeStart, themeStop,
    isMuted, setMuted, updateMuteBtns,
    buzz: synth.buzz, wrong: synth.wrong, join: synth.join,
    playDailyDouble: () => playFile('dd'),
    playApplause: () => playFile('applause'),
  };
  document.addEventListener('DOMContentLoaded', updateMuteBtns);
})();
