// Twitch OAuth "implicit" flow -- client-side only, no client secret.
// https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#implicit-grant-flow
// Needs a Twitch app (free, dev.twitch.tv/console) with this page's exact
// URL registered as an OAuth Redirect URL. See README.md for setup steps.

import { getState, update } from "../state.js";

const AUTH_BASE = "https://id.twitch.tv/oauth2/authorize";
const SCOPES = ["user:read:follows", "user:read:email"];
const STATE_KEY = "sv_twitch_oauth_state";

export function isTwitchSignedIn() {
  const auth = getState().auth.twitch;
  return !!(auth && auth.accessToken && auth.expiresAt > Date.now());
}

export function getTwitchAccessToken() {
  const auth = getState().auth.twitch;
  if (auth && auth.accessToken && auth.expiresAt > Date.now()) return auth.accessToken;
  return null;
}

export function getTwitchClientId() {
  return (getState().settings.twitchClientId || "").trim();
}

export function signInTwitch() {
  const { twitchClientId, twitchRedirectUri } = getState().settings;
  if (!twitchClientId || !twitchRedirectUri) {
    throw new Error("設定画面で Twitch のクライアントID とリダイレクトURI を入力してください。");
  }
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  sessionStorage.setItem(STATE_KEY, state);
  const params = new URLSearchParams({
    client_id: twitchClientId,
    redirect_uri: twitchRedirectUri,
    response_type: "token",
    scope: SCOPES.join(" "),
    state,
  });
  window.location.href = `${AUTH_BASE}?${params.toString()}`;
}

export function signOutTwitch() {
  update((s) => { s.auth.twitch = null; });
}

// Call once on startup: if the URL fragment carries a Twitch access_token
// (we just came back from the redirect), parse it, fetch the user profile,
// store it, and clean the URL.
export async function handleTwitchRedirect() {
  if (!location.hash || !location.hash.includes("access_token")) return false;
  const hashParams = new URLSearchParams(location.hash.slice(1));
  const token = hashParams.get("access_token");
  const returnedState = hashParams.get("state");
  const expectedState = sessionStorage.getItem(STATE_KEY);
  sessionStorage.removeItem(STATE_KEY);

  if (!token) return false;
  if (expectedState && returnedState !== expectedState) {
    console.warn("Twitch OAuth state mismatch; ignoring returned token.");
    cleanUrl();
    return false;
  }

  const expiresIn = Number(hashParams.get("expires_in") || 0);
  const clientId = getTwitchClientId();
  let login = null;
  let userId = null;
  try {
    const res = await fetch("https://api.twitch.tv/helix/users", {
      headers: { Authorization: `Bearer ${token}`, "Client-Id": clientId },
    });
    if (res.ok) {
      const data = await res.json();
      if (data.data && data.data[0]) {
        login = data.data[0].login;
        userId = data.data[0].id;
      }
    }
  } catch (err) {
    console.warn("Failed to fetch Twitch profile after login", err);
  }

  update((s) => {
    s.auth.twitch = {
      accessToken: token,
      login,
      userId,
      expiresAt: Date.now() + (expiresIn ? (expiresIn - 60) * 1000 : 3 * 60 * 60 * 1000),
    };
  });
  cleanUrl();
  return true;
}

function cleanUrl() {
  history.replaceState(null, "", location.pathname + location.search);
}
