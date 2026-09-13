// The free-form multiview canvas: add/remove panels, drag & resize them
// freely, per-panel volume + chat toggle. No external grid library --
// hand-rolled with pointer events so the whole app has zero build step.

import { getState, update, subscribe, nextZ, uid } from "./state.js";
import { fallbackLabel } from "./utils/parseStream.js";
import { createYoutubePlayer } from "./players/youtube.js";
import { createTwitchPlayer } from "./players/twitch.js";
import { buildChatPane } from "./chat.js";
import { el, clamp } from "./utils/dom.js";

const DEFAULT_W = 480;
const DEFAULT_H = 300;
const CHAT_DEFAULT_W = 360;
const CHAT_DEFAULT_H = 520;
const MIN_W = 240;
const MIN_H = 170;
const GAP = 16;

// Neither YouTube's nor Twitch's embedded player exposes "an ad is currently
// playing" to embedding pages -- there is no supported way to tell a
// pre-roll ad apart from the real content. As a practical stand-in: when a
// panel is opened unmuted, force-mute it for this warm-up window (long
// enough to cover most pre-roll ads) before restoring the panel's actual
// volume/mute setting. This costs a few silent seconds of real content when
// there was no ad, which is a much smaller annoyance than a sudden loud ad.
const AD_GUARD_MS = 6000;

let canvasEl, canvasWrapEl, emptyStateEl, autoArrangeBtn;

// Auto-arrange cycles through a fixed set of column counts each time the
// button is pressed (1 -> 2 -> 3 -> 1 -> ...), instead of always picking
// the "best fit" column count automatically.
const AUTO_ARRANGE_COLS_CYCLE = [1, 2, 3];
let autoArrangeCycleIndex = 0;
const instances = new Map(); // panelId -> { root, videoBox, chatBox, player, headerVolume, muteBtn, chatBtn, destroyed, isChatOnly }

export function initGrid() {
  canvasEl = document.getElementById("canvas");
  canvasWrapEl = document.getElementById("canvasWrap");
  emptyStateEl = document.getElementById("emptyState");
  autoArrangeBtn = document.getElementById("autoArrangeBtn");

  subscribe((state) => reconcile(state));
  window.addEventListener("resize", () => applyResponsiveMode());
  reconcile(getState());
}

function targetKey(target) {
  if (!target) return "";
  return [target.platform, target.mode, target.id || "", target.login || "", target.idType || ""].join("|");
}

// kind: "stream" (video, optionally with an attached chat pane) or "chat"
// (a standalone floating window showing only that target's chat -- see
// detachChat below). x/y/w/h in opts override the auto-computed default
// position/size, used when spawning a detached chat next to its source panel.
export function addPanel(target, opts = {}) {
  if (!target) return null;
  const state = getState();
  const id = uid("panel");
  const idx = state.panels.length;
  const kind = opts.kind === "chat" ? "chat" : "stream";
  const defaultW = kind === "chat" ? CHAT_DEFAULT_W : DEFAULT_W;
  const defaultH = kind === "chat" ? CHAT_DEFAULT_H : DEFAULT_H;
  const pos = (typeof opts.x === "number" && typeof opts.y === "number")
    ? { x: opts.x, y: opts.y }
    : computeInitialPosition(idx, defaultW, defaultH);
  const panel = {
    id,
    kind,
    target,
    title: opts.title || fallbackLabel(target),
    avatar: opts.avatar || "",
    volume: typeof opts.volume === "number" ? opts.volume : 80,
    muted: !!opts.muted,
    showChat: kind === "chat" ? true : (opts.showChat !== undefined ? !!opts.showChat : true),
    x: pos.x, y: pos.y,
    w: typeof opts.w === "number" ? opts.w : defaultW,
    h: typeof opts.h === "number" ? opts.h : defaultH,
    z: nextZ(),
  };
  update((s) => { s.panels.push(panel); });
  return id;
}

// Pulls a stream panel's attached chat out into its own independently
// draggable/resizable floating panel, positioned just to its right. The
// original panel keeps playing video; its attached chat pane is folded away
// (toggle the 💬 button to bring an *attached* chat back). Closing the
// floating chat panel later (✕) just removes that window -- it does not
// automatically reattach.
export function detachChat(panelId) {
  const panel = getState().panels.find((p) => p.id === panelId);
  if (!panel || panel.kind === "chat") return;
  update((s) => {
    const p = s.panels.find((x) => x.id === panelId);
    if (p) p.showChat = false;
  });
  addPanel(panel.target, {
    kind: "chat",
    title: `${panel.title} - チャット`,
    avatar: panel.avatar,
    x: panel.x + panel.w + GAP,
    y: panel.y,
    w: CHAT_DEFAULT_W,
    h: Math.max(panel.h, MIN_H),
  });
}

