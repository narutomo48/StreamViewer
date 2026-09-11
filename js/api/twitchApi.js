// Thin wrapper around the Twitch Helix API. All calls need a user access
// token (from auth/twitchAuth.js) plus the app's Client-Id -- Twitch has no
// "public API key" mode, but the free implicit OAuth login covers everything
// this app needs (no client secret, no payment, generous rate limits).

import { getTwitchAccessToken, getTwitchClientId } from "../auth/twitchAuth.js";

const API_BASE = "https://api.twitch.tv/helix";

async function apiFetch(path, params = {}) {
  const token = getTwitchAccessToken();
  const clientId = getTwitchClientId();
  if (!token) throw new Error("Twitchにログインしてください。");
  if (!clientId) throw new Error("設定画面で Twitch のクライアントID を入力してください。");

  const url = new URL(`${API_BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((val) => url.searchParams.append(k, val));
    else if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, "Client-Id": clientId },
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).message || ""; } catch {}
    throw new Error(`Twitch API エラー (${res.status}) ${detail}`.trim());
  }
  return res.json();
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Returns [{ userId, login, displayName, avatar }]
// See the equivalent note in youtubeApi.js -- this is a runaway-loop safety
// net, not a realistic ceiling (100/page x 30 pages = 3000 follows).
export async function fetchMyFollowedChannels({ maxPages = 30 } = {}) {
  const token = getTwitchAccessToken();
  const clientId = getTwitchClientId();
  if (!token || !clientId) throw new Error("Twitchにログインしてください。");

  // Need our own user id first.
  const me = await apiFetch("users");
  const myId = me.data && me.data[0] && me.data[0].id;
  if (!myId) throw new Error("Twitchユーザー情報の取得に失敗しました。");

  const follows = [];
  let cursor;
  for (let i = 0; i < maxPages; i++) {
    const data = await apiFetch("channels/followed", { user_id: myId, first: 100, after: cursor });
    for (const f of data.data || []) {
      follows.push({ userId: f.broadcaster_id, login: f.broadcaster_login, displayName: f.broadcaster_name });
    }
    cursor = data.pagination && data.pagination.cursor;
    if (!cursor || !(data.data || []).length) break;
  }

  // Batch-fetch avatars (100 ids per call max).
  const avatarMap = new Map();
  for (const group of chunk(follows.map((f) => f.userId), 100)) {
    if (!group.length) continue;
    const data = await apiFetch("users", { id: group });
    for (const u of data.data || []) avatarMap.set(u.id, u.profile_image_url);
  }

  return follows.map((f) => ({ ...f, avatar: avatarMap.get(f.userId) || "" }));
}

// Fetch profile info for one or more known logins (no login needed beyond having a valid token).
export async function fetchUsersByLogin(logins) {
  const arr = Array.isArray(logins) ? logins : [logins];
  if (!arr.length) return [];
  const results = [];
  for (const group of chunk(arr, 100)) {
    const data = await apiFetch("users", { login: group });
    for (const u of data.data || []) {
      results.push({ userId: u.id, login: u.login, displayName: u.display_name, avatar: u.profile_image_url });
    }
  }
  return results;
}

// Returns a map userId -> live stream info (title, thumbnail, game, viewers) for whichever of the given ids are currently live.
export async function fetchLiveStreams(userIds) {
  const result = new Map();
  for (const group of chunk(userIds, 100)) {
    if (!group.length) continue;
    const data = await apiFetch("streams", { user_id: group });
    for (const s of data.data || []) {
      result.set(s.user_id, {
        title: s.title,
        thumbnail: (s.thumbnail_url || "").replace("{width}", "320").replace("{height}", "180"),
        game: s.game_name,
        viewers: s.viewer_count,
        startedAt: s.started_at,
      });
    }
  }
  return result;
}

// Lists a channel's past broadcasts (VODs).
export async function fetchChannelArchive(userId, cursor) {
  const data = await apiFetch("videos", { user_id: userId, type: "archive", first: 12, after: cursor });
  const items = (data.data || []).map((v) => ({
    id: v.id,
    title: v.title,
    thumbnail: (v.thumbnail_url || "").replace("%{width}", "320").replace("%{height}", "180"),
    publishedAt: v.published_at,
    duration: v.duration,
  }));
  return { items, nextCursor: data.pagination && data.pagination.cursor };
}
