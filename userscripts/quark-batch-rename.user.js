// ==UserScript==
// @name         Quark Batch Rename Helper
// @namespace    https://local.travisoa.com/userscripts
// @version      0.1.10
// @description  Add a compact batch rename panel to Quark Drive file lists.
// @author       Codex
// @match        https://pan.quark.cn/*
// @icon         data:image/png;base64,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
// @homepageURL  https://github.com/travisoa/scriptbox
// @downloadURL  https://raw.githubusercontent.com/travisoa/scriptbox/main/userscripts/quark-batch-rename.user.js
// @updateURL    https://raw.githubusercontent.com/travisoa/scriptbox/main/userscripts/quark-batch-rename.user.js
// @connect      drive-pc.quark.cn
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const PANEL_ID = "codex-quark-batch-rename";
  const PANEL_TOP_KEY = "codex-quark-batch-rename-top";
  const DEFAULT_PANEL_TOP = 168;
  const MIN_PANEL_TOP = 132;
  const ROBOT_ICON = (typeof GM_info !== "undefined" && GM_info.script && (GM_info.script.icon || GM_info.script.icon64)) || "data:image/png;base64,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";
  const VIDEO_EXT_RE = /\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|ts|m2ts|rmvb)$/i;

  const state = {
    files: [],
    preview: [],
    busy: false,
  };

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function currentFolderFid() {
    const parts = String(location.hash || "").split("/").filter(Boolean);
    const last = parts[parts.length - 1] || "";
    return last.split("-")[0] || "0";
  }

  function fileNameFromRow(row) {
    const node = row.querySelector(".filename-text[title], .filename-text, [title]");
    const title = node && node.getAttribute("title");
    const text = title || (node && node.textContent) || "";
    return text.trim();
  }

  function visibleRows() {
    return [...document.querySelectorAll("tr[data-row-key]")].map((row) => {
      const checkbox = row.querySelector('input[type="checkbox"]');
      const checked =
        Boolean(checkbox && checkbox.checked) ||
        Boolean(row.querySelector(".ant-checkbox-checked")) ||
        row.classList.contains("ant-table-row-selected");
      return {
        fid: row.getAttribute("data-row-key"),
        file_name: fileNameFromRow(row),
        checked,
        row,
      };
    }).filter((item) => item.fid && item.file_name);
  }

  function headerChecked() {
    const header = document.querySelector(".tr-header input[type='checkbox'], thead input[type='checkbox']");
    return Boolean(header && header.checked);
  }

  async function quarkJson(path, options = {}) {
    const sep = path.includes("?") ? "&" : "?";
    const url = `https://drive-pc.quark.cn${path}${sep}pr=ucpro&fr=pc`;
    const res = await fetch(url, {
      credentials: "include",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`接口返回不是 JSON：${text.slice(0, 160)}`);
    }
    if (!res.ok || (json.code && json.code !== 0) || (json.status && json.status !== 200 && json.status !== "OK")) {
      throw new Error(json.message || json.msg || `接口失败：HTTP ${res.status}`);
    }
    return json;
  }

  function normalizeListPayload(json) {
    const data = json.data || json;
    const list = data.list || data.file_list || data.items || [];
    const total =
      data.total ||
      data._total ||
      (data.metadata && (data.metadata._total || data.metadata.total)) ||
      list.length;
    return { list, total };
  }

  async function listCurrentFolderFiles() {
    const pdirFid = currentFolderFid();
    const out = [];
    let page = 1;
    let total = Infinity;
    while (out.length < total) {
      const query = new URLSearchParams({
        pdir_fid: pdirFid,
        _page: String(page),
        _size: "200",
        _fetch_total: page === 1 ? "1" : "0",
        _fetch_sub_dirs: "0",
        _sort: "file_type:asc,updated_at:desc",
        fetch_all_file: "1",
        fetch_risk_file_name: "1",
      });
      const json = await quarkJson(`/1/clouddrive/file/sort?${query.toString()}`, { method: "GET" });
      const payload = normalizeListPayload(json);
      total = Number(payload.total) || out.length + payload.list.length;
      out.push(...payload.list.map((item) => ({
        fid: item.fid || item.file_id || item.id,
        file_name: item.file_name || item.name || item.title,
      })).filter((item) => item.fid && item.file_name));
      if (!payload.list.length || payload.list.length < 200) break;
      page += 1;
    }
    return out;
  }

  function selectedVisibleFiles() {
    return visibleRows().filter((item) => item.checked && VIDEO_EXT_RE.test(item.file_name));
  }

  async function loadFiles() {
    const mode = getValue("source");
    if (mode === "folder" || (mode === "auto" && headerChecked())) {
      state.files = (await listCurrentFolderFiles()).filter((item) => VIDEO_EXT_RE.test(item.file_name));
    } else {
      state.files = selectedVisibleFiles();
    }
    renderStatus(`已读取 ${state.files.length} 个视频文件`);
    return state.files;
  }

  function splitName(name) {
    const dot = name.lastIndexOf(".");
    if (dot <= 0) return { stem: name, ext: "" };
    return { stem: name.slice(0, dot), ext: name.slice(dot) };
  }

  function renameByRule(fileName) {
    const op = getValue("operation");
    const { stem, ext } = splitName(fileName);
    if (op === "prefix") {
      const prefix = getValue("prefix");
      return prefix && !fileName.startsWith(prefix) ? `${prefix}${fileName}` : fileName;
    }
    if (op === "regex") {
      const from = getValue("regexFrom");
      const to = getValue("regexTo");
      if (!from) return fileName;
      return fileName.replace(new RegExp(from, "g"), to);
    }
    if (op === "removeEnglish") {
      const cleaned = fileName
        .replace(/^([\u4e00-\u9fa5]+)\.[A-Za-z][A-Za-z0-9.-]*?(S\d{1,2}E\d{1,3}.*)$/i, "$1.$2")
        .replace(/\.{2,}/g, ".")
        .replace(/\s{2,}/g, " ");
      return cleaned;
    }
    if (op === "cnEpisode") {
      const season = getValue("season").trim().replace(/^0+/, "") || "1";
      const seasonText = season.padStart(2, "0");
      return fileName.replace(/第0*(\d{1,3})集/g, (_match, episode) => (
        `S${seasonText}E${episode.padStart(2, "0")}`
      ));
    }
    if (op === "episode") {
      const show = getValue("showName").trim();
      const m = stem.match(/S(\d{1,2})E(\d{1,3})/i);
      if (!show || !m) return fileName;
      return `${show}.S${m[1].padStart(2, "0")}E${m[2].padStart(2, "0")}${ext}`;
    }
    return fileName;
  }

  function validateRule() {
    const op = getValue("operation");
    if (op === "prefix" && !getValue("prefix").trim()) return "请先填写要添加的前缀";
    if (op === "regex" && !getValue("regexFrom").trim()) return "请先填写 From 正则";
    if (op === "cnEpisode" && !/^(?:0?[1-9]|[1-9]\d)$/.test(getValue("season").trim())) return "请填写 1-99 的季号";
    if (op === "episode" && !getValue("showName").trim()) return "请先填写剧名";
    return "";
  }

  function buildPreview() {
    const ruleWarning = validateRule();
    if (ruleWarning) {
      state.preview = [];
      renderStatus(ruleWarning);
      renderPreview();
      return state.preview;
    }
    state.preview = state.files.map((file) => ({
      ...file,
      new_name: renameByRule(file.file_name),
    })).filter((item) => item.new_name && item.new_name !== item.file_name);
    const names = new Set();
    const duplicates = [];
    for (const item of state.preview) {
      if (names.has(item.new_name)) duplicates.push(item.new_name);
      names.add(item.new_name);
    }
    renderPreview(duplicates);
    return state.preview;
  }

  async function renameOne(item) {
    return quarkJson("/1/clouddrive/file/rename", {
      method: "POST",
      body: JSON.stringify({ fid: item.fid, file_name: item.new_name }),
    });
  }

  function updateVisibleRow(item) {
    const row = document.querySelector(`tr[data-row-key="${CSS.escape(item.fid)}"]`);
    if (!row) return;
    const nameNode = row.querySelector(".filename-text");
    if (nameNode) {
      nameNode.textContent = item.new_name;
      nameNode.setAttribute("title", item.new_name);
    }
  }

  async function runRename() {
    if (state.busy) return;
    state.busy = true;
    setBusy(true);
    try {
      if (!state.files.length) await loadFiles();
      const preview = buildPreview();
      if (!preview.length) {
        renderStatus("没有需要改名的文件");
        return;
      }
      if (!confirm(`确认重命名 ${preview.length} 个文件？`)) return;
      let ok = 0;
      const failed = [];
      for (const item of preview) {
        try {
          await renameOne(item);
          ok += 1;
          updateVisibleRow(item);
          renderStatus(`重命名中：${ok}/${preview.length}`);
          await sleep(180);
        } catch (error) {
          failed.push(`${item.file_name}: ${error.message}`);
        }
      }
      renderStatus(failed.length ? `完成 ${ok} 个，失败 ${failed.length} 个` : `完成 ${ok} 个文件`);
      renderPreview([], failed);
      if (!failed.length) setTimeout(() => location.reload(), 1000);
    } finally {
      state.busy = false;
      setBusy(false);
    }
  }

  function getValue(name) {
    const el = document.querySelector(`#${PANEL_ID} [name="${name}"]`);
    return el ? el.value : "";
  }

  function setBusy(isBusy) {
    document.querySelectorAll(`#${PANEL_ID} button, #${PANEL_ID} input, #${PANEL_ID} select`)
      .forEach((el) => {
        if (el.dataset.keepEnabled !== "1") el.disabled = isBusy;
      });
  }

  function renderStatus(text) {
    const el = document.querySelector(`#${PANEL_ID} .qbr-status`);
    if (el) el.textContent = text;
  }

  function renderPreview(duplicates = [], failed = []) {
    const el = document.querySelector(`#${PANEL_ID} .qbr-preview`);
    if (!el) return;
    const rows = state.preview.slice(0, 120).map((item) => (
      `<tr><td title="${escapeHtml(item.file_name)}">${escapeHtml(item.file_name)}</td><td title="${escapeHtml(item.new_name)}">${escapeHtml(item.new_name)}</td></tr>`
    )).join("");
    const warnings = [
      duplicates.length ? `<div class="qbr-warn">发现重复新文件名：${escapeHtml(duplicates.slice(0, 5).join("、"))}</div>` : "",
      failed.length ? `<div class="qbr-warn">${escapeHtml(failed.slice(0, 5).join("\n"))}</div>` : "",
    ].join("");
    el.innerHTML = `${warnings}<table><thead><tr><th>原文件名</th><th>新文件名</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    }[ch]));
  }

  function clampPanelTop(panel, top) {
    const margin = 12;
    const rect = panel.getBoundingClientRect();
    const height = panel.classList.contains("qbr-collapsed") ? 44 : Math.min(rect.height || 44, window.innerHeight - margin * 2);
    const minTop = Math.min(MIN_PANEL_TOP, Math.max(margin, window.innerHeight - height - margin));
    return Math.min(Math.max(top, minTop), Math.max(margin, window.innerHeight - height - margin));
  }

  function setPanelTop(panel, top, shouldSave = false) {
    const nextTop = clampPanelTop(panel, top);
    panel.style.top = `${Math.round(nextTop)}px`;
    if (shouldSave) localStorage.setItem(PANEL_TOP_KEY, String(Math.round(nextTop)));
  }

  function restorePanelTop(panel) {
    const saved = Number(localStorage.getItem(PANEL_TOP_KEY));
    setPanelTop(panel, Number.isFinite(saved) ? saved : DEFAULT_PANEL_TOP);
  }

  function keepPanelInViewport(panel) {
    setPanelTop(panel, panel.getBoundingClientRect().top, panel.classList.contains("qbr-collapsed"));
  }

  function bindPanelDrag(panel) {
    const toggle = panel.querySelector(".qbr-toggle");
    let drag = null;

    const startDrag = (clientY) => {
      drag = {
        startY: clientY,
        startTop: panel.getBoundingClientRect().top,
        moved: false,
      };
      panel.classList.add("qbr-dragging");
    };

    const moveDrag = (clientY, event) => {
      if (!drag) return;
      const deltaY = clientY - drag.startY;
      if (Math.abs(deltaY) > 3) drag.moved = true;
      if (drag.moved) {
        event.preventDefault();
        setPanelTop(panel, drag.startTop + deltaY);
      }
    };

    const finishDrag = () => {
      if (!drag) return;
      panel.classList.remove("qbr-dragging");
      if (drag.moved) {
        panel.dataset.dragged = "1";
        setPanelTop(panel, panel.getBoundingClientRect().top, true);
        setTimeout(() => {
          delete panel.dataset.dragged;
        }, 150);
      }
      drag = null;
    };

    toggle.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      startDrag(event.clientY);
    });
    document.addEventListener("mousemove", (event) => moveDrag(event.clientY, event));
    document.addEventListener("mouseup", finishDrag);

    toggle.addEventListener("touchstart", (event) => {
      if (!event.touches.length) return;
      startDrag(event.touches[0].clientY);
    }, { passive: true });
    document.addEventListener("touchmove", (event) => {
      if (!event.touches.length) return;
      moveDrag(event.touches[0].clientY, event);
    }, { passive: false });
    document.addEventListener("touchend", finishDrag);
    document.addEventListener("touchcancel", finishDrag);
  }

  function injectStyle() {
    const style = document.createElement("style");
    style.textContent = `
      #${PANEL_ID} {
        position: fixed;
        right: 18px;
        top: 168px;
        z-index: 2147483000;
        width: 376px;
        max-height: calc(100vh - 120px);
        overflow: auto;
        box-sizing: border-box;
        border: 1px solid rgba(210, 216, 230, .95);
        border-radius: 12px;
        background: #fff;
        box-shadow: 0 18px 42px rgba(22, 28, 45, .16);
        color: #1f2430;
        font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #${PANEL_ID} * { box-sizing: border-box; }
      #${PANEL_ID}.qbr-collapsed {
        width: 44px;
        min-height: 44px;
        overflow: visible;
        border-radius: 999px;
        border-color: rgba(221, 226, 238, .9);
        box-shadow: 0 10px 24px rgba(22, 28, 45, .18);
      }
      #${PANEL_ID}.qbr-collapsed .qbr-body { display: none; }
      #${PANEL_ID}.qbr-collapsed .qbr-heading { display: none; }
      #${PANEL_ID} .qbr-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 10px 12px;
        border-bottom: 1px solid #edf0f6;
        background: #fbfcff;
      }
      #${PANEL_ID}.qbr-collapsed .qbr-head {
        padding: 0;
        border-bottom: 0;
        background: transparent;
      }
      #${PANEL_ID} .qbr-heading {
        display: flex;
        align-items: center;
        gap: 9px;
        min-width: 0;
        color: #1f2430;
        font-size: 14px;
        font-weight: 700;
      }
      #${PANEL_ID} .qbr-toggle {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 34px;
        height: 34px;
        padding: 0;
        border-radius: 8px;
      }
      #${PANEL_ID}.qbr-collapsed .qbr-toggle {
        width: 44px;
        height: 44px;
        border: 0;
        border-radius: 999px;
        cursor: grab;
        touch-action: none;
        user-select: none;
      }
      #${PANEL_ID}.qbr-dragging .qbr-toggle { cursor: grabbing; }
      #${PANEL_ID} .qbr-icon {
        width: 24px;
        height: 24px;
        border-radius: 6px;
        flex: 0 0 auto;
      }
      #${PANEL_ID}.qbr-collapsed .qbr-icon { width: 26px; height: 26px; border-radius: 999px; }
      #${PANEL_ID} .qbr-close { font-size: 18px; line-height: 1; color: #687084; }
      #${PANEL_ID}.qbr-collapsed .qbr-close { display: none; }
      #${PANEL_ID}.qbr-collapsed .qbr-toggle .qbr-icon { display: block; }
      #${PANEL_ID} .qbr-toggle .qbr-icon { display: none; }
      #${PANEL_ID} .qbr-body { padding: 14px; }
      #${PANEL_ID} label {
        display: block;
        margin: 10px 0 5px;
        color: #4b5568;
        font-size: 12px;
        font-weight: 650;
      }
      #${PANEL_ID} input, #${PANEL_ID} select {
        width: 100%;
        height: 34px;
        border: 1px solid #d3d9e6;
        border-radius: 8px;
        background: #fff;
        color: #1f2430;
        padding: 0 10px;
        outline: none;
      }
      #${PANEL_ID} input:focus, #${PANEL_ID} select:focus {
        border-color: #3b6dff;
        box-shadow: 0 0 0 3px rgba(59, 109, 255, .12);
      }
      #${PANEL_ID} input::placeholder { color: #9aa3b4; }
      #${PANEL_ID} .qbr-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      #${PANEL_ID} .qbr-actions {
        display: grid;
        grid-template-columns: 1fr 1fr 1.1fr;
        gap: 8px;
        margin-top: 14px;
      }
      #${PANEL_ID} button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 0;
        height: 34px;
        border: 1px solid #d3d9e6;
        border-radius: 8px;
        background: #fff;
        color: #1f2430;
        cursor: pointer;
        font: inherit;
        font-weight: 650;
        line-height: 1;
        text-align: center;
        white-space: nowrap;
        transition: background .12s ease, border-color .12s ease, box-shadow .12s ease, transform .12s ease;
      }
      #${PANEL_ID} button:hover { background: #f6f8fc; border-color: #bfc7d8; }
      #${PANEL_ID} button:active { transform: translateY(1px); }
      #${PANEL_ID} button:disabled { cursor: not-allowed; opacity: .62; transform: none; }
      #${PANEL_ID} button.qbr-primary { background: #245bff; border-color: #245bff; color: #fff; box-shadow: 0 6px 14px rgba(36, 91, 255, .22); }
      #${PANEL_ID} button.qbr-primary:hover { background: #174deb; border-color: #174deb; }
      #${PANEL_ID} .qbr-status {
        margin-top: 12px;
        padding: 9px 10px;
        border-radius: 8px;
        background: #f6f8fc;
        color: #566074;
        white-space: pre-wrap;
      }
      #${PANEL_ID} .qbr-preview {
        margin-top: 12px;
        max-height: 260px;
        overflow: auto;
        border: 1px solid #edf0f6;
        border-radius: 8px;
      }
      #${PANEL_ID} .qbr-preview:empty { display: none; }
      #${PANEL_ID} table { width: 100%; border-collapse: collapse; table-layout: fixed; background: #fff; }
      #${PANEL_ID} th, #${PANEL_ID} td { padding: 8px 8px; border-bottom: 1px solid #f0f2f7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #${PANEL_ID} th { background: #f8faff; color: #5a6272; font-weight: 700; text-align: left; }
      #${PANEL_ID} tbody tr:last-child td { border-bottom: 0; }
      #${PANEL_ID} .qbr-warn { margin: 8px; color: #b45309; white-space: pre-wrap; }
    `;
    document.head.appendChild(style);
  }

  function mountPanel() {
    if (document.getElementById(PANEL_ID)) return;
    injectStyle();
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.className = "qbr-collapsed";
    panel.innerHTML = `
      <div class="qbr-head">
        <div class="qbr-heading">
          <img class="qbr-icon" src="${ROBOT_ICON}" alt="" />
          <span>批量重命名</span>
        </div>
        <button type="button" class="qbr-toggle" data-keep-enabled="1" title="打开/收起批量重命名">
          <img class="qbr-icon" src="${ROBOT_ICON}" alt="" />
          <span class="qbr-close">×</span>
        </button>
      </div>
      <div class="qbr-body">
        <label>文件来源</label>
        <select name="source">
          <option value="auto">自动：全选时取当前目录，否则取已勾选可见文件</option>
          <option value="selected">只取已勾选可见文件</option>
          <option value="folder">当前目录全部视频文件</option>
        </select>
        <label>操作</label>
        <select name="operation">
          <option value="prefix">添加前缀</option>
          <option value="regex">正则替换</option>
          <option value="removeEnglish">删除英文剧名</option>
          <option value="cnEpisode">中文集数转 SxxExx</option>
          <option value="episode">整理为 剧名.SxxExx</option>
        </select>
        <label>前缀</label>
        <input name="prefix" value="" placeholder="示例：雨霖铃" />
        <div class="qbr-grid">
          <div>
            <label>From 正则</label>
            <input name="regexFrom" value="" placeholder="示例：^" />
          </div>
          <div>
            <label>To 替换</label>
            <input name="regexTo" value="" placeholder="示例：雨霖铃" />
          </div>
        </div>
        <label>季号</label>
        <input name="season" value="" placeholder="示例：1" />
        <label>剧名</label>
        <input name="showName" value="" placeholder="示例：仁心俱乐部" />
        <div class="qbr-actions">
          <button type="button" class="qbr-load">读取</button>
          <button type="button" class="qbr-preview-btn">预览</button>
          <button type="button" class="qbr-primary qbr-run">执行</button>
        </div>
        <div class="qbr-status">准备就绪</div>
        <div class="qbr-preview"></div>
      </div>
    `;
    document.body.appendChild(panel);
    restorePanelTop(panel);
    bindPanelDrag(panel);
    window.addEventListener("resize", () => keepPanelInViewport(panel));
    panel.querySelector(".qbr-toggle").addEventListener("click", (event) => {
      if (panel.dataset.dragged === "1") {
        event.preventDefault();
        event.stopPropagation();
        delete panel.dataset.dragged;
        return;
      }
      panel.classList.toggle("qbr-collapsed");
      requestAnimationFrame(() => keepPanelInViewport(panel));
    });
    panel.querySelector(".qbr-load").addEventListener("click", () => loadFiles().catch((error) => renderStatus(error.message)));
    panel.querySelector(".qbr-preview-btn").addEventListener("click", async () => {
      try {
        if (!state.files.length) await loadFiles();
        buildPreview();
      } catch (error) {
        renderStatus(error.message);
      }
    });
    panel.querySelector(".qbr-run").addEventListener("click", () => runRename().catch((error) => renderStatus(error.message)));
  }

  function boot() {
    mountPanel();
    const observer = new MutationObserver(() => {
      if (!document.getElementById(PANEL_ID)) mountPanel();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
