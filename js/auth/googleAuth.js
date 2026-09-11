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
