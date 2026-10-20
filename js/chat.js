// Builds the embedded chat pane for a panel using each platform's official
// embeddable chat iframe (viewer reads+sends using their own logged-in
// session inside that iframe -- no API key or OAuth needed for this part).

export function buildChatPane(target, container) {
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
    // YouTube has two separate embeddable chat endpoints: live_chat (only
    // works while the stream is actually live) and live_chat_replay (the
    // saved chat log for a past live stream/premiere -- only live_chat_replay
    // works once the broadcast has ended). Using live_chat for an archived
    // video just shows YouTube's own "このライブストリームではチャットは
    // 無効です" message inside the iframe. target.liveChat === "replay" is
    // set when we know in advance this is a past broadcast (see
    // addVideoFromArchive in sidebar.js); a regular (never-live) upload has
    // no chat either way, so this is a strict improvement with no downside.
    // dark_theme=1 matters here: without it YouTube's chat embed can render
    // some rows (colored usernames, certain badges) in light-theme text
    // colors while the surrounding chrome stays dark, making them unreadable.
    const endpoint = target.liveChat === "replay" ? "live_chat_replay" : "live_chat";
    iframe.src = `https://www.youtube.com/${endpoint}?v=${encodeURIComponent(target.id)}&embed_domain=${encodeURIComponent(host)}&dark_theme=1`;
    container.appendChild(iframe);
    return;
  }

  if (target.platform === "twitch") {
    if (target.mode !== "channel") {
      appendNote(container, "アーカイブ(VOD)のチャットリプレイ表示には対応していません。配信者のチャンネルを直接追加するとライブチャットを表示できます。");
      return;
    }
    const iframe = document.createElement("iframe");
    iframe.loading = "lazy";
    iframe.src = `https://www.twitch.tv/embed/${encodeURIComponent(target.login)}/chat?parent=${encodeURIComponent(host)}&darkpopout`;
    container.appendChild(iframe);
    return;
  }
}

function appendNote(container, text) {
  const note = document.createElement("div");
  note.className = "chat-note";
  note.textContent = text;
  container.appendChild(note);
}
