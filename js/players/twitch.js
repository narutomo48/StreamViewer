// Twitch embedded video player wrapper.
// https://dev.twitch.tv/docs/embed/video-and-clips/

let embedScriptPromise = null;

function ensureTwitchEmbedLoaded() {
  if (window.Twitch && window.Twitch.Player) return Promise.resolve(window.Twitch);
  if (embedScriptPromise) return embedScriptPromise;
  embedScriptPromise = new Promise((resolve, reject) => {
    const tag = document.createElement("script");
    tag.src = "https://embed.twitch.tv/embed/v1.js";
    tag.async = true;
    tag.onload = () => resolve(window.Twitch);
    tag.onerror = () => reject(new Error("Twitch embed script failed to load."));
    document.head.appendChild(tag);
  });
  return embedScriptPromise;
}

function clamp01(n) { return Math.min(1, Math.max(0, n)); }

function getTwitchParentList() {
  // Twitch requires the exact hostname(s) the page is served from (not a full URL, no protocol/port).
  const host = location.hostname || "localhost";
  const list = new Set([host, "localhost"]);
  return Array.from(list);
}

// target: { mode: "video", id } | { mode: "channel", login }
export async function createTwitchPlayer(container, target, opts = {}) {
  const { volume = 80, muted = false, onReady, onError, onOffline } = opts;
  let Twitch;
  try {
    Twitch = await ensureTwitchEmbedLoaded();
  } catch (err) {
    onError && onError(err);
    return { setVolume() {}, setMuted() {}, destroy() {} };
  }

  const div = document.createElement("div");
  const containerId = `twp_${Math.random().toString(36).slice(2)}`;
  div.id = containerId;
  div.style.width = "100%";
  div.style.height = "100%";
  container.appendChild(div);

  const playerOpts = {
    width: "100%",
    height: "100%",
    parent: getTwitchParentList(),
    autoplay: true,
    muted: !!muted,
  };
  if (target.mode === "video") playerOpts.video = target.id;
  else playerOpts.channel = target.login;

  const player = new Twitch.Player(containerId, playerOpts);

  player.addEventListener(Twitch.Player.READY, () => {
    try { player.setVolume(clamp01(volume / 100)); } catch {}
    try { player.setMuted(!!muted); } catch {}
    // The `autoplay: true` (and even `muted: true`) constructor options are
    // unreliable on Twitch's JS embed (unlike YouTube's IFrame API, which
    // honors its own autoplay param consistently) -- it frequently still
    // lands on Twitch's own click-to-play overlay instead of actually
    // starting playback. An explicit play() call right after READY is the
    // documented workaround and is harmless if it was already playing.
    try { player.play(); } catch {}
    onReady && onReady();
  });
  if (onOffline) {
    player.addEventListener(Twitch.Player.OFFLINE, onOffline);
  }
  player.addEventListener(Twitch.Player.ONLINE, () => {});

  // This is the real fix for the "stuck on the paused/click-to-play overlay"
  // case. Per Twitch's own docs, PLAYBACK_BLOCKED "is usually fired after an
  // unmuted autoplay or unmuted programmatic call on play()" -- i.e. Twitch's
  // player can end up attempting an UNMUTED autoplay internally regardless of
  // the `muted: true` option we passed above (several developers have
  // reported that flag being unreliable), which the browser's autoplay
  // policy then silently blocks, leaving the player paused forever with no
  // error. Browsers always allow MUTED autoplay, so forcing a muted restart
  // here reliably gets it moving. If the panel actually wants sound,
  // mountPlayer's ad-guard mute-then-restore timer (grid.js) unmutes it again
  // a few seconds later anyway, exactly as it does for a real pre-roll ad.
  let blockedRetries = 0;
  if (Twitch.Player.PLAYBACK_BLOCKED) {
    player.addEventListener(Twitch.Player.PLAYBACK_BLOCKED, () => {
      if (blockedRetries++ > 4) return; // don't retry forever if something else is wrong
      try { player.setMuted(true); } catch {}
      try { player.play(); } catch {}
    });
  }

  return {
    setVolume(v) { try { player.setVolume(clamp01(v / 100)); if (v > 0) player.setMuted(false); } catch {} },
    setMuted(m) { try { player.setMuted(!!m); } catch {} },
    destroy() { try { div.remove(); } catch {} },
  };
}