export function removePanel(id) {
  update((s) => { s.panels = s.panels.filter((p) => p.id !== id); });
}

export function clearAllPanels() {
  update((s) => { s.panels = []; });
}

export function setPanelVolume(id, volume) {
  update((s) => {
    const p = s.panels.find((x) => x.id === id);
    if (p) { p.volume = clamp(volume, 0, 100); if (p.volume > 0) p.muted = false; }
  }, { notify: false }); // avoid full re-render fighting the slider mid-drag; UI already reflects it locally
}

export function setPanelMuted(id, muted) {
  update((s) => {
    const p = s.panels.find((x) => x.id === id);
    if (p) p.muted = !!muted;
  }, { notify: false });
}

export function togglePanelChat(id) {
  const state = getState();
  const panel = state.panels.find((p) => p.id === id);
  if (!panel) return;
  update((s) => {
    const p = s.panels.find((x) => x.id === id);
    if (p) p.showChat = !p.showChat;
  });
}

// Tiles panels edge-to-edge (no gap between them, no outer margin) so the
// grid reads like a real multiviewer wall -- only each panel's 1px border
// separates neighbors. (GAP is still used elsewhere -- organic placement of
// newly-added panels, and positioning a detached chat next to its source --
// just not here.)
export function autoArrange() {
  const state = getState();
  const panels = state.panels;
  if (!panels.length) return;

  const desiredCols = AUTO_ARRANGE_COLS_CYCLE[autoArrangeCycleIndex];
  autoArrangeCycleIndex = (autoArrangeCycleIndex + 1) % AUTO_ARRANGE_COLS_CYCLE.length;

  const wrapW = Math.max(canvasWrapEl.clientWidth, DEFAULT_W);
  const cols = Math.max(1, Math.min(panels.length, desiredCols));
  const rows = Math.ceil(panels.length / cols);
  const tileW = Math.floor(wrapW / cols);
  const wrapH = Math.max(canvasWrapEl.clientHeight, DEFAULT_H);
  const tileH = Math.max(MIN_H, Math.floor(wrapH / rows));

  update((s) => {
    s.panels.forEach((p, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      p.x = col * tileW;
      p.y = row * tileH;
      p.w = tileW;
      p.h = tileH;
    });
  });

  if (autoArrangeBtn) {
    autoArrangeBtn.textContent = `自動整列 (${cols}列)`;
    autoArrangeBtn.title = `自動整列 -- 現在${cols}列。もう一度押すと${AUTO_ARRANGE_COLS_CYCLE[autoArrangeCycleIndex]}列に切り替わります`;
  }
}

function computeInitialPosition(index, w = DEFAULT_W, h = DEFAULT_H) {
  const wrapW = (canvasWrapEl && canvasWrapEl.clientWidth) || 1200;
  const cols = Math.max(1, Math.floor((wrapW - GAP) / (w + GAP)));
  const col = index % cols;
  const row = Math.floor(index / cols);
  const cascade = (row % 4) * 18;
  return { x: GAP + col * (w + GAP) + cascade, y: GAP + row * (h + GAP) };
}

// ---------------- reconciliation ----------------

function reconcile(state) {
  const panels = state.panels;
  emptyStateEl.hidden = panels.length > 0;
  canvasEl.classList.toggle("has-panels", panels.length > 0);

  const liveIds = new Set(panels.map((p) => p.id));
  for (const [id, inst] of instances) {
    if (!liveIds.has(id)) {
      destroyInstance(inst);
      instances.delete(id);
    }
  }

  for (const panel of panels) {
    let inst = instances.get(panel.id);
    if (!inst) {
      inst = mountPanel(panel);
      instances.set(panel.id, inst);
    } else {
      updateInstance(inst, panel);
    }
  }

  applyResponsiveMode();
  updateCanvasExtent(panels);
}

function applyResponsiveMode() {
  if (!canvasEl) return;
  canvasEl.classList.toggle("mobile-stack", window.innerWidth <= 820);
}

function updateCanvasExtent(panels) {
  if (!canvasEl) return;
  let maxX = 0, maxY = 0;
  for (const p of panels) {
    maxX = Math.max(maxX, p.x + p.w);
    maxY = Math.max(maxY, p.y + p.h);
  }
  canvasEl.style.minWidth = panels.length ? `${maxX + GAP}px` : "100%";
  canvasEl.style.minHeight = panels.length ? `${maxY + GAP}px` : "100%";
}

