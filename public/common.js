// Shared WebSocket client with auto-reconnect + persistent player identity.
//
// Guarantees:
// - messages sent before the socket is open are queued and flushed on connect
//   (fixes the "join lost on page load" race that left phones unregistered)
// - `onOpen` fires on EVERY (re)connect so screens can re-register
//   (fixes "logged out after server restart": server memory is wiped, so the
//   phone must re-send `join` on the fresh connection)
(function () {
  function getClientId() {
    let id = localStorage.getItem('j_clientId');
    if (!id) {
      id = 'p-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem('j_clientId', id);
    }
    return id;
  }
  function getName() { return localStorage.getItem('j_name') || ''; }
  function setName(n) { localStorage.setItem('j_name', n); }

  function connect({ onState, onEvent, onStatus, onOpen }) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws = null, retries = 0, closed = false;
    let queue = []; // messages sent while not connected

    function status(s) { if (onStatus) onStatus(s); }
    function isOpen() { return !!ws && ws.readyState === 1; }
    function flush() {
      if (!isOpen() || queue.length === 0) return;
      const pending = queue;
      queue = [];
      for (const data of pending) {
        try { ws.send(data); } catch { /* drop if it fails again */ }
      }
    }

    function open() {
      status(retries === 0 ? 'connecting…' : `reconnecting… (${retries})`);
      ws = new WebSocket(`${proto}://${location.host}`);
      ws.onopen = () => {
        retries = 0;
        status('connected ✓');
        flush();
        if (onOpen) { try { onOpen(); } catch (e) { console.error(e); } }
      };
      ws.onmessage = (e) => {
        let msg; try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type === 'state' && onState) onState(msg.state);
        else if (msg.type === 'event') {
          if (window.JSound) window.JSound.handleEvent(msg.event);
          if (onEvent) onEvent(msg);
        }
      };
      ws.onclose = () => {
        status('disconnected — retrying…');
        if (!closed) setTimeout(() => { retries++; open(); }, 1200);
      };
      ws.onerror = () => { try { ws.close(); } catch {} };
    }
    open();
    return {
      send(o) {
        const data = JSON.stringify(o);
        if (isOpen()) {
          try { ws.send(data); } catch { if (queue.length < 20) queue.push(data); }
        } else if (queue.length < 20) {
          queue.push(data); // buffer until connected, don't silently drop
        }
      },
      connected: isOpen,
      close() { closed = true; try { ws.close(); } catch {} },
    };
  }

  window.J = { connect, getClientId, getName, setName };
})();
