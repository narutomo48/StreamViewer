// Central app state + localStorage persistence + tiny pub/sub.
// No build step / no framework: plain ES module, single source of truth.

const STORAGE_KEY = "streamviewer.v1";

const DEFAULT_STATE = {
  panels: [],          // [{id, platform, mode, targetId, idType, login, title, subtitle, volume, muted, showChat, x, y, w, h, z}]
  favorites: [],        // [{id, platform, key, login, channelId, name, avatar, manual, groupId}]
  favoriteGroups: [],    // [{id, name, collapsed}] -- favorites with a matching groupId are shown nested under one of these
  // Keys (see favKeyOf in sidebar.js) of channels the user removed from favorites.
  // Kept so that re-logging in / re-importing subscriptions or follows doesn't
  // silently bring back something the user deliberately removed -- YouTube/Twitch
  // still consider them subscribed/followed, this list is purely local.
  dismissedFavoriteKeys: [],
  presets: {},           // { presetName: { panels: [...] } }
  activePreset: null,
  presetBarVisible: false, // whether the top preset bar (読込/保存/書出 etc.) is shown
  hideNonLiveFavorites: false, // sidebar favorites: show only channels currently confirmed live
  settings: {
    youtubeApiKey: "",
    youtubeClientId: "",
    twitchClientId: "",
    twitchRedirectUri: "",
  },
  auth: {
    youtube: null, // { accessToken, expiresAt }
    twitch: null,  // { accessToken, login, userId, expiresAt }
  },
  zCounter: 1,
};

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredCloneCompat(DEFAULT_STATE);
    const parsed = JSON.parse(raw);
    // shallow-merge with defaults so new fields introduced later don't break old saves
    return {
      ...structuredCloneCompat(DEFAULT_STATE),
      ...parsed,
      settings: { ...DEFAULT_STATE.settings, ...(parsed.settings || {}) },
      auth: { ...DEFAULT_STATE.auth, ...(parsed.auth || {}) },
    };
  } catch (err) {
    console.warn("Failed to load saved state, starting fresh.", err);
    return structuredCloneCompat(DEFAULT_STATE);
  }
}

function structuredCloneCompat(obj) {
  if (typeof structuredClone === "function") return structuredClone(obj);
  return JSON.parse(JSON.stringify(obj));
}

let state = loadState();
const listeners = new Set();
let saveTimer = null;

export function getState() {
  return state;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of listeners) fn(state);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (err) {
      console.warn("Failed to persist state (localStorage full or unavailable).", err);
    }
  }, 150);
}

// Update via an updater function that mutates a draft-ish shallow copy.
// Keeping it simple (no immer) since the app is small.
export function update(mutator, { persist = true, notify: doNotify = true } = {}) {
  mutator(state);
  if (persist) scheduleSave();
  if (doNotify) notify();
}

export function nextZ() {
  let z;
  update((s) => { s.zCounter = (s.zCounter || 1) + 1; z = s.zCounter; });
  return z;
}

export function uid(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
