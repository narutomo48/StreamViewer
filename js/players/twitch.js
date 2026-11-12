// Twitch embedded video player wrapper.
// https://dev.twitch.tv/docs/embed/video-and-clips/
//
// IMPORTANT -- confirmed by direct testing (2026-11-12), after a long
// debugging session: Twitch's embed will not start playback from ANY
// programmatic play() call made from our page. Tried and confirmed
// ineffective, every one of them rejected by Twitch's own player page with
// "Autoplay disabled... minimum requirements... style visibility" in the
// console:
//   - the `autoplay: true` constructor option
//   - an explicit player.play() call right after the READY event
//   - retrying that on a timer
//   - tearing down and recreating the whole player from scratch
//   - calling play() from a click handler on OUR OWN button (a real user
//     click, just not inside Twitch's iframe)
// Ruled out along the way, by direct inspection of the failing instance:
// panel/iframe size (plenty big, well over Twitch's documented 400x300
// minimum), CSS visibility/opacity/display/transform on every ancestor (all
// normal), being covered by another element (nothing overlaps it), passing
// "100%" instead of real pixel numbers (fixed, no change), and the window
// not having focus (also not it).
//
// What DID work, every time: a genuine, direct click on Twitch's OWN play
// button, rendered inside its (cross-origin) iframe. That single real click
// starts it immediately and cleanly.
//
// Conclusion: this isn't a sizing, styling, or occlusion problem on our
// side -- Twitch's player requires a trusted user gesture dispatched
// *inside its own frame* before it will start, and no event handled by code
// in the parent page/frame ever counts as that, no matter how genuine the
// user's click on our own button was. This matches other developers'
// reports on Twitch's own dev forum of hitting the exact same wall with no
// confirmed fix: https://discuss.dev.twitch.com/t/embed-api-autoplay-disabled/64205
//
// So: we still ask for autoplay once (harmless, costs nothing, and maybe it
// works in some browser/condition we haven't seen), but we deliberately
// don't keep retrying or tearing down/recreating the player trying to force
// it -- that was proven to never help, and recreating the iframe out from
// under someone who's about to click its own (perfectly visible, working)
// native play button would only be disruptive. See README.md section 7 for
// the user-facing note about this.

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

  let destroyed = false;
  let current = null; // { div, player, messageHandler }
  let resizeObserver = null;
  let resizeDebounceTimer = null;
  let lastMeasuredW = 0;
  let lastMeasuredH = 0;
  // Twitch's own internal state broadcast (the "UPDATE_STATE" postMessage
  // its player iframe sends, carrying a "playback" field such as "Ready" /
  // "Idle" / "Playing") -- not part of the public Twitch.Player API, just
  // observed behavior, so it's read defensively. Used only to tell "already
  // actually playing" apart from "still showing the click-to-play overlay",
  // so a resize doesn't needlessly tear down a stream someone just started.
  let lastPlayback = null;

  function clearCurrent() {
    if (!current) return;
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

    // Real measured pixel numbers, not "100%" -- Twitch's own docs/examples
    // always use literal numbers, and getBoundingClientRect() forces a
    // synchronous layout so this is accurate even right after insertion.
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

    player.addEventListener(Twitch.Player.READY, () => {
      try { player.setVolume(clamp01(volume / 100)); } catch {}
      try { player.setMuted(!!muted); } catch {}
      // Worth asking once, in case it succeeds under some condition we
      // haven't seen -- but see the big comment at the top of this file for
      // why we don't retry this or tear down/recreate the player chasing it.
      try { player.play(); } catch {}
      onReady && onReady();
    });
    if (onOffline) {
      player.addEventListener(Twitch.Player.OFFLINE, onOffline);
    }
    player.addEventListener(Twitch.Player.ONLINE, () => {});

    return { div, player, messageHandler };
  }

  current = mountOnce();

  // If the user resizes the panel, rebuild the player with freshly measured
  // numbers (see mountOnce above) -- unless it's already genuinely playing
  // (per Twitch's own UPDATE_STATE broadcast), in which case tearing it down
  // would only interrupt a stream someone already clicked to start, for no
  // benefit: the embed already scales to fill its container visually either
  // way, the precise numbers only matter to Twitch's own check at creation
  // time.
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver((entries) => {
      if (destroyed || lastPlayback === "Playing") return;
      const entry = entries[0];
      if (!entry) return;
      const w = Math.round(entry.contentRect.width);
      const h = Math.round(entry.contentRect.height);
      if (!w || !h) return;
      if (Math.abs(w - lastMeasuredW) < 10 && Math.abs(h - lastMeasuredH) < 10) return;
      clearTimeout(resizeDebounceTimer);
      resizeDebounceTimer = setTimeout(() => {
        if (destroyed || lastPlayback === "Playing") return;
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
    // Resume helper for a stream that WAS already playing and then
    // stalled/paused (a buffering hiccup, etc.) -- NOT a fix for the
    // cold-start autoplay block described at the top of this file, since
    // that specifically requires a real click inside Twitch's own iframe,
    // which no programmatic call can substitute for.
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
