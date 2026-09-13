import { getState, update, uid } from "./state.js";
import { parseStreamInput, fallbackLabel } from "./utils/parseStream.js";
import { qs, el, toast, askText } from "./utils/dom.js";
import { addPanel } from "./grid.js";
import {
  isYoutubeSignedIn, signInYoutube, signOutYoutube,
} from "./auth/googleAuth.js";
import {
  isTwitchSignedIn, signInTwitch, signOutTwitch,
} from "./auth/twitchAuth.js";
import {
  fetchMySubscriptions, resolveChannelId, fetchChannelMeta, checkChannelLive, fetchChannelArchive as fetchYtArchive,
} from "./api/youtubeApi.js";
import {
  fetchMyFollowedChannels, fetchUsersByLogin, fetchLiveStreams, fetchChannelArchive as fetchTwArchive,
} from "./api/twitchApi.js";
import { hasYoutubeApiKey, hasYoutubeClientId, hasTwitchClientId } from "./settings.js";

let favListEl, ytAuthBtn, twAuthBtn, liveAlertBarEl;

// While refreshLiveStatus() is running, this holds the button label to show
// (e.g. "🔄 更新中… (12/140)") so progress is visible instead of the button
// looking exactly the same before/during/after a refresh that can take a
// while for a large favorites list. null = idle (not refreshing).
let refreshProgressLabel = null;

// "Just went live" alert bar (below the top bar) -- channels freshly
// detected as live, shown as dismissible chips until opened, dismissed, or
// aged out. Twitch is checked automatically in the background (Twitch's API
// has no meaningful quota limit); YouTube is only checked when the user
// presses "ライブ状況を更新" (its quota is limited -- see youtubeApi.js), so a
// newly-live YouTube channel only shows up here right after a manual refresh,
// not continuously in real time.
let liveAlerts = []; // [{ favId, name, avatar, platform, ts }]
const LIVE_ALERT_MAX_AGE_MS = 20 * 60 * 1000; // stop calling it "just went live" after 20 min
const LIVE_ALERT_MAX_COUNT = 12; // cap the bar's width if many channels go live in a burst
const TWITCH_AUTO_POLL_MS = 2 * 60 * 1000; // free (no quota) -- can poll often

export function initSidebar() {
  favListEl = qs("#favList");
  ytAuthBtn = qs("#ytAuthBtn");
  twAuthBtn = qs("#twAuthBtn");
  liveAlertBarEl = qs("#liveAlertBar");

  wireTabs();
  wireAddByUrl();
  wireAddFavorite();
  wireAuthButtons();
  startTwitchAutoPoll();

  renderFavorites();
}

// -------- "just went live" alert bar --------

function pushLiveAlert(entry) {
  liveAlerts = liveAlerts.filter((a) => a.favId !== entry.favId); // no duplicate chip for the same channel
  liveAlerts.push({ ...entry, ts: Date.now() });
  if (liveAlerts.length > LIVE_ALERT_MAX_COUNT) liveAlerts.shift(); // drop the oldest if a burst goes live at once
  renderLiveAlertBar();
}

function dismissLiveAlert(favId) {
  liveAlerts = liveAlerts.filter((a) => a.favId !== favId);
  renderLiveAlertBar();
}

function pruneStaleLiveAlerts() {
  const cutoff = Date.now() - LIVE_ALERT_MAX_AGE_MS;
  const before = liveAlerts.length;
  liveAlerts = liveAlerts.filter((a) => a.ts >= cutoff);
  if (liveAlerts.length !== before) renderLiveAlertBar();
}

function renderLiveAlertBar() {
  if (!liveAlertBarEl) return;
  liveAlertBarEl.innerHTML = "";
  liveAlertBarEl.hidden = liveAlerts.length === 0;
  for (const alert of liveAlerts) {
    const chip = el("div", { class: "live-alert-chip", title: `${alert.name} が配信を開始しました。クリックで開きます。` }, [
      alert.avatar
        ? el("img", { class: "avatar", src: alert.avatar, alt: "" })
        : el("span", { class: `platform-dot ${alert.platform}` }),
      el("span", { class: "name" }, alert.name),
      el("span", { class: "live-tag" }, "LIVE"),
      el("button", {
        class: "dismiss",
        title: "閉じる",
        onclick: (e) => { e.stopPropagation(); dismissLiveAlert(alert.favId); },
      }, "✕"),
    ]);
    chip.addEventListener("click", () => {
      const fav = getState().favorites.find((f) => f.id === alert.favId);
      dismissLiveAlert(alert.favId);
      if (fav) openFavorite(fav);
    });
    liveAlertBarEl.appendChild(chip);
  }
}

