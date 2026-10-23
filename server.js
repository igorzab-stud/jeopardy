// Jeopardy home-game server: Express + WebSockets, binds to LAN (0.0.0.0)
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const HOST = '0.0.0.0'; // <-- listen on ALL interfaces so phones on WiFi can connect

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Nice routes
app.get('/', (req, res) => res.redirect('/board'));
app.get('/board', (req, res) => res.sendFile(path.join(__dirname, 'public', 'board.html')));
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/player', (req, res) => res.sendFile(path.join(__dirname, 'public', 'player.html')));
app.get('/join', (req, res) => res.redirect('/player'));

// ---------- Game state ----------
function loadQuestions() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));
  // deep copy + add answered flags; keep a stable id
  return raw.categories.map((c) => ({
    title: c.title,
    clues: c.clues.map((clue) => ({ ...clue, answered: false })),
  }));
}

let board = loadQuestions();
let players = []; // { id(clientId), name, score, connected }
let current = null; // { cat, idx, answerRevealed }
let buzz = { open: false, winnerId: null, order: [], wrongIds: [] };
let timerHandle = null;
let timer = { running: false, seconds: 0, endsAt: 0, label: '' };
// Opening show: idle -> revealing (categories parade, one by one) -> playing
let show = { phase: 'idle', revealed: 0 };
// Hidden Daily Double tile for the round (host board shows ⭐, others must not peek)
let dd = null; // {cat, idx}
function topTileValue() {
  let m = 200;
  board.forEach((c) => c.clues.forEach((cl) => { if (!cl.answered && cl.value > m) m = cl.value; }));
  return m;
}
function placeDD() {
  const pool = [];
  board.forEach((c, ci) =>
    c.clues.forEach((cl, ii) => {
      if (!cl.answered && !(current && current.cat === ci && current.idx === ii)) pool.push({ cat: ci, idx: ii });
    })
  );
  dd = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
}
function clampWager(p, amount) {
  const top = Math.max(topTileValue(), p.score); // real rule: score or top value, whichever higher
  const n = Math.round(Number(amount) || 0);
  return Math.max(0, Math.min(top < 0 ? 0 : top, n));
}
let showTimer = null;
const CAT_REVEAL_MS = 1800; // ~ JParty's CATEGORY_REVEAL_TIME
function stopShow() {
  if (showTimer) clearInterval(showTimer);
  showTimer = null;
}

// Persist players/scores + board progress so a server restart doesn't
// log everyone out and wipe the game. Restored on boot below.
// GAME_STATE_FILE override exists so automated tests never touch the real game.
const STATE_FILE = process.env.GAME_STATE_FILE || path.join(__dirname, 'game-state.json');
let saveTimer = null;
function saveState() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(
        STATE_FILE,
        JSON.stringify({
          players: players.map((p) => ({ id: p.id, name: p.name, score: p.score })),
          answered: board.map((c) => c.clues.map((cl) => cl.answered)),
          show,
          dd,
        })
      );
    } catch {}
  }, 300);
}
function loadState() {
  let s;
  try {
    s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return; // first run, nothing saved yet
  }
  try {
    if (Array.isArray(s.players)) {
      players = s.players.map((p) => ({
        id: String(p.id),
        name: String(p.name || 'Player').slice(0, 20),
        score: Number(p.score) || 0,
        connected: false, // sockets are gone; flips true as phones rejoin
      }));
    }
    if (Array.isArray(s.answered)) {
      s.answered.forEach((row, c) => {
        if (board[c] && Array.isArray(row))
          row.forEach((a, i) => {
            if (board[c].clues[i]) board[c].clues[i].answered = !!a;
          });
      });
    }
    // land safely: a parade interrupted mid-reveal becomes a live board
    if (s.show && s.show.phase === 'playing') show = { phase: 'playing', revealed: board.length };
    if (s.dd && board[s.dd.cat] && board[s.dd.cat].clues[s.dd.idx] && !board[s.dd.cat].clues[s.dd.idx].answered) dd = s.dd;
  } catch {}
}
loadState();

