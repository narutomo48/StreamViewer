import { getState, update } from "./state.js";
import { qs, toast } from "./utils/dom.js";

export function initSettings() {
  const modal = qs("#settingsModal");
  const openBtn = qs("#settingsBtn");
  const closeBtn = qs("#settingsCloseBtn");
  const saveBtn = qs("#settingsSaveBtn");

  const ytKey = qs("#settingYtApiKey");
  const ytClient = qs("#settingYtClientId");
  const twClient = qs("#settingTwClientId");
  const twRedirect = qs("#settingTwRedirectUri");

  function open() {
    const s = getState().settings;
    ytKey.value = s.youtubeApiKey || "";
    ytClient.value = s.youtubeClientId || "";
    twClient.value = s.twitchClientId || "";
    twRedirect.value = s.twitchRedirectUri || (location.origin + location.pathname);
    modal.hidden = false;
  }
  function close() { modal.hidden = true; }

  openBtn.addEventListener("click", open);
  closeBtn.addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });

  saveBtn.addEventListener("click", () => {
    update((s) => {
      s.settings.youtubeApiKey = ytKey.value.trim();
      s.settings.youtubeClientId = ytClient.value.trim();
      s.settings.twitchClientId = twClient.value.trim();
      s.settings.twitchRedirectUri = twRedirect.value.trim();
    });
    toast("設定を保存しました。");
    close();
  });
}

export function hasYoutubeApiKey() {
  return !!(getState().settings.youtubeApiKey || "").trim();
}
export function hasYoutubeClientId() {
  return !!(getState().settings.youtubeClientId || "").trim();
}
export function hasTwitchClientId() {
  return !!(getState().settings.twitchClientId || "").trim();
}