// Twitch has no meaningful daily quota (unlike YouTube -- see youtubeApi.js),
// so its live status can be polled automatically and for free. Only runs
// while the tab is actually visible, to avoid pointless background work.
function startTwitchAutoPoll() {
  const poll = () => {
    if (document.hidden) return;
    checkTwitchLiveStatuses().catch((err) => console.warn("Twitchのバックグラウンド確認に失敗しました", err));
  };
  setInterval(poll, TWITCH_AUTO_POLL_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
  setInterval(pruneStaleLiveAlerts, 60 * 1000);
  setTimeout(poll, 5000); // one initial check shortly after load
}

// Shared by both the manual "ライブ状況を更新" button and the automatic
// background poll above. prevLiveIds (a Set of favorite ids already known
// live) lets the caller control what counts as "newly" live for the alert
// bar; if omitted, it's computed from the current state (the normal case for
// a standalone background poll -- refreshLiveStatus() passes its own
// snapshot instead, taken before it resets everything to "checking...").
async function checkTwitchLiveStatuses(prevLiveIds) {
  const state = getState();
  const twFavs = state.favorites.filter((f) => f.platform === "twitch");
  if (!twFavs.length || !isTwitchSignedIn()) return;
  const wasLiveIds = prevLiveIds || new Set(twFavs.filter((f) => f.liveStatus && f.liveStatus.live).map((f) => f.id));

  let userIds = twFavs.map((f) => f.target.userId).filter(Boolean);
  if (userIds.length < twFavs.length) userIds = await resolveTwitchUserIds(twFavs);
  const liveMap = await fetchLiveStreams(userIds);

  const newlyLive = [];
  update((s) => {
    for (const f of s.favorites) {
      if (f.platform !== "twitch") continue;
      const info = f.target.userId ? liveMap.get(f.target.userId) : null;
      f.liveStatus = info
        ? { live: true, title: info.title, startedAt: info.startedAt, viewers: info.viewers }
        : { live: false };
      if (info && !wasLiveIds.has(f.id)) newlyLive.push({ favId: f.id, name: f.name, avatar: f.avatar, platform: "twitch" });
    }
  });
  renderFavorites();
  newlyLive.forEach(pushLiveAlert);
}

// -------- tabs --------
function wireTabs() {
  const tabBtns = Array.from(document.querySelectorAll(".tab-btn"));
  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabBtns.forEach((b) => b.classList.toggle("active", b === btn));
      const tabId = btn.dataset.tab;
      document.getElementById("favTab").classList.toggle("active", tabId === "favorites");
      document.getElementById("archiveTab").classList.toggle("active", tabId === "archive");
      if (tabId === "archive") renderArchiveTab();
    });
  });
}

// -------- add by URL (goes straight to the canvas) --------
function wireAddByUrl() {
  const form = qs("#addByUrlForm");
  const input = qs("#addByUrlInput");
  const hintSel = qs("#addByUrlPlatformHint");
  const hintEl = qs("#addUrlHint");

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const target = parseStreamInput(input.value, hintSel.value);
    if (!target) {
      hintEl.textContent = "URL・ID を認識できませんでした。YouTube/Twitchの正しいURLか、プラットフォームを選択してください。";
      hintEl.className = "hint error";
      return;
    }
    addPanel(target, { title: fallbackLabel(target) });
    hintEl.textContent = `追加しました: ${fallbackLabel(target)}`;
    hintEl.className = "hint ok";
    input.value = "";
  });
}

// -------- add favorite --------
function wireAddFavorite() {
  const form = qs("#addFavoriteForm");
  const input = qs("#addFavoriteInput");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const raw = input.value;
    const target = parseStreamInput(raw, "auto");
    if (!target) { toast("URLを認識できませんでした。", "error"); return; }
    input.value = "";
    await addFavoriteFromTarget(target, { manual: true });
  });
}

async function addFavoriteFromTarget(target, { manual = true } = {}) {
  const state = getState();
  const dupeKey = favKeyOf(target);
  if (state.favorites.some((f) => favKeyOf(f.target) === dupeKey)) {
    toast("すでにお気に入りに追加されています。");
    return;
  }

  // The user is explicitly asking for this channel back, so un-dismiss it --
  // otherwise a future YouTube/Twitch re-import would just skip it again.
  if ((state.dismissedFavoriteKeys || []).includes(dupeKey)) {
    update((s) => { s.dismissedFavoriteKeys = (s.dismissedFavoriteKeys || []).filter((k) => k !== dupeKey); });
  }

  const fav = {
    id: uid("fav"),
    platform: target.platform,
    target,
    name: fallbackLabel(target),
    avatar: "",
    manual,
    liveStatus: null,
  };
  update((s) => { s.favorites.push(fav); });
  renderFavorites();

  // Best-effort metadata enrichment (only if we have the means to look it up).
  try {
    if (target.platform === "youtube") {
      if (target.mode === "channel" && target.idType === "channelId" && hasYoutubeApiKey()) {
        const [meta] = await fetchChannelMeta([target.id]);
        if (meta) patchFavorite(fav.id, { name: meta.title, avatar: meta.avatar });
      } else if (target.mode === "channel" && (target.idType === "handle" || target.idType === "user") && hasYoutubeApiKey()) {
        const meta = await resolveChannelId(target.idType, target.id);
        patchFavorite(fav.id, {
          name: meta.title,
          avatar: meta.avatar,
          target: { platform: "youtube", mode: "channel", idType: "channelId", id: meta.channelId },
        });
      }
    } else if (target.platform === "twitch" && target.mode === "channel" && isTwitchSignedIn()) {
      const [meta] = await fetchUsersByLogin([target.login]);
      if (meta) patchFavorite(fav.id, { name: meta.displayName || meta.login, avatar: meta.avatar });
    }
  } catch (err) {
    console.warn("Favorite metadata enrichment failed", err);
  }
}

