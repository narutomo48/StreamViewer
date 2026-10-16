// Google Identity Services (GIS) token client -- client-side OAuth, no
// client secret required. Needs only an OAuth Client ID (Web application
// type) registered in Google Cloud Console with this page's origin listed
// under "Authorized JavaScript origins". See README.md for setup steps.

import { getState, update } from "../state.js";
import { toast } from "../utils/dom.js";

let gisLoadPromise = null;
let tokenClient = null;

function ensureGisLoaded() {
  if (window.google && window.google.accounts && window.google.accounts.oauth2) return Promise.resolve();
  if (gisLoadPromise) return gisLoadPromise;
  gisLoadPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Google Identity Services の読み込みに失敗しました。ネットワーク接続を確認してください。"));
    document.head.appendChild(s);
  });
  return gisLoadPromise;
}

export function isYoutubeSignedIn() {
  const auth = getState().auth.youtube;
  return !!(auth && auth.accessToken && auth.expiresAt > Date.now());
}

export function getYoutubeAccessToken() {
  const auth = getState().auth.youtube;
  if (auth && auth.accessToken && auth.expiresAt > Date.now()) return auth.accessToken;
  return null;
}

export async function signInYoutube() {
  const clientId = (getState().settings.youtubeClientId || "").trim();
  if (!clientId) throw new Error("設定画面で YouTube の OAuth クライアントID を入力してください。");
  await ensureGisLoaded();
  return new Promise((resolve, reject) => {
    try {
      tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: "https://www.googleapis.com/auth/youtube.readonly",
        callback: (resp) => {
          if (!resp || resp.error) {
            reject(new Error((resp && resp.error) || "YouTube のログインに失敗しました。"));
            return;
          }
          const expiresAt = Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000;
          update((s) => { s.auth.youtube = { accessToken: resp.access_token, expiresAt }; });
          resolve(resp.access_token);
        },
        error_callback: (err) => reject(new Error(err && err.message ? err.message : "YouTube のログインがキャンセルされました。")),
      });
      tokenClient.requestAccessToken({ prompt: "" });
    } catch (err) {
      reject(err);
    }
  });
}

export function signOutYoutube() {
  const auth = getState().auth.youtube;
  try {
    if (auth && auth.accessToken && window.google && window.google.accounts && window.google.accounts.oauth2) {
      window.google.accounts.oauth2.revoke(auth.accessToken, () => {});
    }
  } catch {}
  update((s) => { s.auth.youtube = null; });
}

// How often to check whether the token needs renewing, and how far ahead of
// actual expiry to renew it (catch it before anything relying on a valid
// token hits a gap, not after).
const SILENT_REFRESH_CHECK_MS = 5 * 60 * 1000;
const SILENT_REFRESH_LEAD_MS = 5 * 60 * 1000;

// Unlike Twitch's implicit grant (see twitchAuth.js / main.js), GIS's token
// client supports requesting a fresh token with prompt:"" -- when it works,
// this resolves with a new token with little to no visible UI, instead of
// requiring a click on "YouTubeでログイン" every time the ~1 hour access
// token expires. Call this once at startup; it keeps renewing itself in the
// background for as long as the tab stays open.
//
// In practice this is NOT reliable in current Chrome: GIS's "silent" path
// relies on reading the user's Google sign-in state through a third-party
// iframe, which Chrome's third-party-cookie restrictions can break -- when
// that happens, GIS falls back to opening an actual popup window to
// re-confirm, and a popup opened by code that wasn't triggered by a direct
// user click/tap (this runs from a background timer) gets blocked by the
// browser's own popup blocker, so the attempt just fails outright
// ("Failed to open popup window" in the console). There's no reliable way
// around that from here short of requiring a real click every time, so a
// failed attempt just falls back to the existing manual "YouTubeでログイン"
// button -- see the one-time toast in tick() below so that fallback isn't a
// silent, unexplained dead end for someone who used to be logged in.
//
// Returns a promise that settles once this startup attempt (if any was
// needed) is done -- callers like main.js can await it to know when it's
// safe to check "is YouTube actually signed in" for anything that should
// happen right after auto-login (e.g. an initial live-status refresh),
// instead of racing the background refresh that's still in flight.
export function startYoutubeSilentRefresh() {
  let isInitialAttempt = true;
  const tick = () => {
    const auth = getState().auth.youtube;
    if (!auth || !auth.accessToken) return Promise.resolve(); // never signed in -- nothing to refresh
    if (auth.expiresAt - Date.now() > SILENT_REFRESH_LEAD_MS) return Promise.resolve(); // still fresh enough
    if (!(getState().settings.youtubeClientId || "").trim()) return Promise.resolve();
    const notifyOnFailure = isInitialAttempt; // only the startup attempt announces failure -- see below
    isInitialAttempt = false;
    return signInYoutube().catch((err) => {
      console.warn("YouTubeトークンのサイレント更新に失敗しました", err);
      // Only announce this on the startup attempt, not on every 5-minute
      // retry while the tab stays open -- otherwise someone who's simply
      // choosing to stay logged out would get re-nagged every 5 minutes.
      if (notifyOnFailure) {
        toast("YouTubeの自動ログインに失敗しました。お手数ですが「YouTubeでログイン」ボタンを押してください。", "error", 8000);
      }
    });
  };
  const initialAttempt = tick(); // catch a token that's already stale (or near-stale) right at startup too
  setInterval(tick, SILENT_REFRESH_CHECK_MS);
  return initialAttempt;
}
