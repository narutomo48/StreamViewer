import { qs, toast } from "./utils/dom.js";
import { initGrid, autoArrange, clearAllPanels } from "./grid.js";
import { initSidebar, refreshAuthButtons, onTwitchLoginCompleted } from "./sidebar.js";
import { initPresetBar } from "./presets.js";
import { initSettings } from "./settings.js";
import { handleTwitchRedirect } from "./auth/twitchAuth.js";

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

async function main() {
  initGrid();
  initSidebar();
  initPresetBar();
  initSettings();
  wireTopbar();
  warnIfFileProtocol();
  registerServiceWorker();

  const cameFromTwitch = await handleTwitchRedirect();
  if (cameFromTwitch) {
    await onTwitchLoginCompleted();
  } else {
    refreshAuthButtons();
  }
}

main().catch((err) => {
  console.error(err);
  toast(`初期化中にエラーが発生しました: ${err.message}`, "error");
});