function patchFavorite(favId, patch) {
  update((s) => {
    const f = s.favorites.find((x) => x.id === favId);
    if (f) Object.assign(f, patch);
  });
  renderFavorites();
}

function favKeyOf(target) {
  if (!target) return "";
  if (target.platform === "youtube") return `yt:${target.idType || target.mode}:${target.id}`;
  return `tw:${target.mode}:${target.login || target.id}`;
}

function removeFavorite(id) {
  update((s) => {
    const removed = s.favorites.find((f) => f.id === id);
    if (removed) {
      const key = favKeyOf(removed.target);
      if (!s.dismissedFavoriteKeys) s.dismissedFavoriteKeys = [];
      if (!s.dismissedFavoriteKeys.includes(key)) s.dismissedFavoriteKeys.push(key);
    }
    s.favorites = s.favorites.filter((f) => f.id !== id);
  });
  renderFavorites();
}

// -------- auth buttons --------
function wireAuthButtons() {
  refreshAuthButtons();

  ytAuthBtn.addEventListener("click", async () => {
    if (isYoutubeSignedIn()) { signOutYoutube(); refreshAuthButtons(); toast("YouTubeからログアウトしました。"); return; }
    if (!hasYoutubeClientId()) { toast("先に設定画面でYouTubeのOAuthクライアントIDを入力してください。", "error"); return; }
    try {
      await signInYoutube();
      refreshAuthButtons();
      toast("YouTubeにログインしました。登録チャンネルを取得しています…");
      await importYoutubeSubscriptions();
    } catch (err) {
      toast(`YouTubeログインに失敗しました: ${err.message}`, "error");
    }
  });

  twAuthBtn.addEventListener("click", async () => {
    if (isTwitchSignedIn()) { signOutTwitch(); refreshAuthButtons(); toast("Twitchからログアウトしました。"); return; }
    if (!hasTwitchClientId()) { toast("先に設定画面でTwitchのクライアントIDとリダイレクトURIを入力してください。", "error"); return; }
    try {
      signInTwitch(); // full-page redirect
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

export function refreshAuthButtons() {
  if (!ytAuthBtn) return;
  ytAuthBtn.textContent = isYoutubeSignedIn() ? "YouTube: ログアウト" : "YouTubeでログイン";
  twAuthBtn.textContent = isTwitchSignedIn() ? "Twitch: ログアウト" : "Twitchでログイン";
}

// Called from main.js after a Twitch OAuth redirect completes.
export async function onTwitchLoginCompleted() {
  refreshAuthButtons();
  toast("Twitchにログインしました。フォロー中チャンネルを取得しています…");
  await importTwitchFollows();
}

async function importYoutubeSubscriptions() {
  try {
    const subs = await fetchMySubscriptions();
    const state = getState();
    let added = 0, skipped = 0;
    for (const sub of subs) {
      const target = { platform: "youtube", mode: "channel", idType: "channelId", id: sub.channelId };
      const key = favKeyOf(target);
      if (state.favorites.some((f) => favKeyOf(f.target) === key)) continue;
      if ((state.dismissedFavoriteKeys || []).includes(key)) { skipped++; continue; }
      update((s) => {
        s.favorites.push({
          id: uid("fav"), platform: "youtube", target,
          name: sub.title, avatar: sub.avatar, manual: false, liveStatus: null,
        });
      });
      added++;
    }
    renderFavorites();
    toast(`YouTube登録チャンネルを${added}件追加しました。${skipped ? `（お気に入りから削除済みの${skipped}件はスキップしました）` : ""}`);
  } catch (err) {
    toast(`登録チャンネルの取得に失敗しました: ${err.message}`, "error");
  }
}

async function importTwitchFollows() {
  try {
    const follows = await fetchMyFollowedChannels();
    const state = getState();
    let added = 0, skipped = 0;
    for (const f of follows) {
      const target = { platform: "twitch", mode: "channel", login: f.login };
      const key = favKeyOf(target);
      if (state.favorites.some((x) => favKeyOf(x.target) === key)) continue;
      if ((state.dismissedFavoriteKeys || []).includes(key)) { skipped++; continue; }
      update((s) => {
        s.favorites.push({
          id: uid("fav"), platform: "twitch", target,
          name: f.displayName || f.login, avatar: f.avatar, manual: false, liveStatus: null,
        });
      });
      added++;
    }
    renderFavorites();
    toast(`Twitchフォロー中チャンネルを${added}件追加しました。${skipped ? `（お気に入りから削除済みの${skipped}件はスキップしました）` : ""}`);
  } catch (err) {
    toast(`フォローチャンネルの取得に失敗しました: ${err.message}`, "error");
  }
}

// -------- rendering favorites (grouped) --------
function sortFavs(arr) {
  return [...arr].sort((a, b) => {
    const aLive = a.liveStatus && a.liveStatus.live ? 0 : 1;
    const bLive = b.liveStatus && b.liveStatus.live ? 0 : 1;
    if (aLive !== bLive) return aLive - bLive;
    return (a.name || "").localeCompare(b.name || "", "ja");
  });
}

function renderFavorites() {
  if (!favListEl) return;
  const { favorites, favoriteGroups, hideNonLiveFavorites } = getState();
  favListEl.innerHTML = "";

  const toolbar = el("div", { class: "auth-row" }, [
    el(
      "button",
      { class: "btn small", onclick: refreshLiveStatus, disabled: !!refreshProgressLabel },
      refreshProgressLabel || "🔄 ライブ状況を更新"
    ),
    el("button", { class: "btn small", onclick: createGroup }, "＋ グループ"),
  ]);
  favListEl.appendChild(toolbar);

  const hideOfflineRow = el("label", { class: "hide-offline-row" }, [
    el("input", {
      type: "checkbox",
      checked: !!hideNonLiveFavorites,
      onchange: (e) => {
        update((s) => { s.hideNonLiveFavorites = e.target.checked; });
        renderFavorites();
      },
    }),
    "配信中でないチャンネルを非表示",
  ]);
  favListEl.appendChild(hideOfflineRow);

  if (!favorites.length) {
    favListEl.appendChild(el("div", { class: "list-empty" },
      "お気に入りがまだありません。上のフォームでチャンネルURLを追加するか、YouTube/Twitchでログインすると自動で取得できます。"));
    return;
  }

  const groups = favoriteGroups || [];
  const membersByGroup = new Map(groups.map((g) => [g.id, []]));
  const ungrouped = [];
  for (const fav of favorites) {
    if (fav.groupId && membersByGroup.has(fav.groupId)) membersByGroup.get(fav.groupId).push(fav);
    else ungrouped.push(fav);
  }

  // "配信中でないチャンネルを非表示": only channels CONFIRMED live stay
  // visible -- anything offline, or not yet checked, is hidden. (YouTube
  // favorites mostly sit at liveStatus === null since checking costs API
  // quota, so an "offline-only" filter never hid them; this stricter
  // live-only filter is what the user actually wants.)
  const isHidden = (f) => hideNonLiveFavorites && !(f.liveStatus && f.liveStatus.live === true);

  let renderedAny = false;
  for (const group of groups) {
    const rawMembers = membersByGroup.get(group.id) || [];
    const visible = rawMembers.filter((f) => !isHidden(f));
    if (hideNonLiveFavorites && !visible.length) continue; // declutter fully non-live groups
    renderedAny = true;
    favListEl.appendChild(buildGroupSection(group, sortFavs(visible), rawMembers));
  }
  const visibleUngrouped = ungrouped.filter((f) => !isHidden(f));
  if (visibleUngrouped.length) {
    renderedAny = true;
    favListEl.appendChild(buildUngroupedSection(sortFavs(visibleUngrouped), groups.length > 0));
  }

  if (!renderedAny) {
    favListEl.appendChild(el("div", { class: "list-empty" },
      "現在配信中のチャンネルがありません。チェックを外すと全チャンネルが表示されます。"));
  }
}

// members: the (possibly offline-filtered) favorites to actually render in
// the body. rawMembers: the group's full membership, used only to decide the
// "someone in this group is live" glow so filtering doesn't affect it.
function buildGroupSection(group, members, rawMembers = members) {
  const isLive = rawMembers.some((f) => f.liveStatus && f.liveStatus.live);
  const collapsed = !!group.collapsed;

  const dragHandle = el("span", { class: "group-drag-handle", draggable: "true", title: "ドラッグで並べ替え" }, "⋮⋮");

  const header = el("div", { class: `group-header${isLive ? " live" : ""}` }, [
    dragHandle,
    el("span", { class: "group-caret" }, collapsed ? "▶" : "▼"),
    el("span", { class: "group-name" }, group.name || "グループ"),
    el("span", { class: "group-count" }, `(${members.length})`),
    isLive ? el("span", { class: "badge live" }, "LIVE") : null,
    el("span", { class: "group-actions" }, [
      el("button", { title: "グループ名を変更", onclick: (e) => { e.stopPropagation(); renameGroup(group.id); } }, "✏️"),
      el("button", { title: "グループを削除（中のチャンネルは未分類に戻ります）", onclick: (e) => { e.stopPropagation(); deleteGroup(group.id); } }, "🗑"),
    ]),
  ]);
  header.addEventListener("click", (e) => {
    if (e.target === dragHandle) return;
    toggleGroupCollapsed(group.id);
  });

  const body = el("div", { class: "group-body" });
  body.hidden = collapsed;
  for (const fav of members) body.appendChild(buildFavoriteCard(fav));

  const section = el("div", { class: "group-section" }, [header, body]);

  // Drag-and-drop reordering of groups: the ⋮⋮ handle is the only draggable
  // part (so dragging never fights with clicking a card, a button, or
  // collapsing the group), and any point over the section accepts the drop.
  dragHandle.addEventListener("dragstart", (e) => {
    e.stopPropagation();
    e.dataTransfer.setData("text/plain", group.id);
    e.dataTransfer.effectAllowed = "move";
    section.classList.add("dragging");
  });
  dragHandle.addEventListener("dragend", (e) => {
    e.stopPropagation();
    section.classList.remove("dragging");
  });
  section.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes("text/plain")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    section.classList.add("drag-over");
  });
  section.addEventListener("dragleave", () => section.classList.remove("drag-over"));
  section.addEventListener("drop", (e) => {
    e.preventDefault();
    section.classList.remove("drag-over");
    const draggedId = e.dataTransfer.getData("text/plain");
    if (draggedId) reorderGroups(draggedId, group.id);
  });

  return section;
}

function reorderGroups(draggedId, targetId) {
  if (draggedId === targetId) return;
  update((s) => {
    const groups = s.favoriteGroups || [];
    const fromIdx = groups.findIndex((g) => g.id === draggedId);
    const toIdx = groups.findIndex((g) => g.id === targetId);
    if (fromIdx === -1 || toIdx === -1) return;
    const [moved] = groups.splice(fromIdx, 1);
    groups.splice(toIdx, 0, moved);
  });
  renderFavorites();
}

function buildUngroupedSection(members, showHeader) {
  const wrap = el("div", { class: "group-section ungrouped" });
  if (showHeader) {
    wrap.appendChild(el("div", { class: "group-header static" }, [
      el("span", { class: "group-name" }, "未分類"),
      el("span", { class: "group-count" }, `(${members.length})`),
    ]));
  }
  const body = el("div", { class: "group-body" });
  for (const fav of members) body.appendChild(buildFavoriteCard(fav));
  wrap.appendChild(body);
  return wrap;
}

// -------- group management --------
async function createGroup() {
  const name = await askText("新しいグループ名を入力してください", "");
  if (!name) return;
  update((s) => {
    if (!s.favoriteGroups) s.favoriteGroups = [];
    s.favoriteGroups.push({ id: uid("grp"), name, collapsed: false });
  });
  renderFavorites();
}

async function renameGroup(groupId) {
  const group = (getState().favoriteGroups || []).find((g) => g.id === groupId);
  if (!group) return;
  const name = await askText("グループ名を変更", group.name);
  if (!name) return;
  update((s) => {
    const g = (s.favoriteGroups || []).find((x) => x.id === groupId);
    if (g) g.name = name;
  });
  renderFavorites();
}

function deleteGroup(groupId) {
  const group = (getState().favoriteGroups || []).find((g) => g.id === groupId);
  if (!group) return;
  if (!window.confirm(`グループ「${group.name}」を削除しますか？（中のチャンネルはお気に入りから削除されず、未分類に戻ります）`)) return;
  update((s) => {
    s.favoriteGroups = (s.favoriteGroups || []).filter((g) => g.id !== groupId);
    for (const f of s.favorites) if (f.groupId === groupId) f.groupId = null;
  });
  renderFavorites();
}

function toggleGroupCollapsed(groupId) {
  update((s) => {
    const g = (s.favoriteGroups || []).find((x) => x.id === groupId);
    if (g) g.collapsed = !g.collapsed;
  });
  renderFavorites();
}

function setFavoriteGroup(favId, groupId) {
  update((s) => {
    const f = s.favorites.find((x) => x.id === favId);
    if (f) f.groupId = groupId;
  });
  renderFavorites();
}

async function createGroupThenAssign(favId) {
  const name = await askText("新しいグループ名を入力してください", "");
  if (!name) return;
  update((s) => {
    if (!s.favoriteGroups) s.favoriteGroups = [];
    const newId = uid("grp");
    s.favoriteGroups.push({ id: newId, name, collapsed: false });
    const f = s.favorites.find((x) => x.id === favId);
    if (f) f.groupId = newId;
  });
  renderFavorites();
}

function renderGroupPicker(fav, host) {
  host.innerHTML = "";
  const groups = getState().favoriteGroups || [];
  host.appendChild(el("button", {
    class: "btn small",
    onclick: () => { setFavoriteGroup(fav.id, null); },
  }, "（グループなし）"));
  for (const g of groups) {
    host.appendChild(el("button", {
      class: "btn small",
      onclick: () => { setFavoriteGroup(fav.id, g.id); },
    }, g.id === fav.groupId ? `✓ ${g.name}` : g.name));
  }
  host.appendChild(el("button", {
    class: "btn small",
    onclick: () => { createGroupThenAssign(fav.id); },
  }, "＋ 新しいグループを作成…"));
}

// "⏱42分" / "⏱1時間5分" since stream start.
function formatElapsed(startedAtIso) {
  if (!startedAtIso) return "";
  const startMs = new Date(startedAtIso).getTime();
  if (Number.isNaN(startMs)) return "";
  const diffMin = Math.max(0, Math.floor((Date.now() - startMs) / 60000));
  const h = Math.floor(diffMin / 60);
  const m = diffMin % 60;
  return h > 0 ? `⏱${h}時間${m}分` : `⏱${m}分`;
}

function formatViewers(n) {
  if (n === null || n === undefined) return "";
  return `👁${Number(n).toLocaleString("ja-JP")}人`;
}

// Renders as two short stacked lines (elapsed / viewers) rather than one
// long line -- at the ~80px this slot has, a single line truncated the
// viewer count off the end.
function liveMetaParts(liveStatus) {
  const parts = [];
  const elapsed = formatElapsed(liveStatus && liveStatus.startedAt);
  if (elapsed) parts.push(elapsed);
  if (liveStatus && liveStatus.viewers != null) parts.push(formatViewers(liveStatus.viewers));
  return parts;
}

// Live sidebar entries periodically re-render (favorite data changes,
// group toggles, etc.), but the elapsed-time text also needs to tick up on
// its own between renders -- this recomputes just that text in place every
// minute, with no extra API calls.
function tickLiveMeta() {
  document.querySelectorAll("#favList .live-meta-inline[data-started-at]").forEach((elm) => {
    const startedAt = elm.dataset.startedAt;
    if (!startedAt) return;
    const parts = liveMetaParts({ startedAt, viewers: elm.dataset.viewers ? Number(elm.dataset.viewers) : null });
    if (!parts.length) return;
    elm.innerHTML = "";
    for (const p of parts) elm.appendChild(el("div", { class: "live-meta-line" }, p));
    elm.title = parts.join(" ");
  });
}
setInterval(tickLiveMeta, 60000);

function buildFavoriteCard(fav) {
  const wrap = el("div", {});
  let badge = null;
  if (fav.liveStatus && fav.liveStatus.live) badge = el("span", { class: "badge live" }, "LIVE");
  else if (fav.liveStatus) badge = el("span", { class: "badge offline" }, "オフライン");

  // Elapsed time + viewer count sit in the same slot the 📁🕘✕ action
  // buttons occupy -- the actions are hidden until hover (they don't need to
  // be visible all the time), and this inline summary fills that space at
  // rest for channels we know are live.
  let liveMetaInline = null;
  if (fav.liveStatus && fav.liveStatus.live) {
    const parts = liveMetaParts(fav.liveStatus);
    if (parts.length) {
      liveMetaInline = el("div", {
        class: "live-meta-inline",
        title: parts.join(" "),
        dataset: { startedAt: fav.liveStatus.startedAt || "", viewers: fav.liveStatus.viewers ?? "" },
      }, parts.map((p) => el("div", { class: "live-meta-line" }, p)));
    }
  }

  const groupBtn = el("button", { class: "removeFav", title: "グループを設定" }, "📁");
  const archiveBtn = el("button", { class: "removeFav", title: "アーカイブを見る" }, "🕘");
  const removeBtn = el("button", { class: "removeFav", title: "お気に入りから削除" }, "✕");
  const actions = el("div", { class: "card-actions" }, [groupBtn, archiveBtn, removeBtn]);

  const card = el("div", { class: "channel-card" }, [
    fav.avatar
      ? el("img", { class: "avatar", src: fav.avatar, alt: "" })
      : el("span", { class: `platform-dot ${fav.platform}` }),
    el("div", { class: "meta" }, [
      el("div", { class: "name", title: fav.name || fallbackLabel(fav.target) }, fav.name || fallbackLabel(fav.target)),
      el(
        "div",
        {
          class: "sub",
          // Native browser tooltip: shows the full, untruncated stream title
          // on hover, since the "sub" line itself is clipped with an ellipsis
          // when the title is long (CSS in style.css).
          title: (fav.liveStatus && fav.liveStatus.live && fav.liveStatus.title) || (fav.platform === "youtube" ? "YouTube" : "Twitch"),
        },
        (fav.liveStatus && fav.liveStatus.live && fav.liveStatus.title) || (fav.platform === "youtube" ? "YouTube" : "Twitch")
      ),
    ]),
    badge,
    liveMetaInline,
    actions,
  ]);
  card.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    openFavorite(fav);
  });

  const picker = el("div", { class: "group-picker" });
  picker.hidden = true;
  groupBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    picker.hidden = !picker.hidden;
    if (!picker.hidden) renderGroupPicker(fav, picker);
  });
  archiveBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleInlineArchive(fav, archiveHost); });
  removeBtn.addEventListener("click", (e) => { e.stopPropagation(); if (window.confirm(`「${fav.name}」をお気に入りから削除しますか？`)) removeFavorite(fav.id); });

  const archiveHost = el("div", { class: "list-note" });
  archiveHost.hidden = true;
  wrap.appendChild(card);
  wrap.appendChild(picker);
  wrap.appendChild(archiveHost);
  return wrap;
}