function destroyInstance(inst) {
  inst.destroyed = true;
  if (inst.adGuardTimer) { clearTimeout(inst.adGuardTimer); inst.adGuardTimer = null; }
  try { inst.player && inst.player.destroy(); } catch {}
  try { inst.root.remove(); } catch {}
}

// ---------------- panel DOM ----------------

function platformDot(platform) {
  return el("span", { class: `platform-dot ${platform}` });
}

function buildExternalUrl(target) {
  if (target.platform === "youtube") {
    if (target.mode === "video") return `https://www.youtube.com/watch?v=${target.id}`;
    if (target.idType === "channelId") return `https://www.youtube.com/channel/${target.id}`;
    if (target.idType === "handle") return `https://www.youtube.com/${target.id}`;
    if (target.idType === "custom") return `https://www.youtube.com/c/${target.id}`;
    if (target.idType === "user") return `https://www.youtube.com/user/${target.id}`;
  }
  if (target.platform === "twitch") {
    if (target.mode === "video") return `https://www.twitch.tv/videos/${target.id}`;
    return `https://www.twitch.tv/${target.login}`;
  }
  return "#";
}

function mountPanel(panel) {
  const root = el("div", {
    class: `stream-panel${panel.kind === "chat" ? " chat-panel" : ""}`,
    dataset: { id: panel.id },
  });
  root.style.left = `${panel.x}px`;
  root.style.top = `${panel.y}px`;
  root.style.width = `${panel.w}px`;
  root.style.height = `${panel.h}px`;
  root.style.zIndex = String(panel.z || 1);

  if (panel.kind === "chat") return mountChatPanel(root, panel);

  const volumeInput = el("input", {
    type: "range", min: "0", max: "100", value: String(panel.volume),
    title: "音量",
    oninput: (e) => {
      // A manual volume change means the user has already decided what they
      // want to hear -- don't let the ad-guard timer override it later.
      if (inst.adGuardTimer) { clearTimeout(inst.adGuardTimer); inst.adGuardTimer = null; }
      const v = Number(e.target.value);
      setPanelVolume(panel.id, v);
      inst.player && inst.player.setVolume(v);
      muteBtn.textContent = v === 0 ? "🔇" : "🔊";
    },
  });

  const muteBtn = el("button", {
    class: "ctrl-btn",
    title: "ミュート切替",
    onclick: () => {
      // Same as above -- a manual mute/unmute click overrides the ad-guard timer.
      if (inst.adGuardTimer) { clearTimeout(inst.adGuardTimer); inst.adGuardTimer = null; }
      const cur = getState().panels.find((p) => p.id === panel.id);
      const nextMuted = cur ? !cur.muted : false;
      setPanelMuted(panel.id, nextMuted);
      inst.player && inst.player.setMuted(nextMuted);
      muteBtn.textContent = nextMuted ? "🔇" : (Number(volumeInput.value) === 0 ? "🔇" : "🔊");
    },
  }, panel.muted || panel.volume === 0 ? "🔇" : "🔊");

  const chatBtn = el("button", {
    class: `ctrl-btn${panel.showChat ? " active" : ""}`,
    title: "チャット表示切替",
    onclick: () => togglePanelChat(panel.id),
  }, "💬");

  const detachChatBtn = el("button", {
    class: "ctrl-btn",
    title: "チャットを別ウィンドウにする",
    onclick: () => detachChat(panel.id),
  }, "🗗");

  const linkBtn = el("a", {
    class: "ctrl-btn", href: buildExternalUrl(panel.target), target: "_blank", rel: "noopener noreferrer", title: "外部で開く",
  }, "↗");

  const closeBtn = el("button", {
    class: "ctrl-btn", title: "閉じる",
    onclick: () => removePanel(panel.id),
  }, "✕");

  const titleEl = el("span", { class: "title" }, panel.title);

  const header = el("div", { class: "panel-header" }, [
    platformDot(panel.target.platform),
    titleEl,
    el("span", { class: "volume-wrap" }, [muteBtn, volumeInput]),
    chatBtn,
    detachChatBtn,
    linkBtn,
    closeBtn,
  ]);

  const videoBox = el("div", { class: "panel-video" });
  const chatBox = el("div", { class: "panel-chat" });
  const body = el("div", { class: "panel-body" }, panel.showChat ? [videoBox, chatBox] : [videoBox]);

  root.appendChild(header);
  root.appendChild(body);
  const resizeHandle = el("div", { class: "resize-handle", title: "ドラッグでサイズ変更" });
  root.appendChild(resizeHandle);

  canvasEl.appendChild(root);

  const inst = {
    root, header, videoBox, chatBox, body, volumeInput, muteBtn, chatBtn,
    player: null, lastShowChat: panel.showChat, lastTargetKey: targetKey(panel.target),
    destroyed: false, isChatOnly: false,
  };

  attachDrag(root, header, panel.id);
  attachResize(root, resizeHandle, panel.id);

  mountPlayer(inst, panel);
  if (panel.showChat) buildChatPane(panel.target, chatBox);

  return inst;
}

