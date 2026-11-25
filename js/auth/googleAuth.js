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

// How far ahead of actual expiry to renew the token (catch it before
// anything relying on a valid token hits a gap, not after).
const SILENT_REFRESH_LEAD_MS = 5 * 60 * 1000;

// Unlike Twitch's implicit grant (see twitchAuth.js / main.js), GIS's token
// client supports requesting a fresh token with prompt:"" -- when it works,
// this resolves with a new token with little to no visible UI, instead of
// requiring a click on "YouTubeでログイン" every time the ~1 hour access
// token expires. Call this once at startup, to pick up a token that's
// already stale (or close to it) from a previous session before anything
// else runs.
//
// In practice this is NOT reliable in current Chrome: GIS's "silent" path
// relies on reading the user's Google sign-in state through a third-party
// iframe, which Chrome's third-party-cookie restrictions can break -- when
// that happens, GIS falls back to opening an actual popup window to
// re-confirm, and a popup opened by code that wasn't triggered by a direct
// user click/tap gets blocked by the browser's own popup blocker, so the
// attempt just fails outright ("Failed to open popup window" in the
// console). A failed attempt just falls back to the existing manual
// "YouTubeでログイン" button -- see the toast in tick() below so that
// fallback isn't a silent, unexplained dead end for someone who used to be
// logged in.
//
// IMPORTANT (2026-11-25): this used to also retry itself every 5 minutes in
// the background (setInterval) for as long as the tab stayed open, so a
// long session would never need a manual re-login at all. That recurring
// background attempt was removed after a report that, on mobile (installed
// PWA), it could coincide with the phone's network changing (wifi<->
// cellular) mid-session and turn into Chrome's own "ネットワークの変更が
// 検出されました" error page replacing the whole app view, with no way back
// short of relaunching the app entirely -- worse than just having to click
// "YouTubeでログイン" again once the ~1 hour token actually expires. The
// one-time startup attempt below is harmless by comparison (nothing's on
// screen yet to lose) and is kept.
//
// Returns a promise that settles once this startup attempt (if any was
// needed) is done -- callers like main.js can await it to know when it's
// safe to check "is YouTube actually signed in" for anything that should
// happen right after auto-login (e.g. an initial live-status refresh).
export function startYoutubeSilentRefresh() {
  const auth = getState().auth.youtube;
  if (!auth || !auth.accessToken) return Promise.resolve(); // never signed in -- nothing to refresh
  if (auth.expiresAt - Date.now() > SILENT_REFRESH_LEAD_MS) return Promise.resolve(); // still fresh enough
  if (!(getState().settings.youtubeClientId || "").trim()) return Promise.resolve();
  return signInYoutube().catch((err) => {
    console.warn("YouTubeトークンのサイレント更新に失敗しました", err);
    toast("YouTubeの自動ログインに失敗しました。お手数ですが「YouTubeでログイン」ボタンを押してください。", "error", 8000);
  });
}
