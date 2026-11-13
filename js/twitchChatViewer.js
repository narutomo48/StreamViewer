// A minimal, from-scratch Twitch chat renderer, built directly on Twitch's
// own IRC-over-WebSocket chat interface (the same protocol Twitch's own web
// chat, and most third-party chat overlays/bots, are built on) instead of
// their official chat embed iframe. Read-only (anonymous login -- no OAuth
// or Twitch account needed), and deliberately renders ONLY normal chat
// messages plus a single quiet line for sub/gift/raid events -- it never
// shows Twitch's own hype-train banner, subscription-goal bar, or the big
// celebration graphics that can otherwise swallow the whole chat pane,
// since those are rendered by Twitch's own chat page code, which this never
// loads at all. To actually type into chat, switch to "公式チャット" (see
// chat.js) -- sending isn't implemented here.
//
// Protocol notes (community-known from projects like tmi.js, not part of
// Twitch's public REST API docs, but stable and very widely relied upon):
//   - wss://irc-ws.chat.twitch.tv:443, plain IRC framing (CRLF-terminated lines)
//   - an anonymous "justinfan#####" login can read any public channel's chat
//     with no real credentials (any PASS value is accepted)
//   - `CAP REQ :twitch.tv/tags twitch.tv/commands` unlocks the metadata tags
//     (display name, color, emotes, badges) and USERNOTICE events
//   - emote images: https://static-cdn.jtvnw.net/emoticons/v2/<id>/default/dark/2.0

const IRC_WS_URL = "wss://irc-ws.chat.twitch.tv:443";
const MAX_MESSAGES = 150; // trim old rows so a busy chat doesn't grow the DOM forever

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// IRCv3 tag values escape a handful of characters (see the spec) -- only
// system-msg (the sub/gift/raid one-liners) needs this.
function unescapeTagValue(v) {
  return v.replace(/\\s/g, " ").replace(/\\:/g, ";").replace(/\\\\/g, "\\").replace(/\\r/g, "\r").replace(/\\n/g, "\n");
}