function imgUrl(img) {
  // images can be links or local files dropped into public/images/
  if (!img || typeof img !== 'string') return null;
  const s = img.trim();
  if (!s) return null;
  if (/^(https?:\/\/|data:|\/)/i.test(s)) return s;
  return '/images/' + s.replace(/^\.\//, '');
}

function publicState() {
  return {
    players: players.map((p) => ({ ...p })),
    board: board.map((c) => ({
      title: c.title,
      clues: c.clues.map((cl) => ({ value: cl.value, answered: cl.answered })),
    })),
    current: current
      ? {
          cat: current.cat,
          idx: current.idx,
          value: board[current.cat].clues[current.idx].value,
          question: board[current.cat].clues[current.idx].question,
          // Host-only field, but sent to everyone (home game, simple).
          // Board/player screens just don't render it until revealed.
          answer: board[current.cat].clues[current.idx].answer,
          answerRevealed: current.answerRevealed,
          image: imgUrl(board[current.cat].clues[current.idx].image),
          dd: !!current.dd,
          wager: current.wager,
          ddPlayer: current.ddPlayer,
        }
      : null,
    buzz: { ...buzz, order: [...buzz.order], wrongIds: [...buzz.wrongIds] },
    timer: { ...timer },
    show: { ...show },
    dd, // hidden location — only the host screen renders it
  };
}

// ---------- Networking helpers ----------
function getLanIPs() {
  const out = [];
  for (const [, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

app.get('/api/info', (req, res) => {
  const ips = getLanIPs();
  const primary = ips[0] || 'localhost';
  res.json({
    port: PORT,
    ips,
    urls: {
      board: `http://${primary}:${PORT}/board`,
      host: `http://${primary}:${PORT}/host`,
      player: `http://${primary}:${PORT}/player`,
    },
  });
});

app.get('/api/qr', async (req, res) => {
  const target = req.query.target === 'host' ? 'host' : req.query.target === 'board' ? 'board' : 'player';
  const ips = getLanIPs();
  const primary = ips[0] || 'localhost';
  const url = `http://${primary}:${PORT}/${target}`;
  try {
    const dataUrl = await QRCode.toDataURL(url, { width: 300, margin: 1 });
    res.json({ url, qr: dataUrl });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/questions', (req, res) => {
  res.json({ categories: board.map((c) => ({ title: c.title, count: c.clues.length })) });
});

// ---------- WebSocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

function broadcastState() {
  broadcast({ type: 'state', state: publicState() });
  saveState();
}

function broadcastEvent(event, data = {}) {
  broadcast({ type: 'event', event, ...data });
}

function stopTimer(silent = false) {
  if (timerHandle) clearTimeout(timerHandle);
  timerHandle = null;
  if (timer.running && !silent) broadcastEvent('timer_stop');
  timer = { running: false, seconds: 0, endsAt: 0, label: '' };
}

function findPlayer(id) {
  return players.find((p) => p.id === id);
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.playerId = null;

  // Send full state immediately so new screens sync
  ws.send(JSON.stringify({ type: 'state', state: publicState() }));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      // ----- players -----
      case 'join': {
        const name = String(msg.name || '').trim().slice(0, 20) || 'Player';
        const id = String(msg.clientId || '').slice(0, 64) || `anon-${Date.now()}`;
        let p = findPlayer(id);
        if (!p) {
          p = { id, name, score: 0, connected: true };
          players.push(p);
        } else {
          p.name = name;
          p.connected = true;
        }
        ws.playerId = id;
        if (msg.rejoin) {
          // phone reconnecting (e.g. after server restart): re-register silently
          broadcastState();
        } else {
          broadcastEvent('player_join', { playerId: id, name });
          broadcastState();
        }
        break;
      }

      case 'buzz': {
        const id = ws.playerId || msg.clientId;
        const p = id && findPlayer(String(id));
        if (!p) break;
        if (!current) break;
        if (!buzz.open) break; // buzzers closed -> ignore
        if (buzz.order.includes(p.id)) break; // one buzz per player per clue
        if (buzz.wrongIds.includes(p.id)) break; // struck out on this clue -> ignore
        buzz.order.push(p.id);
        if (!buzz.winnerId) {
          buzz.winnerId = p.id;
          broadcastEvent('buzz_win', { playerId: p.id, name: p.name });
        }
        broadcastState();
        break;
      }

      // ----- host controls -----
      case 'host_open_tile': {
        const cat = Number(msg.cat);
        const idx = Number(msg.idx);
        if (show.phase !== 'playing') break; // finish the opening show first
        if (!board[cat] || !board[cat].clues[idx]) break;
        if (board[cat].clues[idx].answered) break;
        stopTimer(true);
        const isDD = !!(dd && dd.cat === cat && dd.idx === idx);
        current = { cat, idx, answerRevealed: false, dd: isDD, wager: null, ddPlayer: null };
        // normal clues: buzzers live instantly. DD: solo play, buzzers stay shut.
        buzz = { open: !isDD, winnerId: null, order: [], wrongIds: [] };
        broadcastEvent(isDD ? 'dd' : 'tile_open', { cat, idx });
        broadcastState();
        break;
      }

      case 'host_close_tile': {
        // mark answered (or not) and clear the modal
        const markAnswered = msg.markAnswered !== false;
        if (current && markAnswered) {
          board[current.cat].clues[current.idx].answered = true;
          if (current.dd && dd) dd = null; // DD consumed without award
        }
        current = null;
        buzz = { open: false, winnerId: null, order: [], wrongIds: [] };
        stopTimer(true);
        broadcastEvent('tile_close');
        broadcastState();
        break;
      }

      case 'host_reveal_answer': {
        if (!current) break;
        current.answerRevealed = !current.answerRevealed; // toggle
        broadcastEvent('reveal_answer', { revealed: current.answerRevealed });
        broadcastState();
        break;
      }

      case 'host_open_buzzers': {
        if (!current) break;
        buzz = { open: true, winnerId: null, order: [], wrongIds: buzz.wrongIds };
        broadcastEvent('buzz_open');
        broadcastState();
        break;
      }

      case 'host_close_buzzers': {
        buzz.open = false;
        broadcastEvent('buzz_close');
        broadcastState();
        break;
      }

      case 'host_reset_buzzers': {
        // clears winner/queue but strikes stand for this clue
        buzz = { open: buzz.open, winnerId: null, order: [], wrongIds: buzz.wrongIds };
        broadcastEvent('buzz_reset');
        broadcastState();
        break;
      }

      case 'host_dd_player': {
        // host picks who found the Daily Double (only they play it)
        if (!current || !current.dd || current.ddPlayer) break;
        const p = msg.playerId && findPlayer(msg.playerId);
        if (!p) break;
        current.ddPlayer = p.id;
        broadcastEvent('dd_player', { playerId: p.id, name: p.name });
        broadcastState();
        break;
      }

      case 'wager': {
        // DD wager from the chosen player's phone
        if (!current || !current.dd || !current.ddPlayer || current.wager != null) break;
        const id = String(ws.playerId || msg.clientId || '');
        if (id !== current.ddPlayer) break;
        const p = findPlayer(id);
        if (!p) break;
        current.wager = clampWager(p, msg.amount);
        broadcastEvent('wager_set', { playerId: p.id, wager: current.wager });
        broadcastState();
        break;
      }

      case 'host_dd_wager': {
        // host types the wager instead (player shouted it out)
        if (!current || !current.dd || !current.ddPlayer || current.wager != null) break;
        const p = findPlayer(current.ddPlayer);
        if (!p) break;
        current.wager = clampWager(p, msg.amount);
        broadcastEvent('wager_set', { playerId: p.id, wager: current.wager });
        broadcastState();
        break;
      }

      case 'host_dd_reroll': {
        if (current && current.dd) break; // don't orphan a live Daily Double
        placeDD();
        broadcastState();
        break;
      }

      case 'host_award': {
        // correct -> +value (or +wager on DD), wrong -> -value (or -wager, DD over)
        const pid = msg.playerId || buzz.winnerId;
        const p = pid && findPlayer(pid);
        if (!p || !current) break;
        if (current.dd && (current.wager == null || !current.ddPlayer)) break; // DD needs player + wager first
        const value = current.dd ? current.wager : board[current.cat].clues[current.idx].value;
        const correct = msg.correct !== false;
        p.score += correct ? value : -value;
        broadcastEvent(correct ? (current.dd ? 'applause' : 'correct') : 'wrong', { playerId: p.id, name: p.name, value });
        if (current.dd) {
          // Daily Double is solo: right or wrong, the clue is done and revealed
          board[current.cat].clues[current.idx].answered = true;
          current.answerRevealed = true;
          dd = null;
        } else if (!correct) {
          // wrong answer: strike them out for this clue, next in line gets it.
          // buzzers stay open so the rest can jump back in ("show it again").
          if (!buzz.wrongIds.includes(p.id)) buzz.wrongIds.push(p.id);
          buzz.order = buzz.order.filter((id) => id !== p.id);
          buzz.winnerId = buzz.order[0] || null;
          if (buzz.winnerId) {
            const next = findPlayer(buzz.winnerId);
            broadcastEvent('buzz_win', { playerId: next.id, name: next.name, afterWrong: true });
          }
        } else {
          // correct: auto-mark answered, reveal the answer on the board,
          // keep modal open for host to close
          board[current.cat].clues[current.idx].answered = true;
          current.answerRevealed = true;
        }
        broadcastState();
        break;
      }

      case 'host_adjust': {
        const p = msg.playerId && findPlayer(msg.playerId);
        if (!p) break;
        p.score += Number(msg.delta) || 0;
        broadcastState();
        break;
      }

      case 'host_set_score': {
        const p = msg.playerId && findPlayer(msg.playerId);
        if (!p) break;
        p.score = Number(msg.score) || 0;
        broadcastState();
        break;
      }

      case 'host_remove_player': {
        players = players.filter((p) => p.id !== msg.playerId);
        buzz.order = buzz.order.filter((id) => id !== msg.playerId);
        buzz.wrongIds = buzz.wrongIds.filter((id) => id !== msg.playerId);
        if (buzz.winnerId === msg.playerId) buzz.winnerId = buzz.order[0] || null;
        broadcastState();
        break;
      }

      case 'host_reset_board': {
        board = loadQuestions();
        current = null;
        buzz = { open: false, winnerId: null, order: [], wrongIds: [] };
        stopTimer(true);
        stopShow();
        show = { phase: 'idle', revealed: 0 };
        dd = null;
        broadcastEvent('board_reset');
        broadcastState();
        break;
      }

      case 'host_start_show': {
        // Opening parade: theme music + categories revealed one by one,
        // then values fill in and the game unlocks.
        stopShow();
        stopTimer(true);
        current = null;
        buzz = { open: false, winnerId: null, order: [], wrongIds: [] };
        show = { phase: 'revealing', revealed: 0 };
        placeDD(); // hide one Daily Double for the round
        broadcastEvent('show_start');
        broadcastState();
        showTimer = setInterval(() => {
          show.revealed += 1;
          if (show.revealed >= board.length) {
            stopShow();
            show = { phase: 'playing', revealed: board.length };
            broadcastEvent('show_done');
          }
          broadcastState();
        }, CAT_REVEAL_MS);
        break;
      }

      case 'host_skip_show': {
        stopShow();
        show = { phase: 'playing', revealed: board.length };
        placeDD();
        broadcastEvent('show_done');
        broadcastState();
        break;
      }

      case 'host_reset_scores': {
        players.forEach((p) => (p.score = 0));
        broadcastState();
        break;
      }

      case 'host_timer': {
        const seconds = Math.max(1, Math.min(120, Number(msg.seconds) || 10));
        stopTimer(true);
        timer = { running: true, seconds, endsAt: Date.now() + seconds * 1000, label: String(msg.label || '') };
        broadcastEvent('timer_start', { seconds, label: timer.label });
        broadcastState();
        timerHandle = setTimeout(() => {
          timer = { running: false, seconds: 0, endsAt: 0, label: '' };
          buzz.open = false;
          broadcastEvent('times_up');
          broadcastState();
        }, seconds * 1000);
        break;
      }

      case 'host_stop_timer': {
        stopTimer();
        broadcastState();
        break;
      }

      case 'host_sound': {
        // let host trigger a jingle on all screens
        broadcastEvent(msg.event || 'correct', {});
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    if (ws.playerId) {
      const p = findPlayer(ws.playerId);
      if (p) {
        p.connected = false;
        broadcastState();
      }
    }
  });
});

// heartbeat so dead phone connections drop cleanly
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, HOST, () => {
  const ips = getLanIPs();
  console.log('\n  🟦 JEOPARDY! home game is running 🟦\n');
  console.log(`  Local:   http://localhost:${PORT}`);
  if (ips.length === 0) {
    console.log('  ⚠️  No LAN IP detected — are you on WiFi? Others may not be able to connect.');
  } else {
    for (const ip of ips) {
      console.log(`  Network: http://${ip}:${PORT}`);
    }
    console.log('');
    console.log(`  📺 Board (TV):      http://${ips[0]}:${PORT}/board`);
    console.log(`  🎤 Host (laptop):   http://${ips[0]}:${PORT}/host`);
    console.log(`  🔔 Players (phones): http://${ips[0]}:${PORT}/player`);
  }
  console.log('\n  All devices must be on the SAME WiFi. See README for firewall help.\n');
});