// Opening a favorite channel needs care: YouTube's "whatever is currently
// live on this channel" embed (embed/live_stream?channel=) turns out to be
// unreliable when embedded on a non-YouTube origin -- testing shows it fails
// with YouTube's own "video could not be played" error even for well-known,
// definitely-live, definitely-embeddable channels. The one reliable path is
// a normal video-mode embed of the *actual* live video ID. So: prefer an
// already-resolved video ID; if we don't have one yet but can look it up
// (API key configured), resolve just this one channel on click (a single,
// cheap-enough API call) instead of requiring the bulk "ライブ状況を更新"
// button; only fall back to the unreliable channel-embed trick when we have
// no way to resolve a real video ID at all.
async function openFavorite(fav) {
  if (fav.platform !== "youtube") {
    addPanel(fav.target, { title: fav.name, avatar: fav.avatar });
    return;
  }

  if (fav.liveStatus && fav.liveStatus.live && fav.liveStatus.videoId) {
    addPanel(
      { platform: "youtube", mode: "video", id: fav.liveStatus.videoId },
      { title: `${fav.name}${fav.liveStatus.title ? `: ${fav.liveStatus.title}` : ""}`, avatar: fav.avatar }
    );
    return;
  }

  if (fav.liveStatus && !fav.liveStatus.live) {
    toast(`${fav.name} は現在配信していないようです。`);
    return;
  }

  if (fav.target.idType === "channelId" && hasYoutubeApiKey()) {
    toast(`${fav.name} のライブ状況を確認しています…`);
    try {
      const live = await checkChannelLive(fav.target.id);
      patchFavorite(fav.id, {
        liveStatus: live
          ? { live: true, title: live.title, videoId: live.videoId, startedAt: live.startedAt, viewers: live.viewers }
          : { live: false },
      });
      if (live && live.videoId) {
        addPanel(
          { platform: "youtube", mode: "video", id: live.videoId },
          { title: `${fav.name}${live.title ? `: ${live.title}` : ""}`, avatar: fav.avatar }
        );
      } else {
        toast(`${fav.name} は現在配信していないようです。`);
      }
    } catch (err) {
      toast(`ライブ状況の確認に失敗しました: ${err.message}`, "error");
    }
    return;
  }

  toast(`${fav.name} を開きます（配信中か未確認のため表示できない場合があります。設定でYouTube APIキーを登録すると確実に再生できます）。`);
  addPanel(fav.target, { title: fav.name, avatar: fav.avatar });
}

