// YouTube IFrame Player API wrapper.
// https://developers.google.com/youtube/iframe_api_reference

let apiReadyPromise = null;

function ensureYoutubeApiLoaded() {
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (apiReadyPromise) return apiReadyPromise;
  apiReadyPromise = new Promise((resolve) => {
    const prevCb = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof prevCb === "function") { try { prevCb(); } catch {} }
      resolve(window.YT);
    };
    if (!document.querySelector("script[data-yt-iframe-api]")) {
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      tag.async = true;
      tag.dataset.ytIframeApi = "1";
      document.head.appendChild(tag);
    }
  });
  return apiReadyPromise;
}

// target: { mode: "video", id } | { mode: "channel", idType, id }
// Channel mode only works out of the box when idType === "channelId" (a UC... id),
// since YouTube's live_stream embed needs the real channel id, not a @handle.
export async function createYoutubePlayer(container, target, opts = {}) {
  const { volume = 80, muted = false, onReady, onError, onUnsupported } = opts;

  // Fail fast (no network needed) if this target can't be played without an API key,
  // rather than loading the YouTube IFrame API first just to discover that.
  if (target.mode === "channel" && target.idType !== "channelId") {
    if (onUnsupported) onUnsupported();
    return { setVolume() {}, setMuted() {}, destroy() {} };
  }

  const YT = await ensureYoutubeApiLoaded();
  const origin = location.origin;

  if (target.mode === "video") {
    // Standard, fully-supported constructor -- always gets real JS API control.
    const div = document.createElement("div");
    container.appendChild(div);
    const player = new YT.Player(div, {
      videoId: target.id,
      playerVars: {
        autoplay: 1, enablejsapi: 1, origin, playsinline: 1, rel: 0, mute: muted ? 1 : 0,
      },
      events: {
        onReady: (e) => {
          try { e.target.setVolume(volume); if (muted) e.target.mute(); else e.target.unMute(); } catch {}
          onReady && onReady(e);
        },
        onError: (e) => onError && onError(e),
      },
    });
    return {
      setVolume(v) { try { player.setVolume(v); if (v > 0) player.unMute(); } catch {} },
      setMuted(m) { try { if (m) player.mute(); else player.unMute(); } catch {} },
      destroy() { try { player.destroy(); } catch {} },
      // The next three exist so grid.js can watch for a live stream that has
      // silently stalled (see the stall watchdog there) and offer a manual
      // "jump to live" button -- see seekToLive below for why that's needed
      // at all.
      getCurrentTime() { try { return player.getCurrentTime(); } catch { return null; } },
      getPlayerState() { try { return player.getPlayerState(); } catch { return null; } },
      // For a live broadcast, getDuration() keeps returning "how far the
      // broadcast has gotten so far", i.e. the live edge -- there's no
      // dedicated "seek to live" call in the IFrame API, so seeking to that
      // value is the standard trick. This matters because YouTube's OWN
      // reconnect/reload control (shown over the thumbnail when a live
      // embed stalls) restarts playback from 0:00 instead of rejoining live,
      // which is the actual bug this method works around.
      seekToLive() {
        try {
          const d = player.getDuration();
          if (typeof d === "number" && isFinite(d) && d > 0) player.seekTo(d, true);
          player.playVideo();
        } catch {}
      },
    };
  }

  // Channel mode: embed YouTube's "current live broadcast for this channel"
  // URL directly as a plain iframe FIRST, so the stream shows up regardless
  // of whether the JS API can also attach to it. We then best-effort try to
  // adopt that iframe with YT.Player() to get volume control -- but if that
  // adoption never reports ready (it isn't as reliable as the normal videoId
  // constructor above), we must NOT tear down the iframe: the stream is very
  // likely still playing fine, we'd just be losing the volume slider.
  const iframe = document.createElement("iframe");
  iframe.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen; clipboard-write";
  iframe.allowFullscreen = true;
  iframe.referrerPolicy = "strict-origin-when-cross-origin";
  iframe.src = `https://www.youtube.com/embed/live_stream?channel=${encodeURIComponent(target.id)}` +
    `&autoplay=1&enablejsapi=1&origin=${encodeURIComponent(origin)}&playsinline=1&mute=${muted ? 1 : 0}`;
  container.appendChild(iframe);

  let apiPlayer = null;
  try {
    apiPlayer = new YT.Player(iframe, {
      events: {
        onReady: (e) => {
          try { e.target.setVolume(volume); if (muted) e.target.mute(); else e.target.unMute(); } catch {}
          onReady && onReady(e);
        },
        // A real API error here (private/not found/embedding disabled) means
        // the iframe genuinely won't show anything -- worth surfacing.
        onError: (e) => onError && onError(e),
      },
    });
  } catch (err) {
    console.warn("YouTube JS API could not attach to this channel embed; the stream will still play, just without an in-app volume slider.", err);
  }

  return {
    setVolume(v) { try { apiPlayer && apiPlayer.setVolume(v); if (v > 0) apiPlayer && apiPlayer.unMute(); } catch {} },
    setMuted(m) { try { apiPlayer && (m ? apiPlayer.mute() : apiPlayer.unMute()); } catch {} },
    destroy() { try { apiPlayer && apiPlayer.destroy(); } catch {} try { iframe.remove(); } catch {} },
    // See the equivalent block in the "video" mode branch above for why
    // these exist. apiPlayer can be null here (the JS API adoption of a
    // plain channel-embed iframe isn't guaranteed) -- callers already guard
    // on these being functions, so returning null/no-op is fine.
    getCurrentTime() { try { return apiPlayer ? apiPlayer.getCurrentTime() : null; } catch { return null; } },
    getPlayerState() { try { return apiPlayer ? apiPlayer.getPlayerState() : null; } catch { return null; } },
    seekToLive() {
      if (!apiPlayer) return;
      try {
        const d = apiPlayer.getDuration();
        if (typeof d === "number" && isFinite(d) && d > 0) apiPlayer.seekTo(d, true);
        apiPlayer.playVideo();
      } catch {}
    },
  };
}
