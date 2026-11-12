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

// Twitch's embed is known to get stuck showing its own paused/click-to-play
// overlay forever instead of actually starting (unlike YouTube's IFrame API,
// which autoplays reliably). The PLAYBACK_BLOCKED event + forcing a muted
// play() covers the one *documented* cause (an unmuted autoplay attempt
// getting silently blocked by the browser), but in practice it can still get
// stuck with no PLAYBACK_BLOCKED firing at all -- so this also watches
// Twitch's own internal state broadcast (the "UPDATE_STATE" postMessage its
// player iframe sends, which carries a "playback" field such as "Ready" /
// "Idle" / "Playing" -- this isn't part of the public Twitch.Player API, just
// observed behavior, so it's read defensively) and, if playback never
// actually reaches "Playing" within a few seconds, retries play() and -- as a
// last resort -- tears down and recreates the whole player, since a fresh
// instance sometimes succeeds where a stuck one won't.
const STARTED_CHECK_DELAYS_MS = [3000, 6500, 11000]; // when to check "did it actually start playing yet"
const MAX_RECREATE_ATTEMPTS = 3;

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

  let destroyed = false;
  let current = null; // { div, player, messageHandler, timers: number[] }
  let recreateAttempts = 0;
  let resizeObserver = null;
  let resizeDebounceTimer = null;
  let lastMeasuredW = 0;
  let lastMeasuredH = 0;

  function clearCurrent() {
    if (!current) return;
    for (const t of current.timers) clearTimeout(t);
    if (current.messageHandler) window.removeEventListener("message", current.messageHandler);
    try { current.div.remove(); } catch {}
    current = null;
  }

  function mountOnce() {
    const div = document.createElement("div");
    const containerId = `twp_${Math.random().toString(36).slice(2)}`;
    div.id = containerId;
    div.style.width = "100%";
    div.style.height = "100%";
    container.appendChild(div);

    // Twitch's own docs/examples always pass literal pixel NUMBERS here,
    // never a percentage string -- and its dev forum has reports that a
    // "100%" width/height can leave Twitch's embed unable to numerically
    // verify the rendered size against its own minimum-size-for-autoplay
    // check, which it apparently treats conservatively as not meeting the
    // requirement (see "style visibility" discussion:
    // https://discuss.dev.twitch.com/t/embed-api-autoplay-disabled/64205).
    // That matches what we're seeing exactly: the error fires every single
    // time regardless of how big the panel actually looks on screen,
    // because Twitch was never told a real number to check against -- it
    // was only ever handed the string "100%". Measuring the container's own
    // current rendered box (getBoundingClientRect forces a synchronous
    // layout, so this is accurate even right after insertion) and handing
    // Twitch that as plain numbers should let it verify correctly instead
    // of refusing to autoplay out of caution.
    const rect = container.getBoundingClientRect();
    const measuredW = Math.round(rect.width) || 480;
    const measuredH = Math.round(rect.height) || 300;
    lastMeasuredW = measuredW;
    lastMeasuredH = measuredH;

    const playerOpts = {
      width: measuredW,
      height: measuredH,
      parent: getTwitchParentList(),
      autoplay: true,
      muted: !!muted,
    };
    if (target.mode === "video") playerOpts.video = target.id;
    else playerOpts.channel = target.login;

    const player = new Twitch.Player(containerId, playerOpts);
    const timers = [];
    let lastPlayback = null;
    let blockedRetries = 0;

    const messageHandler = (e) => {
      if (destroyed || !current || current.player !== player) return;
      if (typeof e.data !== "string" || !e.data.includes("UPDATE_STATE")) return;
      // Scope to this player's own iframe, not any other Twitch embed on the
      // page (multiple panels can each be running one of these).
      const iframeEl = div.querySelector("iframe");
      if (!iframeEl || e.source !== iframeEl.contentWindow) return;
      try {
        const parsed = JSON.parse(e.data);
        if (parsed && parsed.eventName === "UPDATE_STATE" && parsed.params) {
          lastPlayback = parsed.params.playback;
        }
      } catch {}
    };
    window.addEventListener("message", messageHandler);

    function tryRecover() {
      try { player.setMuted(true); } catch {}
      try { player.play(); } catch {}
    }

    function checkStarted(isLast) {
      if (destroyed || !current || current.player !== player) return;
      if (lastPlayback === "Playing") return; // all good, nothing to do
      tryRecover();
      if (isLast && lastPlayback !== "Playing") {
        // Still not playing after retrying play() a couple of times -- a
        // full teardown/remount occasionally succeeds where nudging the
        // stuck instance doesn't.
        if (recreateAttempts < MAX_RECREATE_ATTEMPTS) {
          recreateAttempts++;
          clearCurrent();
          current = mountOnce();
        }
      }
    }

    STARTED_CHECK_DELAYS_MS.forEach((delay, i) => {
      timers.push(setTimeout(() => checkStarted(i === STARTED_CHECK_DELAYS_MS.length - 1), delay));
    });

    player.addEventListener(Twitch.Player.READY, () => {
      try { player.setVolume(clamp01(volume / 100)); } catch {}
      try { player.setMuted(!!muted); } catch {}
      // The `autoplay: true` (and even `muted: true`) constructor options are
      // unreliable on Twitch's JS embed -- an explicit play() call right
      // after READY is a documented-by-example workaround and is harmless if
      // it was already playing.
      try { player.play(); } catch {}
      onReady && onReady();
    });
    if (onOffline) {
      player.addEventListener(Twitch.Player.OFFLINE, onOffline);
    }
    player.addEventListener(Twitch.Player.ONLINE, () => {});

    // The one *documented* cause of getting stuck: Twitch's own docs say
    // PLAYBACK_BLOCKED "is usually fired after an unmuted autoplay or
    // unmuted programmatic call on play()". Browsers always allow MUTED
    // autoplay, so forcing a muted restart here reliably gets it moving; if
    // the panel actually wants sound, mountPlayer's ad-guard mute-then-restore
    // timer (grid.js) unmutes it again a few seconds later anyway, exactly
    // as it does for a real pre-roll ad.
    if (Twitch.Player.PLAYBACK_BLOCKED) {
      player.addEventListener(Twitch.Player.PLAYBACK_BLOCKED, () => {
        if (blockedRetries++ > 4) return; // don't retry forever if something else is wrong
        tryRecover();
      });
    }

    return { div, player, messageHandler, timers };
  }

  current = mountOnce();

  // The pixel numbers above are only measured once, at creation -- if the
  // user later drags the panel's own resize handle, the Twitch-created
  // iframe doesn't know to follow along (it was told fixed numbers, not
  // "100%"), so without this it would stay whatever size it started at.
  // Watch the actual container for real size changes and rebuild the player
  // with freshly-measured numbers when one happens; ignore tiny jitter
  // (sub-pixel reflows) and debounce so a drag-resize only rebuilds once,
  // after the user lets go, rather than on every intermediate frame.
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver((entries) => {
      if (destroyed) return;
      const entry = entries[0];
      if (!entry) return;
      const w = Math.round(entry.contentRect.width);
      const h = Math.round(entry.contentRect.height);
      if (!w || !h) return;
      if (Math.abs(w - lastMeasuredW) < 10 && Math.abs(h - lastMeasuredH) < 10) return;
      clearTimeout(resizeDebounceTimer);
      resizeDebounceTimer = setTimeout(() => {
        if (destroyed) return;
        recreateAttempts = 0; // a deliberate resize, not a stuck-playback retry -- don't eat into that budget
        clearCurrent();
        current = mountOnce();
      }, 400);
    });
    resizeObserver.observe(container);
  }

  return {
    setVolume(v) {
      try {
        if (current) { current.player.setVolume(clamp01(v / 100)); if (v > 0) current.player.setMuted(false); }
      } catch {}
    },
    setMuted(m) { try { if (current) current.player.setMuted(!!m); } catch {} },
    // Manual escape hatch for the "stuck on Twitch's own paused overlay"
    // case, wired to a debug button in the panel header -- lets us (and the
    // user) see live what pressing "force play" actually does, without
    // waiting for the automatic retry timers above.
    forcePlay() {
      try {
        if (!current) return;
        current.player.setMuted(true);
        current.player.play();
      } catch {}
    },
    destroy() {
      destroyed = true;
      clearTimeout(resizeDebounceTimer);
      if (resizeObserver) resizeObserver.disconnect();
      clearCurrent();
    },
  };
}