async function toggleInlineArchive(fav, hostEl) {
  if (!hostEl.hidden) { hostEl.hidden = true; return; }
  hostEl.hidden = false;
  hostEl.innerHTML = "読み込み中…";
  try {
    const items = await fetchArchiveItems(fav);
    hostEl.innerHTML = "";
    if (!items.length) { hostEl.textContent = "アーカイブが見つかりませんでした。"; return; }
    const grid = el("div", { style: "display:flex; flex-direction:column; gap:4px;" });
    for (const item of items.slice(0, 8)) {
      const row = el("div", {
        class: "channel-card", style: "padding:4px;",
        onclick: () => addVideoFromArchive(fav, item),
      }, [
        item.thumbnail ? el("img", { class: "avatar", style: "width:48px;height:28px;border-radius:4px;", src: item.thumbnail }) : null,
        el("div", { class: "meta" }, [el("div", { class: "name" }, item.title)]),
      ]);
      grid.appendChild(row);
    }
    hostEl.appendChild(grid);
  } catch (err) {
    hostEl.textContent = `取得に失敗しました: ${err.message}`;
  }
}

async function fetchArchiveItems(fav) {
  if (fav.platform === "youtube") {
    if (fav.target.idType !== "channelId") throw new Error("このチャンネルはAPIキーでの解決が必要です。");
    if (!hasYoutubeApiKey()) throw new Error("設定画面でYouTube APIキーを登録してください。");
    const { items } = await fetchYtArchive(fav.target.id);
    return items.map((v) => ({ title: v.title, thumbnail: v.thumbnail, target: { platform: "youtube", mode: "video", id: v.videoId } }));
  }
  if (fav.platform === "twitch") {
    if (!isTwitchSignedIn()) throw new Error("Twitchにログインしてください。");
    if (!fav.target.userId) {
      const [meta] = await fetchUsersByLogin([fav.target.login]);
      if (meta) patchFavorite(fav.id, { target: { ...fav.target, userId: meta.userId } });
      fav = { ...fav, target: { ...fav.target, userId: meta?.userId } };
    }
    if (!fav.target.userId) throw new Error("チャンネルIDを解決できませんでした。");
    const { items } = await fetchTwArchive(fav.target.userId);
    return items.map((v) => ({ title: v.title, thumbnail: v.thumbnail, target: { platform: "twitch", mode: "video", id: v.id } }));
  }
  return [];
}

