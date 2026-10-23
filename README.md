# 🟦 Jeopardy! — Home Network Game

> 100% vibecoded — no human wrote a single line of this.

TV board + host console + phone buzzers over WebSockets. No internet needed — everything runs on your WiFi.

## Quick start

```bash
npm install
npm start
```

You'll see something like:

```
📺 Board (TV):       http://192.168.1.42:3000/board
🎤 Host (laptop):    http://192.168.1.42:3000/host
🔔 Players (phones): http://192.168.1.42:3000/player
```

- **TV / main screen** → open `/board` (fullscreen with `F11` / `Cmd+Shift+F`)
- **Host (you)** → open `/host` on your laptop. It shows QR codes — players scan them to join.
- **Players** → on their phones, open `/player`, type a name, hit **Join**. A giant buzzer button appears.

## ⭐ Daily Double

One tile per round is secretly the **Daily Double** (placed at random when the show starts; marked ⭐ on the host board only — TV and phones can't see it; **🎲 Re-roll** picks a new one).

When it's opened: the `dd.wav` jingle plays, the TV shows a Daily Double splash (question hidden), buzzers stay shut — it's solo play:

1. Host taps ⭐ next to the player who found it.
2. That player enters a **wager on their phone** (up to their score, or the top remaining value if higher; host can also type it in).
3. Host reads the question, player answers aloud → **✅** wins the wager (real 👏 applause), **❌** loses it. Either way the clue is done and the answer is revealed.

## How a round works (host)

0. Hit **🎬 Start show** — the theme plays on all screens while the 6 categories parade onto the TV one by one (~2s each, like the real show), then the values cascade in and the game unlocks. (⏩ Skip intro jumps straight in.)
1. Click a tile → question appears on the TV (answer stays hidden there, visible only to you), and **buzzers go live instantly** — fastest phone locks everyone else out (their buzzers blur ❌).
2. First phone to tap **BUZZ** locks everyone else out — TV + all phones play a buzzer sound and show the winner.
3. Player answers aloud. Hit **✅ Correct** (+value, chime) or **❌ Wrong** (−value): the buzzers pop back up for everyone still eligible, next in queue gets it automatically. A player who answered wrong sits out the rest of the clue and can't buzz twice on the same question.
4. Hit **👁 Reveal** to show the answer on TV, then **Close tile ✓ done**.
6. Optional: **⏱ 10s timer**, **🎵 Think music**, manual **+100/−100** score tweaks.

## Sounds & music 🎵

> The `public/sounds/*.wav` clips are local-only (probably copyrighted, gitignored — see `.gitignore`). A fresh clone plays the synthesized fallbacks instead, everything still works.

Real clips from [JParty](~/dev/fun/jparty) in `public/sounds/` + synth fallback in `public/sound.js` (works offline):

| Moment | Sound |
|---|---|
| 🔔 Buzzer (first buzz, all screens) | synthesized game-show **BZZZT** (saw + tremolo — JParty has no buzzer clip!) |
| ✅ Correct answer | synthesized **ding-ding + rising chime** |
| ❌ Wrong answer | synthesized low buzz |
| Theme song (host soundboard → all screens) | `intro.wav` 3-min loop |
| Board reset/load | `board_fill.wav` |
| Think music / Final | `final.wav` (real 32s Final Jeopardy music) |
| Daily Double jingle (soundboard) | `dd.wav` |
| Applause (soundboard) | `applause.wav` |
| Timer expires, nobody got it | `stumped.wav` |
| Tile blip, reveal, join | synthesized (JParty has no clips for these) |

Each screen has a 🔊 mute toggle. Note `intro.wav` is 36MB — loads progressively, fine on LAN.

## 📶 Home-network setup (devices see each other)

The server binds to `0.0.0.0` (all interfaces), so any device on the **same WiFi** can reach it. If phones can't connect:

1. **Same WiFi, same band.** Put the laptop/TV/phones on the same network name. Some routers split `Home-2.4G` vs `Home-5G` — devices on different SSIDs often can't see each other. Pick one.
2. **Use the LAN IP, not localhost.** `localhost:3000` works only on the laptop itself. Phones must use e.g. `http://192.168.1.42:3000/player` (printed in the terminal + on the host screen). `http://`, not `https://`.
3. **macOS firewall:** System Settings → Network → Firewall → allow incoming connections (or turn it off on trusted home WiFi). First launch may pop "Allow Node to accept connections?" → **Allow**.
4. **Windows firewall:** allow `Node.js` through private networks, or run: `netsh advfirewall firewall add rule name="Jeopardy 3000" dir=in action=allow protocol=TCP localport=3000`.
5. **Guest isolation / AP isolation:** on some routers (esp. ISP boxes, guest WiFi), clients can't talk to each other. Use the main network, not Guest. In router settings turn OFF "AP isolation" / "client isolation".
6. **VPNs off** on all devices (they route traffic away from LAN).
7. **Test:** on a phone, open `http://<laptop-ip>:3000/player`. If it loads, WebSockets will work (same port, no extra config).
8. **Port in use?** `PORT=4000 npm start`.

Find your laptop IP manually: macOS `ipconfig getifaddr en0` · Windows `ipconfig` (IPv4 Address) · Linux `hostname -I`.

## Customize questions

Edit `questions.json` (6 categories × 5 clues, values 200–1000), then press **Reset board** on the host screen (or restart the server).

Clues accept an optional `"image"` — shown on the TV the moment the question opens:

```json
{ "value": 400, "question": "This tower leans in Italy.", "answer": "What is the Tower of Pisa?", "image": "https://upload.wikimedia.org/wikipedia/commons/6/66/Leaning_Tower_of_Pisa.jpg" }
```

- Full links (`https://…`, `http://…`) and `data:` URLs are used as-is.
- Anything else is treated as a file you dropped into `public/images/` — e.g. `"image": "monalisa.jpg"` loads `/images/monalisa.jpg` (great for offline play, no internet needed).
- No `image` field (or a broken link) → behaves exactly like before, nothing breaks.

## Tech

Node.js + Express (serves pages) + `ws` WebSockets (game state, buzzers) on one port. Players/scores/board progress persist in `game-state.json`, so a server restart doesn't log phones out — they auto-rejoin within a second or two. Delete that file (or use the host reset buttons) for a fully fresh game.