function parseTags(raw) {
  const tags = {};
  if (!raw) return tags;
  for (const pair of raw.slice(1).split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    tags[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return tags;
}

// Splices emote images into the message at the right spots. `emotesTag` is
// Twitch's own format: "id:start-end,start-end/id2:start-end", with
// start/end as UTF-16 code unit offsets into the raw message text.
function renderMessageHtml(text, emotesTag) {
  if (!emotesTag) return escapeHtml(text);
  const ranges = [];
  for (const part of emotesTag.split("/")) {
    const [id, positions] = part.split(":");
    if (!id || !positions) continue;
    for (const pos of positions.split(",")) {
      const [start, end] = pos.split("-").map(Number);
      if (Number.isFinite(start) && Number.isFinite(end)) ranges.push({ id, start, end });
    }
  }
  if (!ranges.length) return escapeHtml(text);
  ranges.sort((a, b) => a.start - b.start);
  let html = "";
  let cursor = 0;
  for (const r of ranges) {
    if (r.start < cursor) continue; // overlapping/malformed -- skip defensively
    html += escapeHtml(text.slice(cursor, r.start));
    const name = escapeHtml(text.slice(r.start, r.end + 1));
    html += `<img class="chat-emote" alt="${name}" title="${name}" src="https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(r.id)}/default/dark/2.0">`;
    cursor = r.end + 1;
  }
  html += escapeHtml(text.slice(cursor));
  return html;
}

// Badge SET names -> a short readable label. Real badge icons need an extra
// fetch (Twitch's badges API, per-channel + global) just to map a
// set/version to an image URL -- skipped to keep this simple; text labels
// still make mods/subs/VIPs visually distinguishable at a glance.
const BADGE_LABELS = {
  broadcaster: "配信者", moderator: "MOD", vip: "VIP", subscriber: "SUB",
  founder: "FOUNDER", "sub-gifter": "ギフター", "bits-leader": "Bits",
  partner: "✓", staff: "Staff", admin: "Admin",
};

function badgeLabelsFromTag(badgesTag) {
  if (!badgesTag) return [];
  return badgesTag.split(",")
    .map((b) => b.split("/")[0])
    .filter((name) => BADGE_LABELS[name])
    .map((name) => BADGE_LABELS[name]);
}

// channelLogin: the Twitch channel's login name (lowercase handle, not display name).
export function createTwitchChatViewer(container, channelLogin) {
  container.innerHTML = "";
  container.classList.add("twitch-chat-viewer");
  const list = document.createElement("div");
  list.className = "chat-viewer-list";
  container.appendChild(list);

  let ws = null;
  let destroyed = false;
  let reconnectTimer = null;
  let reconnectDelayMs = 1500;

  function isNearBottom() {
    return list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  }

  function appendRow(rowEl) {
    const stick = isNearBottom(); // only auto-scroll if the user hasn't scrolled up to read history
    list.appendChild(rowEl);
    while (list.children.length > MAX_MESSAGES) list.removeChild(list.firstChild);
    if (stick) list.scrollTop = list.scrollHeight;
  }

  function appendSystemLine(text) {
    const row = document.createElement("div");
    row.className = "chat-viewer-system";
    row.textContent = text;
    appendRow(row);
  }

  function appendChatMessage(tags, text) {
    const row = document.createElement("div");
    row.className = "chat-viewer-row";
    const name = tags["display-name"] || "";
    const color = tags.color || "#9a9ac8";
    const badgeHtml = badgeLabelsFromTag(tags.badges)
      .map((b) => `<span class="chat-badge">${escapeHtml(b)}</span>`)
      .join("");
    const bodyHtml = renderMessageHtml(text, tags.emotes);
    row.innerHTML = `${badgeHtml}<span class="chat-name" style="color:${escapeHtml(color)}">${escapeHtml(name)}</span><span class="chat-colon">: </span><span class="chat-body">${bodyHtml}</span>`;
    appendRow(row);
  }

  function handleLine(line) {
    let tagsRaw = "";
    let rest = line;
    if (line.startsWith("@")) {
      const sp = line.indexOf(" ");
      tagsRaw = line.slice(0, sp);
      rest = line.slice(sp + 1);
    }
    if (rest.startsWith("PING")) {
      try { ws.send("PONG :tmi.twitch.tv"); } catch {}
      return;
    }
    if (rest.includes(" PRIVMSG #")) {
      const tags = parseTags(tagsRaw);
      const idx = rest.indexOf(" :");
      const text = idx === -1 ? "" : rest.slice(idx + 2);
      appendChatMessage(tags, text);
    } else if (rest.includes(" USERNOTICE #")) {
      const tags = parseTags(tagsRaw);
      const sysMsg = tags["system-msg"];
      if (sysMsg) appendSystemLine(`🎉 ${unescapeTagValue(sysMsg)}`);
    }
  }

  function connect() {
    if (destroyed) return;
    ws = new WebSocket(IRC_WS_URL);
    ws.onopen = () => {
      reconnectDelayMs = 1500;
      ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
      ws.send("PASS SCHMOOPIE"); // any value works for an anonymous justinfan read-only login
      ws.send(`NICK justinfan${Math.floor(10000 + Math.random() * 90000)}`);
      ws.send(`JOIN #${channelLogin.toLowerCase()}`);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      for (const line of ev.data.split("\r\n")) {
        if (line) handleLine(line);
      }
    };
    ws.onclose = () => { if (!destroyed) scheduleReconnect(); };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, reconnectDelayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 1.8, 20000);
  }

  connect();

  return {
    destroy() {
      destroyed = true;
      clearTimeout(reconnectTimer);
      try { ws && ws.close(); } catch {}
    },
  };
}