function addVideoFromArchive(fav, item) {
  addPanel(item.target, { title: `${fav.name}: ${item.title}` });
  toast(`追加しました: ${item.title}`);
}

async function refreshLiveStatus() {
  if (refreshProgressLabel) return; // already running -- ignore a double-click
  const state = getState();
  const twFavs = state.favorites.filter((f) => f.platform === "twitch");
  const ytFavs = state.favorites.filter((f) => f.platform === "youtube" && f.target.idType === "channelId");
  const startedAt = Date.now();

  // Snapshot of who was already confirmed live *before* this refresh resets
  // everything below -- needed so the "just went live" alert bar only fires
  // for channels that are genuinely newly live, not every already-live
  // channel on every single manual refresh.
  const prevLiveIds = new Set(state.favorites.filter((f) => f.liveStatus && f.liveStatus.live).map((f) => f.id));

  // Show progress immediately, even before the first network call resolves,
  // so the button visibly changes the moment it's clicked (answers "did this
  // actually do anything / is it instant?").
  refreshProgressLabel = "🔄 更新中…";

  // Clear every live badge that's about to be re-checked right away, so a
  // channel whose stream actually ended since the last refresh doesn't keep
  // showing "LIVE" for however long it takes this refresh to reach it -- it
  // only shows live again once freshly confirmed by this refresh.
  const toReset = new Set([
    ...(twFavs.length && isTwitchSignedIn() ? twFavs : []),
    ...(ytFavs.length && hasYoutubeApiKey() ? ytFavs : []),
  ]);
  if (toReset.size) {
    update((s) => {
      for (const f of s.favorites) if (toReset.has(f)) f.liveStatus = { live: false };
    });
  }
  renderFavorites();

    if (twFavs.length && isTwitchSignedIn()) {
      try {
        await checkTwitchLiveStatuses(prevLiveIds);
      } catch (err) {
        toast(`Twitchのライブ状況取得に失敗しました: ${err.message}`, "error");
      }
    }

    if (ytFavs.length && hasYoutubeApiKey()) {
      // YouTube has no "check many channels' live status at once" endpoint --
      // each channel needs its own couple of requests -- so instead of doing
      // them strictly one after another (waiting out each network round trip
      // before starting the next), run a small pool of them at the same time.
      // This doesn't change how many API calls are made (same quota cost),
      // it just stops waiting on network latency serially, so a large
      // favorites list finishes in a fraction of the time.
      const CONCURRENCY = 6;
      let quotaExceeded = false;
      let completed = 0;
      let nextIndex = 0;

      const checkOne = async (f) => {
        try {
          const live = await checkChannelLive(f.target.id);
          patchFavorite(f.id, {
            liveStatus: live
              ? { live: true, title: live.title, videoId: live.videoId, startedAt: live.startedAt, viewers: live.viewers }
              : { live: false },
          });
          if (live && !prevLiveIds.has(f.id)) {
            pushLiveAlert({ favId: f.id, name: f.name, avatar: f.avatar, platform: "youtube" });
          }
        } catch (err) {
          console.warn("checkChannelLive failed", err);
          // Once the daily quota is blown, every remaining call fails the
          // same way -- stop starting new checks and surface one clear
          // message instead of one silent failure per channel. Checks
          // already in flight are left to finish rather than aborted.
          if (/quota/i.test(err.message) || /\b429\b/.test(err.message)) quotaExceeded = true;
          renderFavorites();
        }
        completed++;
        refreshProgressLabel = `🔄 更新中… (${completed}/${ytFavs.length})`;
      };

      const worker = async () => {
        while (!quotaExceeded) {
          const i = nextIndex++;
          if (i >= ytFavs.length) return;
          await checkOne(ytFavs[i]);
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, ytFavs.length) }, worker)
      );

      if (quotaExceeded) {
        toast(
          "YouTube APIの1日のクォータ上限に達したため、途中で確認を中断しました。クォータは太平洋時間の深夜(日本時間で17時頃)にリセットされます。時間をおいてもう一度お試しください。",
          "error",
          9000
        );
      }
    }
  } finally {
    refreshProgressLabel = null;
    renderFavorites();
  }

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  toast(`ライブ状況を更新しました。(${seconds}秒)`);
}

