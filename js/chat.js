// Builds the chat pane for a panel.
//
// YouTube always uses the official embeddable live chat iframe (no simple
// alternative implemented -- YouTube's own iframe doesn't have Twitch's
// hype-train/gift-banner clutter problem).
//
// Twitch has two modes, switchable from a small toolbar at the top of the
// pane:
//   - "シンプル表示" (default): our own from-scratch chat viewer
//     (twitchChatViewer.js), built directly on Twitch's public read-only
//     IRC-over-WebSocket chat feed. Shows only real chat messages (plus one
//     quiet line per sub/gift/raid event) -- no hype-train banners,
//     sub-goal bars, or celebration graphics, since those come from
//     Twitch's own chat page code, which this mode never loads. Read-only:
//     can't type from here.
//   - "公式チャット": Twitch's official embeddable chat iframe, as before --
//     switch to this to actually type a message.
// The chosen mode isn't remembered across reopening the panel (every fresh
// chat pane starts back on the simple viewer) -- panels don't persist
// across a reload anyway (see state.js), so there's nothing to keep in
// sync long-term.

import { createTwitchChatViewer } from "./twitchChatViewer.js";

// Tracks the active custom-viewer instance (the thing with a .destroy()) per
// container, so switching modes or tearing down the panel can clean up the
// WebSocket connection it opened. A WeakMap rather than a DOM property so
// nothing here can leak via a stray reference keeping a detached container
// element alive.
const activeViewers = new WeakMap();

function stopActiveViewer(container) {
  const inst = activeViewers.get(container);
  if (inst) {
    try { inst.destroy(); } catch {}
    activeViewers.delete(container);
  }
}

export function buildChatPane(target, container) {
  stopActiveViewer(container);
  container.innerHTML = "";
  const host = location.hostname || "";

  if (!target) return;

  if (location.protocol === "file:") {
    appendNote(container, "チャット埋め込みはローカルサーバー経由 (http://localhost:...) で開いた場合のみ動作します。README を参照してください。");
    return;
  }

  if (target.platform === "youtube") {
    if (target.mode !== "video") {
      appendNote(container, "このチャンネルの現在のチャットを表示するには、動画のURLを直接追加するか、設定画面でYouTube APIキーを登録してください（登録すると配信中の動画を自動解決できます）。");
      return;
    }
    const iframe = document.createElement("iframe");
    iframe.loading = "lazy";
    iframe.src = `https://www.youtube.com/live_chat?v=${encodeURIComponent(target.id)}&embed_domain=${encodeURIComponent(host)}&dark_theme=1`;
    container.appendChild(iframe);
    return;
  }

  if (target.platform === "twitch") {
    if (target.mode !== "channel") {
      appendNote(container, "アーカイブ(VOD)のチャットリプレイ表示には対応していません。配信者のチャンネルを直接追加するとライブチャットを表示できます。");
      return;
    }
    buildTwitchChatPane(target, container, host);
    return;
  }
}

function buildTwitchChatPane(target, container, host) {
  const toolbar = document.createElement("div");
  toolbar.className = "chat-mode-toolbar";
  const simpleBtn = document.createElement("button");
  simpleBtn.className = "chat-mode-btn";
  simpleBtn.type = "button";
  simpleBtn.textContent = "シンプル表示";
  simpleBtn.title = "ハイプトレインやギフト等の演出を省き、コメントだけを表示します（読み取り専用）";
  const officialBtn = document.createElement("button");
  officialBtn.className = "chat-mode-btn";
  officialBtn.type = "button";
  officialBtn.textContent = "公式チャット";
  officialBtn.title = "Twitch公式のチャット欄を表示します（書き込み可能）";
  toolbar.append(simpleBtn, officialBtn);

  const body = document.createElement("div");
  body.className = "chat-mode-body";

  container.append(toolbar, body);

  function setMode(mode) {
    simpleBtn.classList.toggle("active", mode === "simple");
    officialBtn.classList.toggle("active", mode === "official");
    stopActiveViewer(container);
    body.innerHTML = "";

    if (mode === "simple") {
      const viewer = createTwitchChatViewer(body, target.login);
      activeViewers.set(container, viewer);
    } else {
      const iframe = document.createElement("iframe");
      iframe.loading = "lazy";
      iframe.src = `https://www.twitch.tv/embed/${encodeURIComponent(target.login)}/chat?parent=${encodeURIComponent(host)}&darkpopout`;
      body.appendChild(iframe);
    }
  }

  simpleBtn.addEventListener("click", () => setMode("simple"));
  officialBtn.addEventListener("click", () => setMode("official"));

  setMode("simple"); // default to the clutter-free view; one click switches to official if typing is needed
}

// Call when a chat pane's container is about to be removed from the DOM, or
// rebuilt via buildChatPane for a different target -- stops any open
// WebSocket from the simple Twitch viewer so it doesn't keep running (and
// reconnecting) in the background after the pane is gone.
export function destroyChatPane(container) {
  stopActiveViewer(container);
}

function appendNote(container, text) {
  const note = document.createElement("div");
  note.className = "chat-note";
  note.textContent = text;
  container.appendChild(note);
}
