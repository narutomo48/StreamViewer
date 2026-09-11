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
    onReady && onReady();
  });
  if (onOffline) {
    player.addEventListener(Twitch.Player.OFFLINE, onOffline);
  }
  player.addEventListener(Twitch.Player.ONLINE, () => {});

  return {
    setVolume(v) { try { player.setVolume(clamp01(v / 100)); if (v > 0) player.setMuted(false); } catch {} },
    setMuted(m) { try { player.setMuted(!!m); } catch {} },
    destroy() { try { div.remove(); } catch {} },
  };
}
