// Detects YouTube / Twitch targets from a pasted URL, handle, or bare ID.
//
// Returns one of:
//   { platform: "youtube", mode: "video",   id: "<videoId>" }
//   { platform: "youtube", mode: "channel", idType: "channelId"|"handle"|"custom"|"user", id: "<value>" }
//   { platform: "twitch",  mode: "video",   id: "<vodId>" }
//   { platform: "twitch",  mode: "channel", login: "<login>" }
//   null  -- could not confidently determine

const YT_VIDEO_ID_RE = /^[a-zA-Z0-9_-]{10,12}$/;
const TWITCH_LOGIN_RE = /^[a-zA-Z0-9_]{3,25}$/;

export function parseStreamInput(rawInput, platformHint = "auto") {
  const input = (rawInput || "").trim();
  if (!input) return null;

  let url = null;
  try {
    url = new URL(input.includes("://") ? input : `https://${input}`);
  } catch {
    url = null;
  }

  if (url && /(^|\.)youtube\.com$/.test(url.hostname)) {
    const yt = parseYoutubeUrl(url);
    if (yt) return yt;
  }
  if (url && /(^|\.)youtu\.be$/.test(url.hostname)) {
    const id = url.pathname.split("/").filter(Boolean)[0];
    if (id) return { platform: "youtube", mode: "video", id };
  }
  if (url && /(^|\.)twitch\.tv$/.test(url.hostname)) {
    const tw = parseTwitchUrl(url);
    if (tw) return tw;
  }

  // Not a recognizable full URL -> treat as bare id/handle/login using the hint.
  if (platformHint === "youtube") return parseYoutubeBare(input);
  if (platformHint === "twitch") return parseTwitchBare(input);

  // auto: heuristics
  if (input.startsWith("@")) return { platform: "youtube", mode: "channel", idType: "handle", id: input };
  if (/^UC[a-zA-Z0-9_-]{22}$/.test(input)) return { platform: "youtube", mode: "channel", idType: "channelId", id: input };
  if (YT_VIDEO_ID_RE.test(input) && /[A-Z_-]/.test(input)) {
    // Looks more like an opaque YouTube video id (mixed case / symbols) than a plain word.
    return { platform: "youtube", mode: "video", id: input };
  }
  if (TWITCH_LOGIN_RE.test(input)) {
    // Ambiguous: could be a YouTube legacy username or a Twitch login.
    // Default to Twitch since plain lowercase handles are far more common there.
    return { platform: "twitch", mode: "channel", login: input.toLowerCase() };
  }
  return null;
}

function parseYoutubeUrl(url) {
  const parts = url.pathname.split("/").filter(Boolean);
  const v = url.searchParams.get("v");
  if (v) return { platform: "youtube", mode: "video", id: v };

  if (parts[0] === "live" && parts[1]) return { platform: "youtube", mode: "video", id: parts[1] };
  if (parts[0] === "embed" && parts[1]) return { platform: "youtube", mode: "video", id: parts[1] };
  if (parts[0] === "shorts" && parts[1]) return { platform: "youtube", mode: "video", id: parts[1] };

  if (parts[0] === "channel" && parts[1]) {
    return { platform: "youtube", mode: "channel", idType: "channelId", id: parts[1] };
  }
  if (parts[0] === "c" && parts[1]) {
    return { platform: "youtube", mode: "channel", idType: "custom", id: parts[1] };
  }
  if (parts[0] === "user" && parts[1]) {
    return { platform: "youtube", mode: "channel", idType: "user", id: parts[1] };
  }
  if (parts[0] && parts[0].startsWith("@")) {
    return { platform: "youtube", mode: "channel", idType: "handle", id: parts[0] };
  }
  return null;
}

function parseYoutubeBare(input) {
  if (input.startsWith("@")) return { platform: "youtube", mode: "channel", idType: "handle", id: input };
  if (/^UC[a-zA-Z0-9_-]{22}$/.test(input)) return { platform: "youtube", mode: "channel", idType: "channelId", id: input };
  if (YT_VIDEO_ID_RE.test(input)) return { platform: "youtube", mode: "video", id: input };
  return { platform: "youtube", mode: "channel", idType: "handle", id: input.startsWith("@") ? input : `@${input}` };
}

function parseTwitchUrl(url) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "videos" && parts[1]) return { platform: "twitch", mode: "video", id: parts[1] };
  if (parts.length >= 3 && parts[1] === "video" && parts[2]) return { platform: "twitch", mode: "video", id: parts[2] };
  if (parts[0] && !["directory", "p", "settings", "subscriptions", "downloads"].includes(parts[0])) {
    return { platform: "twitch", mode: "channel", login: parts[0].toLowerCase() };
  }
  return null;
}

function parseTwitchBare(input) {
  const login = input.replace(/^@/, "").toLowerCase();
  if (/^\d+$/.test(input)) return { platform: "twitch", mode: "video", id: input };
  return { platform: "twitch", mode: "channel", login };
}

// Human-readable label used while we don't yet know the channel's real name (no API key configured).
export function fallbackLabel(target) {
  if (!target) return "";
  if (target.platform === "youtube") {
    if (target.mode === "video") return `YouTube: ${target.id}`;
    return `YouTube: ${target.id}`;
  }
  if (target.platform === "twitch") {
    if (target.mode === "video") return `Twitch VOD: ${target.id}`;
    return `Twitch: ${target.login}`;
  }
  return "配信";
}
