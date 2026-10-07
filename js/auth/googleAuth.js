// Google Identity Services (GIS) token client -- client-side OAuth, no
// client secret required. Needs only an OAuth Client ID (Web application
// type) registered in Google Cloud Console with this page's origin listed
// under "Authorized JavaScript origins". See README.md for setup steps.

import { getState, update } from "../state.js";

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
// client supports requesting a fresh token with prompt:"" -- if the user is
// still signed into their Google account in this browser and has already
// granted this app's scope before, that resolves with a new token with
// little to no visible UI, instead of requiring a click on "YouTubeでログイン"
// every time the ~1 hour access token expires. Call this once at startup;
// it keeps renewing itself in the background for as long as the tab stays
// open. A failed attempt (e.g. the user isn't actively signed into Google
// right now) is left silent -- the existing manual login button is still
// there as a fallback, so there's no need to interrupt the user over a
// background refresh they never asked for directly.
export function startYoutubeSilentRefresh() {
  const tick = () => {
    const auth = getState().auth.youtube;
    if (!auth || !auth.accessToken) return; // never signed in -- nothing to refresh
    if (auth.expiresAt - Date.now() > SILENT_REFRESH_LEAD_MS) return; // still fresh enough
    if (!(getState().settings.youtubeClientId || "").trim()) return;
    signInYoutube().catch((err) => {
      console.warn("YouTubeトークンのサイレント更新に失敗しました", err);
    });
  };
  tick(); // catch a token that's already stale (or near-stale) right at startup too
  setInterval(tick, SILENT_REFRESH_CHECK_MS);
}
