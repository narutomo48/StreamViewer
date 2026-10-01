// Thin wrappers around YouTube Data API v3.
// - subscriptions.list / channels.list need an OAuth access token (user login).
// - playlistItems.list (archive) and channels.list (id resolution) work with
//   just a free API key.
//
// Quota note (free tier = 10,000 units/day): subscriptions.list, channels.list
// and playlistItems.list each cost ~1 unit, but search.list (used to check
// whether a channel is currently live) costs 100 units per call -- so live-
// status checks are done on demand (manual refresh), not polled automatically.

import { getState } from "../state.js";
import { getYoutubeAccessToken } from "../auth/googleAuth.js";

const API_BASE = "https://www.googleapis.com/youtube/v3";

function apiKey() {
  return (getState().settings.youtubeApiKey || "").trim();
}

async function apiFetch(path, params = {}, { needAuth = false } = {}) {
  const url = new URL(`${API_BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);

  const headers = {};
  const token = getYoutubeAccessToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  else if (needAuth) throw new Error("YouTubeにログインしてください。");
  else {
    const key = apiKey();
    if (!key) throw new Error("設定画面で YouTube Data API キーを入力してください。");
    url.searchParams.set("key", key);
  }

  const res = await fetch(url.toString(), { headers });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).error?.message || ""; } catch {}
    throw new Error(`YouTube API エラー (${res.status}) ${detail}`.trim());
  }
  return res.json();
}

// Returns [{ channelId, title, avatar }]
// maxPages is just a runaway-loop safety net, not a realistic ceiling: at 50
// channels/page x 60 pages = 3000 channels, ~60 quota units total (out of the
// free 10,000/day) -- comfortably above what any real subscription list needs.
// (An earlier, much lower cap here silently cut off the list partway through
// for anyone subscribed to more than 250 channels.)
export async function fetchMySubscriptions({ maxPages = 60 } = {}) {
  const results = [];
  let pageToken = undefined;
  for (let i = 0; i < maxPages; i++) {
    const data = await apiFetch("subscriptions", {
      part: "snippet",
      mine: "true",
      maxResults: 50,
      order: "alphabetical",
      pageToken,
    }, { needAuth: true });
    for (const item of data.items || []) {
      results.push({
        channelId: item.snippet.resourceId.channelId,
        title: item.snippet.title,
        avatar: item.snippet.thumbnails?.default?.url || "",
      });
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return results;
}

// Resolve a @handle or legacy /user/ username to a channel ID (UC...).
// idType: "handle" | "user"
export async function resolveChannelId(idType, value) {
  const params = { part: "id,snippet" };
  if (idType === "handle") params.forHandle = value.startsWith("@") ? value : `@${value}`;
  else if (idType === "user") params.forUsername = value;
  else throw new Error("このURL形式はAPIキーだけでは解決できません(カスタムURL /c/ など)。チャンネルの動画URLを直接追加してください。");

  const data = await apiFetch("channels", params);
  const item = data.items && data.items[0];
  if (!item) throw new Error("チャンネルが見つかりませんでした。");
  return {
    channelId: item.id,
    title: item.snippet?.title || value,
    avatar: item.snippet?.thumbnails?.default?.url || "",
  };
}

// Fetch title/avatar for one or more known channel IDs (1 unit per call, up to 50 ids).
export async function fetchChannelMeta(channelIds) {
  const ids = Array.isArray(channelIds) ? channelIds : [channelIds];
  if (!ids.length) return [];
  const data = await apiFetch("channels", { part: "snippet", id: ids.join(","), maxResults: 50 });
  return (data.items || []).map((item) => ({
    channelId: item.id,
    title: item.snippet?.title || "",
    avatar: item.snippet?.thumbnails?.default?.url || "",
  }));
}

// Checks whether a channel currently has a live broadcast.
// Costs 100 quota units per call (search.list) -- call sparingly / on user
// request. A follow-up videos.list call (1 unit) grabs actualStartTime /
// concurrentViewers so the sidebar can show elapsed time + viewer count;
// that part is best-effort and never fails the whole lookup.
export async function checkChannelLive(channelId) {
  const data = await apiFetch("search", {
    part: "snippet",
    channelId,
    eventType: "live",
    type: "video",
    maxResults: 1,
  });
  const item = data.items && data.items[0];
  if (!item) return null;
  const videoId = item.id.videoId;

  let startedAt = null;
  let viewers = null;
  try {
    const vidData = await apiFetch("videos", { part: "liveStreamingDetails", id: videoId });
    const details = vidData.items && vidData.items[0] && vidData.items[0].liveStreamingDetails;
    if (details) {
      startedAt = details.actualStartTime || null;
      viewers = details.concurrentViewers != null ? Number(details.concurrentViewers) : null;
    }
  } catch (err) {
    console.warn("Failed to fetch liveStreamingDetails (elapsed time / viewer count unavailable)", err);
  }

  return {
    videoId,
    title: item.snippet.title,
    thumbnail: item.snippet.thumbnails?.medium?.url || "",
    startedAt,
    viewers,
  };
}

// Lists a channel's past uploads (used as a stand-in for "archive" -- ended
// broadcasts show up here once they finish processing).
export async function fetchChannelArchive(channelId, pageToken) {
  const chData = await apiFetch("channels", { part: "contentDetails", id: channelId });
  const uploadsId = chData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsId) return { items: [], nextPageToken: null };

  const plData = await apiFetch("playlistItems", {
    part: "snippet",
    playlistId: uploadsId,
    maxResults: 12,
    pageToken,
  });
  const items = (plData.items || []).map((it) => ({
    videoId: it.snippet.resourceId.videoId,
    title: it.snippet.title,
    thumbnail: it.snippet.thumbnails?.medium?.url || it.snippet.thumbnails?.default?.url || "",
    publishedAt: it.snippet.publishedAt,
  }));
  return { items, nextPageToken: plData.nextPageToken || null };
}