// A standalone floating chat window (see detachChat) -- just the chat iframe,
// draggable/resizable/closable like any panel, but no video player, volume
// controls, or chat-toggle (it IS the chat).
function mountChatPanel(root, panel) {
  const linkBtn = el("a", {
    class: "ctrl-btn", href: buildExternalUrl(panel.target), target: "_blank", rel: "noopener noreferrer", title: "外部で開く",
  }, "↗");
  const closeBtn = el("button", {
    class: "ctrl-btn", title: "閉じる",
    onclick: () => removePanel(panel.id),
  }, "✕");
  const titleEl = el("span", { class: "title" }, panel.title);
  const header = el("div", { class: "panel-header" }, [
    platformDot(panel.target.platform),
    titleEl,
    linkBtn,
    closeBtn,
  ]);

  const chatBox = el("div", { class: "panel-chat standalone" });
  const body = el("div", { class: "panel-body" }, [chatBox]);

  root.appendChild(header);
  root.appendChild(body);
  const resizeHandle = el("div", { class: "resize-handle", title: "ドラッグでサイズ変更" });
  root.appendChild(resizeHandle);

  canvasEl.appendChild(root);

  const inst = {
    root, header, chatBox, body,
    player: null, lastTargetKey: targetKey(panel.target),
    destroyed: false, isChatOnly: true,
  };

  attachDrag(root, header, panel.id);
  attachResize(root, resizeHandle, panel.id);
  buildChatPane(panel.target, chatBox);

  return inst;
}

function mountPlayer(inst, panel) {
  const target = panel.target;
  // See AD_GUARD_MS above -- force a silent start even for a panel the user
  // wants audible, then restore its real volume/mute setting shortly after.
  // A panel the user already muted needs no guard (it's silent either way).
  const guardAgainstAds = !panel.muted;
  const commonOpts = {
    volume: panel.volume,
    muted: guardAgainstAds ? true : panel.muted,
    onReady: () => {},
    onError: () => {
      if (inst.destroyed) return;
      if (target.platform === "youtube" && target.mode === "channel") {
        // YouTube's "whatever is live on this channel" embed
        // (embed/live_stream?channel=) frequently refuses to play at all when
        // embedded on a non-YouTube origin (confirmed: even well-known,
        // definitely-live, definitely-embeddable channels fail this way) --
        // this is a known limitation of that embed trick, not a broken URL.
        showVideoFallback(
          inst,
          "現在の配信を自動再生できませんでした（YouTube側の埋め込み仕様上の制限です）。設定でYouTube APIキーを登録するとクリックだけで確実に再生できるようになります。それまでは動画URLを直接貼り付けてください。",
          buildExternalUrl(target)
        );
      } else {
        showVideoFallback(inst, "この動画/チャンネルは再生できませんでした。URLをご確認ください。", buildExternalUrl(target));
      }
    },
    onUnsupported: () => {
      showVideoFallback(
        inst,
        "この形式のチャンネル(@ハンドル / カスタムURL)を自動再生するには、設定でYouTube APIキーを登録してください。動画URLを直接追加すればすぐに視聴できます。"
      );
    },
  };

  const playerPromise = target.platform === "youtube"
    ? createYoutubePlayer(inst.videoBox, target, commonOpts)
    : createTwitchPlayer(inst.videoBox, target, commonOpts);

  playerPromise.then((handle) => {
    if (inst.destroyed) { try { handle.destroy(); } catch {} return; }
    inst.player = handle;

    if (guardAgainstAds) {
      inst.adGuardTimer = setTimeout(() => {
        inst.adGuardTimer = null;
        if (inst.destroyed) return;
        try { handle.setVolume(panel.volume); handle.setMuted(panel.muted); } catch {}
      }, AD_GUARD_MS);
    }
  }).catch((err) => {
    console.warn(err);
    if (!inst.destroyed) showVideoFallback(inst, "プレイヤーの読み込みに失敗しました。");
  });
}

function showVideoFallback(inst, message, externalUrl) {
  inst.videoBox.innerHTML = "";
  const children = [message];
  if (externalUrl && externalUrl !== "#") {
    children.push(el("a", { class: "btn", href: externalUrl, target: "_blank", rel: "noopener noreferrer" }, "YouTube/Twitchで直接開く"));
  }
  inst.videoBox.appendChild(el("div", { class: "video-fallback" }, children));
}

