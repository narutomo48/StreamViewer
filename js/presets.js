// Named layout presets: snapshot the current panels (position/size/volume/
// chat state/target) under a name, reload them later, export/import as JSON.

import { getState, update } from "./state.js";
import { qs, el, toast, askText } from "./utils/dom.js";

let selectEl, loadBtn, saveBtn, saveAsBtn, deleteBtn, exportBtn, importBtn, importFile;
let barEl, toggleBtn;

export function initPresetBar() {
  selectEl = qs("#presetSelect");
  loadBtn = qs("#presetLoadBtn");
  saveBtn = qs("#presetSaveBtn");
  saveAsBtn = qs("#presetSaveAsBtn");
  deleteBtn = qs("#presetDeleteBtn");
  exportBtn = qs("#presetExportBtn");
  importBtn = qs("#presetImportBtn");
  importFile = qs("#presetImportFile");
  barEl = qs("#presetBar");
  toggleBtn = qs("#presetBarToggleBtn");

  renderOptions();
  applyBarVisibility();

  loadBtn.addEventListener("click", loadSelected);
  saveBtn.addEventListener("click", saveCurrent);
  saveAsBtn.addEventListener("click", saveAsNew);
  deleteBtn.addEventListener("click", deleteSelected);
  exportBtn.addEventListener("click", exportPresets);
  importBtn.addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", onImportFile);
  selectEl.addEventListener("change", () => {
    update((s) => { s.activePreset = selectEl.value || null; });
  });
  toggleBtn.addEventListener("click", () => {
    update((s) => { s.presetBarVisible = !s.presetBarVisible; });
    applyBarVisibility();
  });
}

// The preset bar (読込/保存/書出 等) is off by default -- most people never
// touch it. This just toggles visibility; nothing about presets themselves
// changes, so hiding it is always safe/reversible via the 🗂 button.
function applyBarVisibility() {
  const visible = !!getState().presetBarVisible;
  barEl.hidden = !visible;
  toggleBtn.classList.toggle("active", visible);
  toggleBtn.title = visible ? "プリセットバーを非表示" : "プリセットバーを表示";
}

function renderOptions() {
  const state = getState();
  const names = Object.keys(state.presets).sort((a, b) => a.localeCompare(b, "ja"));
  selectEl.innerHTML = "";
  selectEl.appendChild(el("option", { value: "" }, "(未選択)"));
  for (const name of names) selectEl.appendChild(el("option", { value: name }, name));
  selectEl.value = state.activePreset && names.includes(state.activePreset) ? state.activePreset : "";
}

function snapshotPanels() {
  return getState().panels.map((p) => ({ ...p, target: { ...p.target } }));
}

async function saveAsNew() {
  const name = await askText("プリセット名を入力してください", getState().activePreset || "");
  if (!name) return;
  update((s) => {
    s.presets[name] = { panels: snapshotPanels() };
    s.activePreset = name;
  });
  renderOptions();
  toast(`プリセット「${name}」を保存しました。`);
}

function saveCurrent() {
  const state = getState();
  const name = state.activePreset;
  if (!name || !state.presets[name]) { saveAsNew(); return; }
  update((s) => { s.presets[name] = { panels: snapshotPanels() }; });
  toast(`プリセット「${name}」を上書き保存しました。`);
}

function loadSelected() {
  const state = getState();
  const name = selectEl.value;
  if (!name) { toast("読み込むプリセットを選択してください。", "error"); return; }
  const preset = state.presets[name];
  if (!preset) { toast("プリセットが見つかりません。", "error"); return; }
  update((s) => {
    s.panels = preset.panels.map((p) => ({ ...p, target: { ...p.target } }));
    s.activePreset = name;
  });
  toast(`プリセット「${name}」を読み込みました。`);
}

function deleteSelected() {
  const name = selectEl.value;
  if (!name) { toast("削除するプリセットを選択してください。", "error"); return; }
  if (!window.confirm(`プリセット「${name}」を削除しますか？`)) return;
  update((s) => {
    delete s.presets[name];
    if (s.activePreset === name) s.activePreset = null;
  });
  renderOptions();
  toast(`プリセット「${name}」を削除しました。`);
}

function exportPresets() {
  const state = getState();
  if (!Object.keys(state.presets).length) { toast("書き出せるプリセットがありません。", "error"); return; }
  const blob = new Blob([JSON.stringify({ streamviewerPresets: state.presets }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `streamviewer-presets-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function onImportFile(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const incoming = parsed.streamviewerPresets || parsed;
    if (!incoming || typeof incoming !== "object") throw new Error("不正なファイル形式です。");
    update((s) => { s.presets = { ...s.presets, ...incoming }; });
    renderOptions();
    toast(`${Object.keys(incoming).length}件のプリセットを読み込みました。`);
  } catch (err) {
    toast(`インポートに失敗しました: ${err.message}`, "error");
  }
}

export function refreshPresetBar() {
  renderOptions();
}