async function resolveTwitchUserIds(twFavs) {
  const needResolve = twFavs.filter((f) => !f.target.userId);
  if (needResolve.length) {
    try {
      const metas = await fetchUsersByLogin(needResolve.map((f) => f.target.login));
      const byLogin = new Map(metas.map((m) => [m.login, m]));
      update((s) => {
        for (const f of s.favorites) {
          if (f.platform !== "twitch" || f.target.userId) continue;
          const m = byLogin.get(f.target.login);
          if (m) f.target.userId = m.userId;
        }
      });
    } catch (err) {
      console.warn("Failed to resolve Twitch user ids", err);
    }
  }
  return getState().favorites.filter((f) => f.platform === "twitch" && f.target.userId).map((f) => f.target.userId);
}

// -------- archive tab (simple: reuses the inline-per-favorite expander) --------
function renderArchiveTab() {
  const archiveList = qs("#archiveList");
  archiveList.innerHTML = "";
  const { favorites } = getState();
  if (!favorites.length) {
    archiveList.appendChild(el("div", { class: "list-empty" }, "まずお気に入りにチャンネルを追加してください。"));
    return;
  }
  archiveList.appendChild(el("div", { class: "list-note" },
    "各チャンネルの🕘ボタンでアーカイブ一覧を開けます（お気に入りタブと共通です）。"));
  for (const fav of favorites) archiveList.appendChild(buildFavoriteCard(fav));
}
