// Self-contained dashboard page served by the bridge at "/".
// No build step, no external assets — everything inlined so it works offline.
// The Connect / Disconnect button only controls THIS page's live link to the
// bridge (it starts/stops polling); it does not touch the Roblox game.
export const DASHBOARD_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Roblox MCP</title>
<style>
  :root {
    --bg: #0b0e14;
    --panel: #11151f;
    --panel-2: #161b27;
    --border: #232a3a;
    --text: #e6e9f0;
    --muted: #8b93a7;
    --accent: #5b8cff;
    --green: #38d39f;
    --red: #ff5d6c;
    --yellow: #ffcc66;
    --radius: 14px;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    background: radial-gradient(1200px 600px at 70% -10%, #18203a 0%, var(--bg) 55%);
    color: var(--text);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
    padding: 28px;
    max-width: 920px;
    margin: 0 auto;
  }
  header {
    display: flex; align-items: center; justify-content: space-between;
    gap: 16px; margin-bottom: 22px;
  }
  .brand { display: flex; align-items: center; gap: 12px; }
  .logo {
    width: 38px; height: 38px; border-radius: 10px;
    background: linear-gradient(135deg, var(--accent), #9b6bff);
    display: grid; place-items: center; font-weight: 800; color: #fff;
  }
  h1 { font-size: 18px; margin: 0; letter-spacing: .2px; }
  .sub { color: var(--muted); font-size: 12px; }
  .controls { display: flex; align-items: center; gap: 12px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--muted); box-shadow: 0 0 0 0 transparent; }
  .dot.on { background: var(--green); box-shadow: 0 0 12px 1px rgba(56,211,159,.7); }
  .dot.off { background: var(--red); }
  button {
    border: 1px solid var(--border); background: var(--panel-2); color: var(--text);
    padding: 9px 16px; border-radius: 10px; font-weight: 600; cursor: pointer;
    transition: .15s ease;
  }
  button:hover { border-color: var(--accent); }
  button.connected { background: rgba(255,93,108,.12); border-color: var(--red); color: #ffb3ba; }
  button.connect { background: rgba(91,140,255,.14); border-color: var(--accent); color: #cfe; }

  .card {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 18px; margin-bottom: 18px;
  }
  .user { display: flex; align-items: center; gap: 16px; }
  .avatar {
    width: 64px; height: 64px; border-radius: 50%; background: var(--panel-2);
    border: 2px solid var(--border); object-fit: cover;
  }
  .user .name { font-size: 17px; font-weight: 700; }
  .user .meta { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .badge {
    display: inline-block; padding: 2px 8px; border-radius: 999px;
    font-size: 11px; font-weight: 700; border: 1px solid var(--border);
    color: var(--muted); text-transform: uppercase; letter-spacing: .4px;
  }
  .badge.executor { color: var(--accent); border-color: var(--accent); }

  .section-title {
    font-size: 12px; font-weight: 800; letter-spacing: 1.2px;
    color: var(--muted); text-transform: uppercase; margin: 4px 0 12px;
  }
  .events { display: flex; flex-direction: column; gap: 8px; max-height: 60vh; overflow-y: auto; }
  .ev {
    display: grid; grid-template-columns: 92px 1fr auto; gap: 12px; align-items: baseline;
    background: var(--panel-2); border: 1px solid var(--border);
    border-radius: 10px; padding: 9px 12px;
  }
  .ev .t { font-weight: 700; font-size: 11px; text-transform: uppercase; letter-spacing: .4px; }
  .ev .body { color: var(--text); word-break: break-word; }
  .ev .body .who { color: var(--accent); font-weight: 600; }
  .ev .body .data { color: var(--muted); font-size: 12px; }
  .ev .when { color: var(--muted); font-size: 11px; white-space: nowrap; }
  .t.jump { color: #7fd1ff; } .t.movement { color: #9aa7ff; }
  .t.click, .t.gui { color: #ffcc66; } .t.remote { color: #c79bff; }
  .t.character { color: #38d39f; } .t.tool { color: #ffa3c2; }
  .t.object { color: #8b93a7; } .t.log { color: #b8c0d0; }
  .t.error { color: var(--red); } .t.chat { color: #7fffd4; }
  .t.system, .t.custom { color: var(--accent); }
  .empty { color: var(--muted); text-align: center; padding: 30px; }
</style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="logo">R</div>
      <div>
        <h1>Roblox MCP</h1>
        <div class="sub" id="bridgeUrl">bridge dashboard</div>
      </div>
    </div>
    <div class="controls">
      <span class="dot off" id="dot"></span>
      <button id="toggle" class="connect">Connect</button>
    </div>
  </header>

  <div class="card" id="userCard" style="display:none">
    <div class="user">
      <img class="avatar" id="avatar" alt="" />
      <div>
        <div class="name" id="userName">—</div>
        <div class="meta"><span id="userId"></span> &middot; <span class="badge executor" id="ctxBadge">executor</span></div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="section-title">Most Recent Events</div>
    <div class="events" id="events"><div class="empty" id="emptyMsg">Not connected. Press Connect to start streaming.</div></div>
  </div>

<script>
(function () {
  var connected = false;
  var timer = null;
  var lastSeq = 0;
  var events = [];        // newest-first, capped
  var MAX = 100;

  var el = function (id) { return document.getElementById(id); };
  var dot = el("dot"), toggle = el("toggle"), eventsEl = el("events");
  var userCard = el("userCard"), avatar = el("avatar");
  var userName = el("userName"), userId = el("userId"), ctxBadge = el("ctxBadge");
  el("bridgeUrl").textContent = location.host;

  function rel(ms) {
    var s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 1) return "now";
    if (s < 60) return Math.floor(s) + "s ago";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    return Math.floor(s / 3600) + "h ago";
  }

  function summarize(ev) {
    var d = ev.data || {};
    var parts = [];
    if (d.message != null) parts.push(String(d.message));
    if (d.target) parts.push(String(d.target));
    if (d.button) parts.push(String(d.button));
    if (d.remote) parts.push(String(d.remote));
    if (d.tool) parts.push(String(d.tool));
    if (d.script) parts.push("@ " + d.script + (d.line ? ":" + d.line : ""));
    if (d.state) parts.push(String(d.state));
    if (d.health != null) parts.push("hp " + Math.round(d.health));
    if (d.speed != null) parts.push(Math.round(d.speed) + " sps");
    if (d.handlers && d.handlers.length) {
      parts.push("handlers: " + d.handlers.map(function (h) {
        return h.script + (h.line ? ":" + h.line : "");
      }).join(", "));
    }
    return parts.join(" \\u00b7 ");
  }

  function render() {
    if (!events.length) {
      eventsEl.innerHTML = '<div class="empty">' +
        (connected ? "Connected. Waiting for game events…" : "Not connected. Press Connect to start streaming.") +
        '</div>';
      return;
    }
    var html = "";
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      var who = ev.playerName ? '<span class="who">' + escapeHtml(ev.playerName) + '</span> ' : "";
      var data = summarize(ev);
      html += '<div class="ev">' +
        '<span class="t ' + ev.type + '">' + ev.type + '</span>' +
        '<span class="body">' + who + escapeHtml(ev.action || "") +
          (data ? ' <span class="data">' + escapeHtml(data) + '</span>' : "") +
        '</span>' +
        '<span class="when">' + rel(ev.ingestedAt) + '</span>' +
      '</div>';
    }
    eventsEl.innerHTML = html;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function applyState(st) {
    var ex = st && (st.executor || (st.players && st.players[0]));
    var live = st && st.connected;
    dot.className = "dot " + (live ? "on" : "off");
    if (ex && ex.userId) {
      userCard.style.display = "";
      avatar.src = "https://www.roblox.com/headshot-thumbnail/image?userId=" + ex.userId + "&width=150&height=150&format=png";
      userName.textContent = ex.displayName || ex.name || ("User " + ex.userId);
      userId.textContent = "@" + (ex.name || ex.userId);
      ctxBadge.textContent = (st.context || "connected");
    } else {
      userCard.style.display = "none";
    }
  }

  async function poll() {
    try {
      var r = await fetch("/api/state");
      var st = await r.json();
      applyState(st);
      var er = await fetch("/api/events?afterSeq=" + lastSeq + "&limit=100");
      var ej = await er.json();
      if (ej.events && ej.events.length) {
        for (var i = 0; i < ej.events.length; i++) {
          events.unshift(ej.events[i]);
          if (ej.events[i].seq > lastSeq) lastSeq = ej.events[i].seq;
        }
        if (events.length > MAX) events.length = MAX;
      }
      render();
    } catch (e) {
      dot.className = "dot off";
    }
  }

  function connect() {
    connected = true;
    toggle.textContent = "Disconnect";
    toggle.className = "connected";
    poll();
    timer = setInterval(poll, 1000);
    render();
  }

  function disconnect() {
    connected = false;
    toggle.textContent = "Connect";
    toggle.className = "connect";
    if (timer) clearInterval(timer);
    timer = null;
    dot.className = "dot off";
    render();
  }

  toggle.addEventListener("click", function () {
    if (connected) disconnect(); else connect();
  });

  // refresh relative timestamps even between polls
  setInterval(function () { if (connected && events.length) render(); }, 5000);
})();
</script>
</body>
</html>`;