function updateInstance(inst, panel) {
  if (inst.destroyed) return;
  inst.root.style.left = `${panel.x}px`;
  inst.root.style.top = `${panel.y}px`;
  inst.root.style.width = `${panel.w}px`;
  inst.root.style.height = `${panel.h}px`;
  inst.root.style.zIndex = String(panel.z || 1);

  const titleEl = inst.header.querySelector(".title");
  if (titleEl && titleEl.textContent !== panel.title) titleEl.textContent = panel.title;

  if (inst.isChatOnly) {
    const chatKey = targetKey(panel.target);
    if (chatKey !== inst.lastTargetKey) {
      inst.lastTargetKey = chatKey;
      buildChatPane(panel.target, inst.chatBox);
    }
    return;
  }

  if (document.activeElement !== inst.volumeInput && Number(inst.volumeInput.value) !== panel.volume) {
    inst.volumeInput.value = String(panel.volume);
  }
  inst.muteBtn.textContent = panel.muted || panel.volume === 0 ? "🔇" : "🔊";
  inst.chatBtn.classList.toggle("active", !!panel.showChat);

  const key = targetKey(panel.target);
  if (key !== inst.lastTargetKey) {
    // Target changed (shouldn't normally happen post-creation) -- remount player.
    inst.lastTargetKey = key;
    try { inst.player && inst.player.destroy(); } catch {}
    inst.videoBox.innerHTML = "";
    mountPlayer(inst, panel);
  }

  if (panel.showChat !== inst.lastShowChat) {
    inst.lastShowChat = panel.showChat;
    if (panel.showChat) {
      if (!inst.body.contains(inst.chatBox)) inst.body.appendChild(inst.chatBox);
      buildChatPane(panel.target, inst.chatBox);
    } else if (inst.body.contains(inst.chatBox)) {
      inst.chatBox.innerHTML = "";
      inst.body.removeChild(inst.chatBox);
    }
  }
}

// ---------------- drag & resize ----------------

function bringToFront(panelId) {
  const z = nextZ();
  update((s) => {
    const p = s.panels.find((x) => x.id === panelId);
    if (p) p.z = z;
  }, { notify: false });
  const inst = instances.get(panelId);
  if (inst) inst.root.style.zIndex = String(z);
}

function attachDrag(root, handle, panelId) {
  let startX = 0, startY = 0, startLeft = 0, startTop = 0, dragging = false;

  handle.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button, a, input")) return; // don't drag when clicking controls
    dragging = true;
    root.classList.add("dragging");
    bringToFront(panelId);
    startX = e.clientX; startY = e.clientY;
    startLeft = root.offsetLeft; startTop = root.offsetTop;
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const newLeft = Math.max(0, startLeft + dx);
    const newTop = Math.max(0, startTop + dy);
    root.style.left = `${newLeft}px`;
    root.style.top = `${newTop}px`;
  });
  function end(e) {
    if (!dragging) return;
    dragging = false;
    root.classList.remove("dragging");
    try { handle.releasePointerCapture(e.pointerId); } catch {}
    const left = root.offsetLeft, top = root.offsetTop;
    update((s) => {
      const p = s.panels.find((x) => x.id === panelId);
      if (p) { p.x = left; p.y = top; }
    });
  }
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}

function attachResize(root, handleEl, panelId) {
  let startX = 0, startY = 0, startW = 0, startH = 0, resizing = false;

  handleEl.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    resizing = true;
    root.classList.add("resizing");
    bringToFront(panelId);
    startX = e.clientX; startY = e.clientY;
    startW = root.offsetWidth; startH = root.offsetHeight;
    handleEl.setPointerCapture(e.pointerId);
  });
  handleEl.addEventListener("pointermove", (e) => {
    if (!resizing) return;
    const dw = e.clientX - startX;
    const dh = e.clientY - startY;
    const w = Math.max(MIN_W, startW + dw);
    const h = Math.max(MIN_H, startH + dh);
    root.style.width = `${w}px`;
    root.style.height = `${h}px`;
  });
  function end(e) {
    if (!resizing) return;
    resizing = false;
    root.classList.remove("resizing");
    try { handleEl.releasePointerCapture(e.pointerId); } catch {}
    const w = root.offsetWidth, h = root.offsetHeight;
    update((s) => {
      const p = s.panels.find((x) => x.id === panelId);
      if (p) { p.w = w; p.h = h; }
    });
  }
  handleEl.addEventListener("pointerup", end);
  handleEl.addEventListener("pointercancel", end);
}
