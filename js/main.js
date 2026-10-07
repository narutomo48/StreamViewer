import { qs, toast } from "./utils/dom.js";
import { initGrid, autoArrange, clearAllPanels } from "./grid.js";
import { initSidebar, refreshAuthButtons, onTwitchLoginCompleted } from "./sidebar.js";
import { initPresetBar } from "./presets.js";
import { initSettings } from "./settings.js";
import { handleTwitchRedirect, isTwitchTokenExpired, signInTwitch } from "./auth/twitchAuth.js";
import { startYoutubeSilentRefresh } from "./auth/googleAuth.js";
import { hasTwitchClientId } from "./settings.js";

function wireTopbar() {
  const sidebarToggle = qs("#sidebarToggle");
  const sidebar = qs("#sidebar");
  sidebarToggle.addEventListener("click", () => sidebar.classList.toggle("collapsed"));

  // Start collapsed on narrow screens so the canvas is visible first.
  if (window.innerWidth <= 820) sidebar.classList.add("collapsed");

  qs("#autoArrangeBtn").addEventListener("click", autoArrange);
  qs("#clearAllBtn").addEventListener("click", () => {
    if (window.confirm("開いている配信をすべて閉じますか？")) clearAllPanels();
  });
}

function warnIfFileProtocol() {
  if (location.protocol === "file:") {
    toast(
      "この画面は file:// から直接開かれています。ログインやチャット表示を使うにはローカルサーバー経由 (README参照) で開いてください。",
      "error",
      9000
    );
  }
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  if (location.protocol === "file:") return; // SW requires http(s)
  try {
    await navigator.serviceWorker.register("sw.js");
  } catch (err) {
    console.warn("Service worker registration failed (safe to ignore in dev).", err);
  }
}

// Twitch's implicit-grant token has no silent/background refresh path --
// its OAuth endpoint blocks being embedded in an iframe (X-Frame-Options),
// and the implicit flow issues no refresh token (see isTwitchTokenExpired()
// in twitchAuth.js) -- so renewing it without a manual click means a
// full-page redirect to Twitch and back. That's only safe to do
// automatically right here, at startup before the user has opened anything:
// panels never persist across a reload anyway (see state.js), so there's
// nothing on screen to lose. Doing this mid-session instead would silently
// blow away whatever the user has open. If the user is still logged into
// twitch.tv and already approved this app's scopes, Twitch skips its
// consent screen and redirects straight back almost instantly -- otherwise
// it just shows the normal Twitch login page, same as clicking
// "Twitchでログイン" would.
function maybeAutoReloginTwitch() {
  if (!isTwitchTokenExpired()) return; // never signed in, or still valid -- nothing to do
  if (!hasTwitchClientId()) return;
  try {
    signInTwitch();
  } catch (err) {
    console.warn("Twitchの自動再ログインに失敗しました", err);
  }
}

async function main() {
  initGrid();
  initSidebar();
  initPresetBar();
  initSettings();
  wireTopbar();
  warnIfFileProtocol();
  registerServiceWorker();
  startYoutubeSilentRefresh();

  const cameFromTwitch = await handleTwitchRedirect();
  if (cameFromTwitch) {
    await onTwitchLoginCompleted();
  } else {
    refreshAuthButtons();
    maybeAutoReloginTwitch();
  }
}

main().catch((err) => {
  console.error(err);
  toast(`初期化中にエラーが発生しました: ${err.message}`, "error");
});
