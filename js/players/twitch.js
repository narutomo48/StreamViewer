// Twitch embedded video player wrapper.
// https://dev.twitch.tv/docs/embed/video-and-clips/
//
// IMPORTANT -- confirmed by direct testing (2026-11-12), after a long
// debugging session: Twitch's embed will not start playback from ANY
// programmatic play() call made from our page. Tried and confirmed to make
// zero difference: the `autoplay: true` constructor option, an explicit
// player.play() call right after READY, retrying that on a timer, tearing
// down and recreating the whole player, passing measured real pixel
// width/height instead of "100%", watching for resizes to rebuild the
// player, and a manual "force play" button wired to a real click. Every one
// of those gets rejected by Twitch's own player page with "Autoplay
// disabled... style visibility" in the console.
//
// What DID work, every time: a genuine, direct click on Twitch's OWN play
// button, rendered inside its (cross-origin) iframe. Twitch's player
// requires a trusted user gesture dispatched *inside its own frame* before
// it will start, and no event handled by code in the parent page/frame ever
// counts as that -- see other developers hitting the same wall on Twitch's
// own dev forum, with no confirmed fix:
// https://discuss.dev.twitch.com/t/embed-api-autoplay-disabled/64205
//
// So this wrapper is intentionally simple: ask for autoplay/play() once
// (harmless, costs nothing), and otherwise get out of the way. All the
// retry/recreate/resize-watching machinery tried along the way only added
// complexity and risk (e.g. rebuilding the iframe out from under someone
// about to click its play button) for zero actual benefit, so none of it is
// kept. See README.md section 7 for the user-facing note about this.

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

  const containerId = `twp_${Math.random().toString(36).slice(2)}`;
  const div = document.createElement("div");
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
    // unreliable on Twitch's JS embed -- an explicit play() call right
    // after READY is a documented-by-example workaround, and is harmless if
    // it was already playing. See the big comment at the top of this file
    // for why we don't go further than this single attempt.
    try { player.play(); } catch {}
    onReady && onReady();
  });
  if (onOffline) {
    player.addEventListener(Twitch.Player.OFFLINE, onOffline);
  }
  player.addEventListener(Twitch.Player.ONLINE, () => {});

  return {
    setVolume(v) {
      try { player.setVolume(clamp01(v / 100)); if (v > 0) player.setMuted(false); } catch {}
    },
    setMuted(m) { try { player.setMuted(!!m); } catch {} },
    destroy() {
      try { div.remove(); } catch {}
    },
  };
}
