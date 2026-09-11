// Tiny DOM helpers (no framework).

export function qs(sel, root = document) {
  return root.querySelector(sel);
}
export function qsa(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "html") node.innerHTML = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
  }
  return node;
}

export function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

let toastHost = null;
export function toast(message, type = "info", timeout = 4200) {
  if (!toastHost) toastHost = document.getElementById("toastHost");
  if (!toastHost) return;
  const node = el("div", { class: `toast${type === "error" ? " error" : ""}` }, message);
  toastHost.appendChild(node);
  setTimeout(() => node.remove(), timeout);
}

// Minimal prompt() replacement using the in-page modal (native prompt() can be
// blocked by embedded iframes / some browsers, and looks out of place).
export function askText(title, defaultValue = "") {
  return new Promise((resolve) => {
    const backdrop = document.getElementById("promptModal");
    const titleEl = document.getElementById("promptTitle");
    const input = document.getElementById("promptInput");
    const okBtn = document.getElementById("promptOkBtn");
    const cancelBtn = document.getElementById("promptCancelBtn");
    const closeBtn = document.getElementById("promptCloseBtn");

    titleEl.textContent = title;
    input.value = defaultValue;
    backdrop.hidden = false;
    input.focus();
    input.select();

    function cleanup(result) {
      backdrop.hidden = true;
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      closeBtn.removeEventListener("click", onCancel);
      input.removeEventListener("keydown", onKey);
      resolve(result);
    }
    function onOk() { cleanup(input.value.trim() || null); }
    function onCancel() { cleanup(null); }
    function onKey(e) {
      if (e.key === "Enter") onOk();
      if (e.key === "Escape") onCancel();
    }
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    closeBtn.addEventListener("click", onCancel);
    input.addEventListener("keydown", onKey);
  });
}
