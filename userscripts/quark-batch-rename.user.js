// ==UserScript==
// @name         夸克网盘文件工具箱
// @namespace    https://local.travisoa.com/userscripts
// @version      0.5.9
// @description  批量重命名、云解压、删除已完成压缩包，以及归集子目录视频。
// @author       Codex
// @match        https://pan.quark.cn/*
// @icon         https://raw.githubusercontent.com/travisoa/scriptbox/main/userscripts/assets/quark-file-toolbox.png
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
  const PANEL_POS_KEY = "codex-quark-batch-rename-pos";
  const PANEL_LEGACY_TOP_KEY = "codex-quark-batch-rename-top";
  const FORM_KEY = "codex-quark-batch-rename-form";
  const TOOLS_CONFIG_KEY = "codex-quark-file-tools-config-v1";
  const FORM_FIELDS = ["source", "operation", "prefix", "regexFrom", "regexTo", "season", "showName"];
  const PANEL_MARGIN = 12;
  const DEFAULT_BOTTOM_OFFSET = 96;
  const COLLAPSED_SIZE = 44;
  const ICON_SVG = `<img src="https://raw.githubusercontent.com/travisoa/scriptbox/main/userscripts/assets/flower.svg" alt="" style="width:100%;height:100%;display:block;pointer-events:none" />`;
  const VIDEO_EXT_RE = /\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|ts|m2ts|rmvb)$/i;
  const DEFAULT_TOOLS_CONFIG = {
    destinationPath: "",
    archivePattern: "\\.(zip|rar|7z)$",
    extraSkip: "",
    skipExisting: true,
    deleteArchiveAfterComplete: false,
    deleteEmptyFolders: false,
  };
  const MAX_SCAN_FOLDERS = 1000;
  const MOVE_BATCH_SIZE = 50;
  const UNZIP_COMPLETION_TIMEOUT_MS = 2 * 60 * 60 * 1000;

  const state = {
    files: [],
    preview: [],
    duplicates: [],
    busy: false,
    stopRequested: false,
    submitted: [],
    skipped: [],
    failed: [],
    deletedArchives: [],
    movePlan: null,
    moved: [],
    deletedFolders: [],
  };

  class StopRequestedError extends Error {
    constructor() {
      super("用户已请求停止");
      this.name = "StopRequestedError";
    }
  }

  const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const archiveBaseName = (name) => name.replace(/\.(zip|rar|7z)$/i, "");

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function currentFolderFid() {
    const parts = String(location.hash || "").split("/").filter(Boolean);
    const last = parts[parts.length - 1] || "";
    if (!last || last === "all" || last === "root") return "0";
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

  function currentFolderDestination(sourceFolderFid) {
    const hash = String(location.hash || "");
    if (!/^#?\/list\/all(?:\/|$)/.test(hash)) {
      throw new Error("无法从当前页面确认源目录完整路径，禁止提交");
    }
    const parts = hash.replace(/^#?\/list\/all\/?/, "").split("/").filter(Boolean);
    const segments = parts.map((part) => {
      const match = part.match(/^([a-f0-9]{32})-(.+)$/i);
      if (!match) throw new Error("当前目录路由缺少完整名称，禁止提交");
      return decodeURIComponent(match[2]);
    });
    if (currentFolderFid() !== String(sourceFolderFid)) {
      throw new Error("当前文件夹已切换；为避免操作错误目录，已停止批次");
    }
    return segments;
  }

  function destinationMatches(label, segments) {
    const actual = normalizeDestinationPath(label);
    return actual.length === segments.length &&
      actual.every((segment, index) => normalizeText(segment) === normalizeText(segments[index]));
  }

  function destinationMatchesAfterSelection(label, segments, confirmedSegments) {
    if (destinationMatches(label, segments)) return true;
    // 省略标签只用于核对本次目录树选择的展示，不用于推断目标目录。
    if (!Array.isArray(confirmedSegments) || confirmedSegments.length !== segments.length ||
      !confirmedSegments.every((segment, index) => normalizeText(segment) === normalizeText(segments[index]))) return false;
    const actual = normalizeDestinationPath(label);
    const omittedIndexes = actual.map((segment, index) => /^(?:\.\.\.|…)$/u.test(segment) ? index : -1)
      .filter((index) => index >= 0);
    if (omittedIndexes.length !== 1) return false;
    const omittedIndex = omittedIndexes[0];
    // 末级名称必须明确，省略段至少代表一个目录。
    if (omittedIndex === actual.length - 1 || actual.length > segments.length) return false;
    const prefix = actual.slice(0, omittedIndex);
    const suffix = actual.slice(omittedIndex + 1);
    return prefix.every((segment, index) => normalizeText(segment) === normalizeText(segments[index])) &&
      suffix.every((segment, index) => normalizeText(segment) === normalizeText(segments[segments.length - suffix.length + index]));
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
    const total = data.total ?? data._total ?? data.metadata?._total ?? data.metadata?.total ?? list.length;
    return { list, total: Number(total) || 0 };
  }

  function normalizeDriveItem(item, parentFid) {
    return {
      fid: String(item.fid || item.file_id || item.id || ""),
      file_name: item.file_name || item.name || item.title || "",
      file_type: item.file_type,
      category: item.category,
      parent_fid: String(item.pdir_fid || item.parent_fid || parentFid || "0"),
    };
  }

  function isFolderItem(item) {
    return String(item.file_type) === "0";
  }

  async function listFolderItems(pdirFid, { allowStop = true } = {}) {
    const out = [];
    let page = 1;
    let total = Infinity;
    while (out.length < total) {
      if (allowStop && state.stopRequested) throw new StopRequestedError();
      const query = new URLSearchParams({
        pdir_fid: String(pdirFid),
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
      total = payload.total || out.length + payload.list.length;
      out.push(...payload.list.map((item) => normalizeDriveItem(item, pdirFid))
        .filter((item) => item.fid && item.file_name));
      if (!payload.list.length || payload.list.length < 200) break;
      page += 1;
    }
    return out;
  }

  async function listCurrentFolderFiles() {
    return listFolderItems(currentFolderFid(), { allowStop: false });
  }

  async function scanNestedVideos(log) {
    const rootFid = currentFolderFid();
    const rootItems = await listFolderItems(rootFid);
    const reservedNames = new Set(
      rootItems.filter((item) => !isFolderItem(item)).map((item) => item.file_name.toLocaleLowerCase()),
    );
    const queue = [];
    const visited = new Set();
    const folders = [];
    const candidates = [];
    const conflicts = [];

    const enqueueFolder = (item, parentPath, depth, parentFid) => {
      if (visited.has(item.fid)) return;
      visited.add(item.fid);
      queue.push({
        fid: item.fid,
        file_name: item.file_name,
        path: `${parentPath}/${item.file_name}`,
        depth,
        parentFid,
      });
    };

    for (const item of rootItems.filter(isFolderItem)) enqueueFolder(item, "", 1, rootFid);

    while (queue.length) {
      if (state.stopRequested) throw new StopRequestedError();
      if (folders.length >= MAX_SCAN_FOLDERS) {
        throw new Error(`子目录超过 ${MAX_SCAN_FOLDERS} 个，已停止扫描以避免范围失控`);
      }
      const folder = queue.shift();
      folders.push(folder);
      const items = await listFolderItems(folder.fid);
      for (const item of items) {
        if (isFolderItem(item)) {
          enqueueFolder(item, folder.path, folder.depth + 1, folder.fid);
          continue;
        }
        if (!VIDEO_EXT_RE.test(item.file_name)) continue;
        const nameKey = item.file_name.toLocaleLowerCase();
        const video = {
          fid: item.fid,
          file_name: item.file_name,
          sourceFid: folder.fid,
          sourcePath: folder.path,
        };
        if (reservedNames.has(nameKey)) conflicts.push(video);
        else {
          reservedNames.add(nameKey);
          candidates.push(video);
        }
      }
      if (folders.length % 10 === 0) log(`已扫描 ${folders.length} 个子目录，发现 ${candidates.length} 个可移动视频`);
    }
    return { rootFid, folders, candidates, conflicts };
  }

  async function moveFileBatch(files, targetFid) {
    return quarkJson("/1/clouddrive/file/move", {
      method: "POST",
      body: JSON.stringify({
        action_type: 1,
        filelist: files.map((file) => file.fid),
        to_pdir_fid: String(targetFid),
      }),
    });
  }

  async function deleteDriveItems(fids) {
    return quarkJson("/1/clouddrive/file/delete", {
      method: "POST",
      body: JSON.stringify({ action_type: 2, filelist: fids.map(String), exclude_fids: [] }),
    });
  }

  async function waitUntilItemsMissing(parentFid, fids, label, timeout = 30000) {
    const expected = new Set(fids.map(String));
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const items = await listFolderItems(parentFid, { allowStop: false });
      if (!items.some((item) => expected.has(item.fid))) return;
      await sleep(900);
    }
    throw new Error(`${label}超时；为安全起见未继续删除目录`);
  }

  async function executeMovePlan(plan, shouldDeleteEmpty, log, setStatus) {
    const grouped = new Map();
    for (const video of plan.candidates) {
      if (!grouped.has(video.sourceFid)) grouped.set(video.sourceFid, []);
      grouped.get(video.sourceFid).push(video);
    }

    state.moved = [];
    state.deletedFolders = [];
    for (const [sourceFid, videos] of grouped) {
      for (let index = 0; index < videos.length; index += MOVE_BATCH_SIZE) {
        if (state.stopRequested) throw new StopRequestedError();
        const batch = videos.slice(index, index + MOVE_BATCH_SIZE);
        setStatus(`正在移动 ${state.moved.length + 1}-${state.moved.length + batch.length}/${plan.candidates.length}`);
        await moveFileBatch(batch, plan.rootFid);
        await waitUntilItemsMissing(sourceFid, batch.map((video) => video.fid), `确认视频移出 ${batch[0].sourcePath}`);
        state.moved.push(...batch);
        log(`已移动 ${batch.length} 个视频：${batch[0].sourcePath} → 当前目录`);
      }
    }

    if (!shouldDeleteEmpty) return;
    const folderByFid = new Map(plan.folders.map((folder) => [folder.fid, folder]));
    const cleanupFolderFids = new Set();
    for (const video of state.moved) {
      let folder = folderByFid.get(video.sourceFid);
      while (folder && !cleanupFolderFids.has(folder.fid)) {
        cleanupFolderFids.add(folder.fid);
        folder = folderByFid.get(folder.parentFid);
      }
    }
    const foldersDeepFirst = plan.folders
      .filter((folder) => cleanupFolderFids.has(folder.fid))
      .sort((a, b) => b.depth - a.depth);
    for (let index = 0; index < foldersDeepFirst.length; index += 1) {
      if (state.stopRequested) throw new StopRequestedError();
      const folder = foldersDeepFirst[index];
      setStatus(`检查空文件夹 ${index + 1}/${foldersDeepFirst.length}：${folder.path}`);
      const remaining = await listFolderItems(folder.fid);
      if (remaining.length) {
        log(`保留非空文件夹 ${folder.path}（剩余 ${remaining.length} 项）`);
        continue;
      }
      await deleteDriveItems([folder.fid]);
      await waitUntilItemsMissing(folder.parentFid, [folder.fid], `确认删除空文件夹 ${folder.path}`);
      state.deletedFolders.push(folder);
      log(`已删除空文件夹 ${folder.path}`);
    }
  }

  function isVisible(element) {
    if (!(element instanceof HTMLElement)) return false;
    // 夸克预置的封禁提示仍有尺寸，但祖先 opacity 为 0；不能当成真实报错。
    for (let current = element; current instanceof HTMLElement; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (current.hidden || current.getAttribute("aria-hidden") === "true" ||
        style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" ||
        (style.opacity !== "" && Number(style.opacity) === 0)) return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  async function waitFor(getter, label, timeout = 15000, interval = 250, archiveName = "") {
    const deadline = Date.now() + timeout;
    let lastError;
    while (Date.now() < deadline) {
      if (state.stopRequested) throw new StopRequestedError();
      throwIfUnzipBlocked(archiveName);
      try {
        const value = getter();
        if (value) return value;
      } catch (error) {
        if (error instanceof UnzipPageError) throw error;
        lastError = error;
      }
      await sleep(interval);
    }
    throw new Error(`${label}超时${lastError ? `：${lastError.message}` : ""}`);
  }

  function findExactText(root, text, selector = "*") {
    return [...root.querySelectorAll(selector)]
      .filter((element) => isVisible(element) && normalizeText(element.textContent) === text)
      .sort((a, b) => a.children.length - b.children.length)[0] || null;
  }

  function findButton(root, text) {
    return [...root.querySelectorAll("button")].find(
      (button) => isVisible(button) && normalizeText(button.textContent) === text,
    ) || null;
  }

  function visibleUnzipText(root) {
    const panels = ["codex-quark-batch-rename", "codex-quark-cloud-unzip"]
      .map((id) => document.getElementById(id)).filter(Boolean);
    const texts = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (!panels.some((panel) => panel.contains(node)) && node.parentElement && isVisible(node.parentElement)) {
        texts.push(node.nodeValue);
      }
      node = walker.nextNode();
    }
    return normalizeText(texts.join(""));
  }

  class UnzipPageError extends Error {
    constructor(message) {
      super(message);
      this.name = "UnzipPageError";
    }
  }

  function readUnzipPageError(text) {
    return normalizeText(text).match(
      /(账号涉嫌违规已被封禁|账号[^。！？]{0,30}(?:被封禁|已封禁|被冻结|被禁用)|暂时无法使用该功能|解压失败|压缩包损坏|需要密码|密码错误|权限不足|无权限|访问被拒绝|未登录|登录已失效|登录过期|请先登录|会员[^。！？]{0,30}(?:限制|不足)|空间不足|容量不足|操作太频繁|请求过于频繁)/,
    )?.[0] || "";
  }

  const UNZIP_NOTICE_SELECTOR = '.ant-message-notice-content, .ant-notification-notice, [role="alert"], [role="status"], [class*="MessageUserLimit--message-wrap"]';

  function archiveNameMatcher(archiveName) {
    const escaped = archiveName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\p{L}\\p{N}_.-])${escaped}(?![A-Za-z0-9_.-])`, "u");
  }

  function readUnzipMessageError(text, archiveName, allowGeneric) {
    const mentionsArchive = archiveName && archiveNameMatcher(archiveName).test(text);
    const remaining = mentionsArchive ? text.replace(archiveNameMatcher(archiveName), "") : text;
    if (/\.(zip|rar|7z)(?![A-Za-z0-9_.-])/i.test(remaining)) return "";
    if (!mentionsArchive && !allowGeneric) return "";
    // 文件名里的“解压失败”等字样不属于任务状态。
    return readUnzipPageError(mentionsArchive ? text.replaceAll(archiveName, "") : text);
  }

  function throwIfUnzipBlocked(archiveName = "") {
    const candidates = [...document.querySelectorAll(UNZIP_NOTICE_SELECTOR)];
    if (archiveName) {
      candidates.push(...[...document.querySelectorAll('[role="dialog"]')]
        .filter((dialog) => isVisible(dialog) && archiveNameMatcher(archiveName).test(visibleUnzipText(dialog))));
    }
    for (const element of candidates) {
      if (!isVisible(element)) continue;
      const message = readUnzipMessageError(visibleUnzipText(element), archiveName, element.matches(UNZIP_NOTICE_SELECTOR));
      if (message) throw new UnzipPageError(`页面提示：${message}；源压缩包已保留`);
    }
  }

  function ensureUnzipSafe(sourceFolderFid, archiveName = "") {
    if (state.stopRequested) throw new StopRequestedError();
    if (currentFolderFid() !== String(sourceFolderFid)) {
      throw new Error("当前文件夹已切换；为避免操作错误目录，已停止批次");
    }
    throwIfUnzipBlocked(archiveName);
  }

  function clickElement(element) {
    if (!element) throw new Error("点击目标不存在");
    element.scrollIntoView({ block: "center", inline: "nearest" });
    element.click();
  }

  function doubleClickElement(element) {
    if (!element) throw new Error("双击目标不存在");
    element.scrollIntoView({ block: "center", inline: "nearest" });
    const eventInit = { bubbles: true, cancelable: true, button: 0 };
    for (const type of ["mousedown", "mouseup", "click", "mousedown", "mouseup", "click", "dblclick"]) {
      element.dispatchEvent(new MouseEvent(type, eventInit));
    }
  }

  function matchingArchiveTextNode(root, pattern, expectedName = "") {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const text = normalizeText(node.nodeValue);
      const parent = node.parentElement;
      if (parent && isVisible(parent)) {
        if (expectedName ? text === expectedName : pattern.test(text)) return node;
        pattern.lastIndex = 0;
      }
      node = walker.nextNode();
    }
    return null;
  }

  function findArchiveDialog(archiveName) {
    return [...document.querySelectorAll('[role="dialog"]')].find((dialog) => {
      const text = normalizeText(dialog.textContent);
      return isVisible(dialog) && text.includes(archiveName) && text.includes("解压全部文件");
    }) || null;
  }

  function findDestinationDialog() {
    return [...document.querySelectorAll('[role="dialog"]')].find((dialog) => {
      const text = normalizeText(dialog.textContent);
      return isVisible(dialog) && text.includes("解压到") && text.includes("新建文件夹") && text.includes("确认");
    }) || null;
  }

  function readArchiveTargetLabel(dialog) {
    const candidates = [...dialog.querySelectorAll("div, span, p")]
      .filter((element) => isVisible(element))
      .map((element) => normalizeText(element.textContent))
      .filter((text) => text.includes("解压到") && text.includes("更改") && text.length < 300)
      .sort((a, b) => a.length - b.length);
    const text = candidates[0] || normalizeText(dialog.textContent);
    return normalizeText(text.match(/解压到[：:\s]*([\s\S]*?)\s*更改/)?.[1]);
  }

  function closeDialog(dialog) {
    const close = dialog?.querySelector('button[aria-label="Close"], button.ant-modal-close');
    if (close) clickElement(close);
  }

  async function listArchiveNames(pattern, sourceFolderFid = currentFolderFid()) {
    // 文件列表是虚拟渲染，DOM 只包含部分行；通过现有目录接口获取完整批次。
    const items = await listFolderItems(sourceFolderFid);
    ensureUnzipSafe(sourceFolderFid);
    return items.filter((item) => {
      pattern.lastIndex = 0;
      return !isFolderItem(item) && pattern.test(item.file_name);
    }).map((item) => item.file_name)
      .sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
  }

  function findArchiveNameElement(archiveName) {
    const titled = [...document.querySelectorAll("tr [title]")].find(
      (element) => !element.closest('[role="dialog"]') && isVisible(element) && normalizeText(element.getAttribute("title")) === archiveName,
    );
    if (titled) return titled;
    for (const row of document.querySelectorAll("tr")) {
      if (!isVisible(row) || row.closest('[role="dialog"]')) continue;
      const cells = [...row.querySelectorAll(":scope > td, :scope > [role='cell']")];
      const textNode = matchingArchiveTextNode(cells[1] || row, /$^/, archiveName);
      if (textNode?.parentElement) return textNode.parentElement;
    }
    return null;
  }

  async function locateArchiveNameElement(archiveName, sourceFolderFid, timeout = 15000) {
    ensureUnzipSafe(sourceFolderFid, archiveName);
    const current = findArchiveNameElement(archiveName);
    if (current) return current;
    const panels = ["codex-quark-batch-rename", "codex-quark-cloud-unzip"]
      .map((id) => document.getElementById(id)).filter(Boolean);
    const containers = [...document.querySelectorAll(".ant-table-body")].filter((element) =>
      isVisible(element) && !element.closest('[role="dialog"]') &&
      !panels.some((panel) => panel.contains(element)) && element.querySelector("tr") &&
      /^(auto|scroll)$/.test(getComputedStyle(element).overflowY) && element.clientHeight > 0);
    if (containers.length !== 1) {
      return waitFor(() => findArchiveNameElement(archiveName), `定位压缩包“${archiveName}”`, timeout, 250, archiveName);
    }
    const container = containers[0];
    const originalScrollTop = container.scrollTop;
    const deadline = Date.now() + timeout;
    let found = false;
    try {
      container.scrollTop = 0;
      while (Date.now() < deadline) {
        await sleep(150);
        ensureUnzipSafe(sourceFolderFid, archiveName);
        const element = findArchiveNameElement(archiveName);
        if (element) { found = true; return element; }
        const maximum = Math.max(0, container.scrollHeight - container.clientHeight);
        if (container.scrollTop >= maximum) break;
        container.scrollTop = Math.min(maximum, container.scrollTop + Math.max(1, container.clientHeight * 0.75));
      }
      throw new Error(`当前目录列表中未找到压缩包“${archiveName}”；已停止，禁止提交`);
    } finally {
      if (!found && currentFolderFid() === String(sourceFolderFid) && document.body.contains(container)) {
        container.scrollTop = originalScrollTop;
      }
    }
  }

  function treeItemTitle(item) {
    const title = item.querySelector(":scope > .ant-tree-node-content-wrapper .ant-tree-title");
    return title && isVisible(title) ? visibleUnzipText(title) : "";
  }

  function directTreeChildren(item) {
    const group = item.querySelector(":scope > ul[role='group'], :scope > ul.ant-tree-child-tree");
    return group ? [...group.children].filter((child) => child.matches("li[role='treeitem']")) : [];
  }

  function directChildByTitle(item, title) {
    return directTreeChildren(item).find((child) => isVisible(child) && treeItemTitle(child) === title) || null;
  }

  function isTreeItemExpanded(item) {
    return item.classList.contains("ant-tree-treenode-switcher-open") ||
      Boolean(item.querySelector(":scope > .ant-tree-switcher_open"));
  }

  async function expandTreeItem(item, expectedChild) {
    const existing = expectedChild ? directChildByTitle(item, expectedChild) : null;
    if (existing) return existing;
    if (!isTreeItemExpanded(item)) {
      const switcher = item.querySelector(":scope > .ant-tree-switcher");
      if (!switcher) throw new Error(`目录“${treeItemTitle(item)}”没有展开控件`);
      clickElement(switcher);
    }
    if (!expectedChild) {
      await waitFor(
        () => isTreeItemExpanded(item) && !item.classList.contains("ant-tree-treenode-loading"),
        `展开目录“${treeItemTitle(item)}”`,
        12000,
      ).catch(() => true);
      return null;
    }
    return waitFor(() => directChildByTitle(item, expectedChild), `加载目录“${expectedChild}”`, 15000);
  }

  function normalizeDestinationPath(path) {
    const segments = path.split("/").map((part) => part.trim()).filter(Boolean);
    if (segments[0] === "我的网盘") segments.shift();
    if (segments[0] === "全部文件") segments.shift();
    return segments;
  }

  async function locateDestination(dialog, destinationPath) {
    const segments = normalizeDestinationPath(destinationPath);
    // 原生选择框先显示按钮，目录树随后加载/淡入；等待可见根节点再定位。
    let current = await waitFor(() => {
      const tree = dialog.querySelector('[role="tree"]');
      if (!tree || !isVisible(tree)) return null;
      return [...tree.querySelectorAll(":scope > li[role='treeitem']")]
        .find((item) => isVisible(item) && treeItemTitle(item) === "全部文件");
    }, "加载目标目录树“全部文件”根节点", 15000);
    for (const segment of segments) current = await expandTreeItem(current, segment);
    return { item: current, segments };
  }

  function readTreeTargetSegments(dialog, item) {
    const tree = dialog?.querySelector('[role="tree"]');
    if (!tree || !isVisible(dialog) || !isVisible(tree) || !tree.contains(item) || !isVisible(item)) {
      throw new Error("目标目录不在当前可见目录树内，禁止提交");
    }
    const titles = [];
    let current = item;
    while (current && tree.contains(current)) {
      const content = current.querySelector(":scope > .ant-tree-node-content-wrapper");
      const titleNode = content?.querySelector(".ant-tree-title");
      const title = titleNode && isVisible(titleNode) ? visibleUnzipText(titleNode) : "";
      if (!content || !isVisible(current) || !isVisible(content) || !isVisible(titleNode) || !title) throw new Error("目标目录树路径不可见或名称缺失，禁止提交");
      titles.unshift(title);
      if (current.parentElement === tree) break;
      current = current.parentElement?.closest('li[role="treeitem"]');
    }
    if (!current || current.parentElement !== tree || titles[0] !== "全部文件") {
      throw new Error("目标目录树缺少完整根路径，禁止提交");
    }
    return titles.slice(1);
  }

  async function selectDestination(dialog, item, expectedSegments) {
    const validateSelection = () => {
      const actual = readTreeTargetSegments(dialog, item);
      if (!destinationMatches(`全部文件/${actual.join("/")}`, expectedSegments)) {
        throw new Error("目录树选中路径与预期不一致，禁止提交");
      }
      return actual;
    };
    validateSelection();
    const content = item.querySelector(":scope > .ant-tree-node-content-wrapper");
    if (!content) throw new Error("未找到最终目录名称");
    clickElement(content);
    await waitFor(() => item.classList.contains("ant-tree-treenode-selected"), `选择目录“${treeItemTitle(item)}”`);
    const confirmedSegments = validateSelection();
    const confirmButton = findButton(dialog, "确认");
    if (!confirmButton) throw new Error("未找到目录确认按钮");
    clickElement(confirmButton);
    await waitFor(() => !findDestinationDialog(), "关闭目标目录选择框");
    return confirmedSegments;
  }

  async function readExistingTargetFolders(targetItem) {
    await expandTreeItem(targetItem, null);
    await sleep(500);
    return new Set(directTreeChildren(targetItem).map(treeItemTitle).filter(Boolean));
  }

  async function cancelDestinationAndCloseArchive(destinationDialog, archiveDialog) {
    const cancel = findButton(destinationDialog, "取消");
    if (cancel) {
      clickElement(cancel);
      await waitFor(() => !findDestinationDialog(), "取消目录选择");
    }
    closeDialog(archiveDialog);
    await waitFor(
      () => !document.body.contains(archiveDialog) || !isVisible(archiveDialog),
      "关闭压缩包预览",
      5000,
    ).catch(() => true);
  }

  function nativeUnzipProgressElements() {
    const panels = ["codex-quark-batch-rename", "codex-quark-cloud-unzip"]
      .map((id) => document.getElementById(id)).filter(Boolean);
    return [...document.querySelectorAll(".decompressing")].filter((element) =>
      !element.closest('[role="dialog"]') && !panels.some((panel) => panel.contains(element)));
  }

  function nativeUnzipProgressText(element) {
    const tips = element?.querySelector(".progress-tips");
    return tips && isVisible(element) && isVisible(tips) ? visibleUnzipText(tips) : "";
  }

  function nativeUnzipProgressCompleted(element) {
    return /^文件解压成功\s*100%$/.test(nativeUnzipProgressText(element));
  }

  async function closeUnzipProgress(element, archiveName) {
    if (!element || !document.body.contains(element)) return;
    if (!nativeUnzipProgressCompleted(element)) throw new Error("原生解压进度尚未明确成功 100%，禁止关闭并继续批次");
    const close = element.querySelector(".decompressing-close");
    if (!close || !isVisible(close)) throw new Error("未找到本次原生解压进度的关闭入口");
    clickElement(close);
    await waitFor(() => !document.body.contains(element), `关闭“${archiveName}”已完成解压进度`, 5000, 250, archiveName);
  }

  async function prepareUnzipProgress(archiveName) {
    const previous = nativeUnzipProgressElements();
    if (previous.length > 1 || previous.some((element) => !nativeUnzipProgressCompleted(element))) {
      throw new Error("页面已有进行中、不可见或状态不明的解压进度；请核查后重试，源压缩包已保留");
    }
    for (const element of previous) await closeUnzipProgress(element, archiveName);
    if (nativeUnzipProgressElements().length) throw new Error("旧解压进度未移除，禁止提交下一项");
  }

  function watchUnzipTask(archiveName, { nativeProgressReady = false } = {}) {
    let acknowledged = false;
    let completed = false;
    let failure = "";
    let progressElement = null;
    const previousProgress = new Set(nativeUnzipProgressElements());
    if (nativeProgressReady && previousProgress.size) failure = "提交前出现了其他解压进度，无法确认本次任务已受理";
    const inspectNativeProgress = () => {
      if (!nativeProgressReady || failure) return;
      const current = nativeUnzipProgressElements();
      const fresh = current.filter((element) => !previousProgress.has(element));
      if (current.length > 1 || (progressElement && fresh.some((element) => element !== progressElement))) {
        failure = "出现多个或替换的原生解压进度，无法可靠关联本次任务";
        return;
      }
      if (!progressElement && fresh.length === 1 && isVisible(fresh[0])) progressElement = fresh[0];
      if (!progressElement) return;
      if (!completed && (!document.body.contains(progressElement) || !isVisible(progressElement))) {
        failure = "本次原生解压进度在确认完成前消失";
        return;
      }
      if (completed && document.body.contains(progressElement) && !nativeUnzipProgressCompleted(progressElement)) {
        failure = "本次已完成进度的状态发生变化，无法继续确认解压结果";
        return;
      }
      const text = nativeUnzipProgressText(progressElement);
      const error = readUnzipPageError(text);
      if (error) { failure = error; return; }
      if (nativeUnzipProgressCompleted(progressElement)) {
        acknowledged = true;
        completed = true;
      } else if (/(正在解压|解压中|开始解压|解压文件)/.test(text) && !/(未解压|尚未|等待|未完成)/.test(text)) {
        acknowledged = true;
      }
    };
    const archiveNamePattern = archiveNameMatcher(archiveName);
    const completionPattern = /(解压已完成|解压成功|已完成解压|云解压完成|解压完成)/;
    const pendingPattern = /(等待.*解压完成|正在解压|解压中|未完成|尚未|没有完成|未解压|解压未完成)/;
    const submissionPattern = /(已加入.{0,12}(解压|任务)|解压任务.{0,12}(已提交|提交成功|创建成功))/;
    const acknowledgementPattern = /(已加入.{0,12}(解压|任务)|解压任务.{0,12}(已提交|提交成功|创建成功)|正在解压|解压中|开始解压|解压成功|解压已完成|解压完成)/;
    const visibleText = visibleUnzipText;
    // 旧成功消息即使被重新插入，也不能证明本次任务已经完成。
    const panels = ["codex-quark-batch-rename", "codex-quark-cloud-unzip"]
      .map((id) => document.getElementById(id)).filter(Boolean);
    const previousTexts = new Set([...document.querySelectorAll("div, span, p, li, tr")]
      .filter((element) => isVisible(element) &&
        !panels.some((panel) => panel.contains(element) || element.contains(panel)))
      .map(visibleText));
    // 没有任务 ID 时，旧的同名完成记录与本次完成无法可靠区分，保留源文件。
    const hadPreviousCompletion = [...previousTexts].some((text) => text.length <= 500 &&
      archiveNamePattern.test(text) && completionPattern.test(text) && !pendingPattern.test(text));
    const inspectText = (value, statusChanged, isNotice) => {
      const text = normalizeText(value);
      if (!text || text.length > 500) return;
      if (!statusChanged || (previousTexts.has(text) && !submissionPattern.test(text))) return;
      const error = readUnzipMessageError(text, archiveName, isNotice);
      if (error) {
        failure = error;
        return;
      }
      if (hadPreviousCompletion && completionPattern.test(text) && !pendingPattern.test(text)) return;
      const mentionsArchive = archiveNamePattern.test(text);
      // 不把包含多条压缩包任务的祖先文本当成本条任务的完成证据。
      const hasOtherArchive = /\.(zip|rar|7z)(?![A-Za-z0-9_.-])/i.test(text.replace(archiveNamePattern, ""));
      if (hasOtherArchive) return;
      if (mentionsArchive && !pendingPattern.test(text) && completionPattern.test(text)) {
        if (!nativeProgressReady) completed = true;
        acknowledged = true;
      } else if ((mentionsArchive ? acknowledgementPattern : submissionPattern).test(text) &&
        !/(未提交|提交失败|未加入|尚未|等待.*解压完成)/.test(text)) {
        acknowledged = true;
      }
    };
    const observer = new MutationObserver((records) => {
      inspectNativeProgress();
      const currentPanels = ["codex-quark-batch-rename", "codex-quark-cloud-unzip"]
        .map((id) => document.getElementById(id)).filter(Boolean);
      const inspectNodeContext = (node) => {
        const changedText = node?.nodeType === Node.TEXT_NODE ? normalizeText(node.nodeValue) :
          (node instanceof HTMLElement ? visibleText(node) : "");
        const statusChanged = acknowledgementPattern.test(changedText) || submissionPattern.test(changedText) || Boolean(readUnzipPageError(changedText));
        let current = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
        for (let depth = 0; current && depth < 4; depth += 1) {
          if (current === document.body || currentPanels.some((panel) => panel.contains(current) || current.contains(panel))) return;
          if (isVisible(current)) inspectText(visibleText(current), statusChanged, Boolean(current.closest(UNZIP_NOTICE_SELECTOR)));
          current = current.parentElement;
        }
      };
      for (const record of records) {
        if (record.type === "characterData" || record.type === "attributes") inspectNodeContext(record.target);
        else for (const node of record.addedNodes) inspectNodeContext(node);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "style", "hidden", "aria-hidden"] });

    const checkErrors = () => {
      if (state.stopRequested) throw new StopRequestedError();
      inspectNativeProgress();
      if (failure) throw new UnzipPageError(`页面提示：${failure}；源压缩包已保留`);
      throwIfUnzipBlocked(archiveName);
    };
    const waitForOutcome = async (isDone, timeout, timeoutMessage) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        checkErrors();
        if (isDone()) return;
        await sleep(250);
      }
      throw new Error(timeoutMessage);
    };
    return {
      checkErrors,
      progressElement() { return progressElement; },
      waitForAcknowledgement(timeout = 20000) {
        return waitForOutcome(() => acknowledged, timeout, "页面未明确确认解压任务已受理；源压缩包已保留，请核查任务列表后再重试");
      },
      wait(timeout = UNZIP_COMPLETION_TIMEOUT_MS) {
        if (hadPreviousCompletion && !nativeProgressReady) {
          return Promise.reject(new Error("页面已有同名压缩包的旧完成记录，无法可靠确认本次任务；源压缩包已保留，请核查任务列表"));
        }
        return waitForOutcome(() => completed, timeout, "等待页面确认解压完成超时；源压缩包已保留");
      },
      cancel() { observer.disconnect(); },
    };
  }

  async function dismissArchivePreview(dialog, archiveName) {
    if (!document.body.contains(dialog) || !isVisible(dialog)) return;
    closeDialog(dialog);
    await waitFor(() => !document.body.contains(dialog) || !isVisible(dialog),
      `关闭压缩包“${archiveName}”预览`, 5000, 250, archiveName);
  }

  async function findSourceArchive(archiveName, sourceFolderFid) {
    const items = await listFolderItems(sourceFolderFid, { allowStop: false });
    return items.find((item) => !isFolderItem(item) && item.file_name === archiveName) || null;
  }

  async function deleteCompletedArchive(archiveName, archiveFid, sourceFolderFid, log, checkTaskErrors = () => {}) {
    ensureUnzipSafe(sourceFolderFid, archiveName);
    const archive = await findSourceArchive(archiveName, sourceFolderFid);
    ensureUnzipSafe(sourceFolderFid, archiveName);
    checkTaskErrors();
    if (!archive) {
      log(`解压已完成，但源压缩包 ${archiveName} 已不存在，无需删除`);
      return false;
    }
    if (archive.fid !== archiveFid) throw new Error(`解压已完成，但 ${archiveName} 的文件 ID 已变化；为安全起见未删除`);
    await deleteDriveItems([archive.fid]);
    await waitUntilItemsMissing(sourceFolderFid, [archive.fid], `确认删除压缩包 ${archiveName}`);
    log(`解压完成，已将源压缩包移入回收站：${archiveName}`);
    return true;
  }

  async function processArchive(
    archiveName,
    destinationPath,
    knownExisting,
    skipExisting,
    deleteArchiveAfterComplete,
    sourceFolderFid,
    log,
  ) {
    ensureUnzipSafe(sourceFolderFid, archiveName);
    const baseName = archiveBaseName(archiveName);
    if (knownExisting.has(baseName)) return { status: "skipped", reason: "额外跳过列表或本批次已提交" };
    const segments = destinationPath ? normalizeDestinationPath(destinationPath) : currentFolderDestination(sourceFolderFid);
    const targetPath = `全部文件${segments.length ? `/${segments.join("/")}` : ""}`;
    if (!destinationPath && skipExisting) {
      const currentItems = await listFolderItems(sourceFolderFid);
      for (const folder of currentItems.filter(isFolderItem)) knownExisting.add(folder.file_name);
      if (knownExisting.has(baseName)) return { status: "skipped", reason: `当前文件夹已存在 ${baseName}` };
    }
    let sourceArchive = null;
    if (deleteArchiveAfterComplete) {
      sourceArchive = await findSourceArchive(archiveName, sourceFolderFid);
      if (!sourceArchive) throw new Error(`无法确认源压缩包 ${archiveName} 的文件 ID，禁止自动删除`);
    }
    await prepareUnzipProgress(archiveName);
    ensureUnzipSafe(sourceFolderFid, archiveName);
    const archiveElement = await locateArchiveNameElement(archiveName, sourceFolderFid);
    ensureUnzipSafe(sourceFolderFid, archiveName);
    doubleClickElement(archiveElement);
    const archiveDialog = await waitFor(() => findArchiveDialog(archiveName), `打开压缩包“${archiveName}”`, 20000, 250, archiveName);
    let refreshedArchiveDialog = archiveDialog;
    let confirmedTargetSegments = null;

    let selectedDestinationDialog = null;
    try {
      const initialTarget = readArchiveTargetLabel(archiveDialog);
      if (destinationPath || !initialTarget || !destinationMatches(initialTarget, segments)) {
        const change = findExactText(archiveDialog, "更改", "span, div, a");
        if (!change) throw new Error("未找到“更改”目标目录入口");
        clickElement(change);
        const destinationDialog = await waitFor(() => findDestinationDialog(), "打开目标目录选择框", 15000, 250, archiveName);
        selectedDestinationDialog = destinationDialog;
        const { item: targetItem } = await locateDestination(destinationDialog, targetPath);
        if (destinationPath && skipExisting) {
          const existingFolders = await readExistingTargetFolders(targetItem);
          for (const folder of existingFolders) knownExisting.add(folder);
          if (knownExisting.has(baseName)) {
            await cancelDestinationAndCloseArchive(destinationDialog, archiveDialog);
            return { status: "skipped", reason: `目标目录已存在 ${baseName}` };
          }
        }
        confirmedTargetSegments = await selectDestination(destinationDialog, targetItem, segments);
        refreshedArchiveDialog = await waitFor(() => findArchiveDialog(archiveName), `返回压缩包“${archiveName}”预览`, 15000, 250, archiveName);
      }
      const actualTarget = readArchiveTargetLabel(refreshedArchiveDialog);
      if (!actualTarget || !destinationMatchesAfterSelection(actualTarget, segments, confirmedTargetSegments)) {
        throw new Error(`解压目标不一致：期望 ${targetPath}，页面显示 ${actualTarget || "未知"}；禁止提交`);
      }
      log(`${archiveName} 已核对解压目标：${actualTarget}`);

      const submit = findButton(refreshedArchiveDialog, "解压全部文件");
      if (!submit || submit.disabled) throw new Error("“解压全部文件”按钮不可用");
      ensureUnzipSafe(sourceFolderFid, archiveName);
      const taskWatcher = watchUnzipTask(archiveName, { nativeProgressReady: true });
      let acknowledged = false;
      try {
        taskWatcher.checkErrors();
        clickElement(submit);
        await taskWatcher.waitForAcknowledgement();
        acknowledged = true;
        knownExisting.add(baseName);
        // 确认受理后清理仍在前台的预览，下一项才能操作文件列表。
        await dismissArchivePreview(refreshedArchiveDialog, archiveName);
        log(`${archiveName} 已受理，等待本项解压完成后继续下一项`);
        await taskWatcher.wait();
        ensureUnzipSafe(sourceFolderFid, archiveName);
        taskWatcher.checkErrors();
        // 先确认本次进度组件已关闭；收尾失败时仍保留源文件。
        await closeUnzipProgress(taskWatcher.progressElement(), archiveName);
        ensureUnzipSafe(sourceFolderFid, archiveName);
        taskWatcher.checkErrors();
        let deleted = false;
        if (deleteArchiveAfterComplete) {
          deleted = await deleteCompletedArchive(archiveName, sourceArchive.fid, sourceFolderFid, log, taskWatcher.checkErrors);
        }
        log(`${archiveName} 解压完成${deleted ? "" : "，源压缩包保留"}`);
        return { status: "submitted", deleted };
      } catch (error) {
        if (acknowledged) error.archiveSubmitted = true;
        throw error;
      } finally {
        taskWatcher.cancel();
      }
    } catch (error) {
      // 受理后的收尾已经尝试过关闭；提交前失败只清理仍可见的本次窗口。
      if (!error.archiveSubmitted) {
        for (const dialog of [selectedDestinationDialog, refreshedArchiveDialog]) {
          if (dialog && document.body.contains(dialog) && isVisible(dialog)) closeDialog(dialog);
        }
      }
      throw error;
    }
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
    if (op === "regex") {
      const from = getValue("regexFrom").trim();
      if (!from) return "请先填写 From 正则";
      try { new RegExp(from, "g"); } catch (error) {
        return `From 正则格式错误：${error.message}`;
      }
    }
    if (op === "cnEpisode" && !/^(?:0?[1-9]|[1-9]\d)$/.test(getValue("season").trim())) return "请填写 1-99 的季号";
    if (op === "episode" && !getValue("showName").trim()) return "请先填写剧名";
    return "";
  }

  function buildPreview() {
    const ruleWarning = validateRule();
    if (ruleWarning) {
      state.preview = [];
      state.duplicates = [];
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
    state.duplicates = duplicates;
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
      if (state.duplicates.length) {
        renderStatus(`存在 ${state.duplicates.length} 个重复新文件名，请调整规则后再执行`);
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
      if (failed.length) {
        renderStatus(`完成 ${ok} 个，失败 ${failed.length} 个`);
        renderPreview(state.duplicates, failed);
      } else {
        renderStatus(`全部完成 ${ok} 个文件，即将刷新页面…`);
        renderPreview(state.duplicates, failed);
        setTimeout(() => location.reload(), 1200);
      }
    } finally {
      state.busy = false;
      setBusy(false);
    }
  }

  function getValue(name) {
    const el = document.querySelector(`#${PANEL_ID} [name="${name}"]`);
    return el ? el.value : "";
  }

  function readFormValues() {
    try {
      const raw = localStorage.getItem(FORM_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch { return {}; }
  }

  function writeFormValues() {
    const data = {};
    FORM_FIELDS.forEach((name) => { data[name] = getValue(name); });
    try { localStorage.setItem(FORM_KEY, JSON.stringify(data)); } catch {}
  }

  function restoreFormValues(panel) {
    const saved = readFormValues();
    FORM_FIELDS.forEach((name) => {
      if (saved[name] == null) return;
      const el = panel.querySelector(`[name="${name}"]`);
      if (el) el.value = saved[name];
    });
  }

  function bindFormPersistence(panel) {
    FORM_FIELDS.forEach((name) => {
      const el = panel.querySelector(`[name="${name}"]`);
      if (!el) return;
      const evt = el.tagName === "SELECT" ? "change" : "input";
      el.addEventListener(evt, () => {
        writeFormValues();
        if (name === "operation") syncFieldVisibility(panel);
      });
    });
  }

  function readToolsConfig() {
    try {
      const parsed = JSON.parse(localStorage.getItem(TOOLS_CONFIG_KEY) || "{}");
      return { ...DEFAULT_TOOLS_CONFIG, ...(parsed && typeof parsed === "object" ? parsed : {}) };
    } catch {
      return { ...DEFAULT_TOOLS_CONFIG };
    }
  }

  function writeToolsConfig(config) {
    try { localStorage.setItem(TOOLS_CONFIG_KEY, JSON.stringify(config)); } catch {}
  }

  function restoreToolsConfig(panel) {
    const config = readToolsConfig();
    panel.querySelector('[name="destinationPath"]').value = config.destinationPath;
    panel.querySelector('[name="archivePattern"]').value = config.archivePattern;
    panel.querySelector('[name="extraSkip"]').value = config.extraSkip;
    panel.querySelector('[name="skipExisting"]').checked = config.skipExisting;
    panel.querySelector('[name="deleteArchiveAfterComplete"]').checked = config.deleteArchiveAfterComplete;
    panel.querySelector('[name="deleteEmptyFolders"]').checked = config.deleteEmptyFolders;
  }

  function readToolsForm(panel) {
    const config = {
      destinationPath: panel.querySelector('[name="destinationPath"]').value.trim(),
      archivePattern: panel.querySelector('[name="archivePattern"]').value.trim(),
      extraSkip: panel.querySelector('[name="extraSkip"]').value.trim(),
      skipExisting: panel.querySelector('[name="skipExisting"]').checked,
      deleteArchiveAfterComplete: panel.querySelector('[name="deleteArchiveAfterComplete"]').checked,
      deleteEmptyFolders: panel.querySelector('[name="deleteEmptyFolders"]').checked,
    };
    const pattern = new RegExp(config.archivePattern, "i");
    writeToolsConfig(config);
    return { config, pattern };
  }

  function syncFieldVisibility(panel) {
    const op = getValue("operation");
    panel.querySelectorAll(".qbr-field").forEach((el) => {
      el.classList.toggle("is-active", el.dataset.for === op);
    });
  }

  function setBusy(isBusy, allowStop = false) {
    document.querySelectorAll(`#${PANEL_ID} button, #${PANEL_ID} input, #${PANEL_ID} select`)
      .forEach((el) => {
        if (el.dataset.keepEnabled !== "1") el.disabled = isBusy;
      });
    document.querySelectorAll(`#${PANEL_ID} .qbr-stop`).forEach((stopButton) => {
      stopButton.disabled = !isBusy || !allowStop;
    });
  }

  function renderStatus(text) {
    const el = document.querySelector(`#${PANEL_ID} .qbr-rename-status`);
    if (el) el.textContent = text;
  }

  function renderToolsStatus(text) {
    const el = document.querySelector(`#${PANEL_ID} .qbr-pane.is-active .qbr-tools-status`);
    if (el) el.textContent = text;
  }

  function appendToolsLog(message) {
    const el = document.querySelector(`#${PANEL_ID} .qbr-pane.is-active .qbr-log`);
    if (!el) return;
    el.textContent += `[${new Date().toLocaleTimeString()}] ${message}\n`;
    el.scrollTop = el.scrollHeight;
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

  function panelSize(panel) {
    if (panel.classList.contains("qbr-collapsed")) {
      return { width: COLLAPSED_SIZE, height: COLLAPSED_SIZE };
    }
    const rect = panel.getBoundingClientRect();
    return {
      width: Math.min(rect.width || 376, window.innerWidth - PANEL_MARGIN * 2),
      height: Math.min(rect.height || 44, window.innerHeight - PANEL_MARGIN * 2),
    };
  }

  function computeDefaultPos(panel) {
    const { width, height } = panelSize(panel);
    return {
      left: Math.max(PANEL_MARGIN, window.innerWidth - width - PANEL_MARGIN),
      top: Math.max(PANEL_MARGIN, window.innerHeight - height - DEFAULT_BOTTOM_OFFSET),
    };
  }

  function clampPanelPos(panel, pos) {
    const { width, height } = panelSize(panel);
    const maxLeft = Math.max(PANEL_MARGIN, window.innerWidth - width - PANEL_MARGIN);
    const maxTop = Math.max(PANEL_MARGIN, window.innerHeight - height - PANEL_MARGIN);
    return {
      left: Math.min(Math.max(pos.left, PANEL_MARGIN), maxLeft),
      top: Math.min(Math.max(pos.top, PANEL_MARGIN), maxTop),
    };
  }

  function setPanelPos(panel, pos, shouldSave = false) {
    const next = clampPanelPos(panel, pos);
    panel.style.left = `${Math.round(next.left)}px`;
    panel.style.top = `${Math.round(next.top)}px`;
    if (shouldSave) {
      try {
        localStorage.setItem(PANEL_POS_KEY, JSON.stringify({ left: Math.round(next.left), top: Math.round(next.top) }));
      } catch {}
    }
  }

  function readSavedPos() {
    try {
      const raw = localStorage.getItem(PANEL_POS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Number.isFinite(parsed.left) && Number.isFinite(parsed.top)) return parsed;
      }
    } catch {}
    const legacyTop = Number(localStorage.getItem(PANEL_LEGACY_TOP_KEY));
    if (Number.isFinite(legacyTop)) {
      try { localStorage.removeItem(PANEL_LEGACY_TOP_KEY); } catch {}
    }
    return null;
  }

  function restorePanelPos(panel) {
    setPanelPos(panel, readSavedPos() || computeDefaultPos(panel));
  }

  function keepPanelInViewport(panel) {
    // Collapsed: always snap back to the user's last dragged (saved) position,
    // so expanding/collapsing never overwrites it with the expanded-clamp pos.
    // Expanded: just clamp current position into the viewport without saving.
    if (panel.classList.contains("qbr-collapsed")) {
      const saved = readSavedPos();
      setPanelPos(panel, saved || computeDefaultPos(panel));
    } else {
      const rect = panel.getBoundingClientRect();
      setPanelPos(panel, { left: rect.left, top: rect.top });
    }
  }

  function bindPanelDrag(panel) {
    const toggle = panel.querySelector(".qbr-toggle");
    let drag = null;

    const startDrag = (clientX, clientY) => {
      const rect = panel.getBoundingClientRect();
      drag = {
        startX: clientX,
        startY: clientY,
        startLeft: rect.left,
        startTop: rect.top,
        moved: false,
      };
      panel.classList.add("qbr-dragging");
    };

    const moveDrag = (clientX, clientY, event) => {
      if (!drag) return;
      const dx = clientX - drag.startX;
      const dy = clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) > 4) drag.moved = true;
      if (drag.moved) {
        event.preventDefault();
        setPanelPos(panel, { left: drag.startLeft + dx, top: drag.startTop + dy });
      }
    };

    const finishDrag = () => {
      if (!drag) return;
      panel.classList.remove("qbr-dragging");
      if (drag.moved) {
        panel.dataset.dragged = "1";
        const rect = panel.getBoundingClientRect();
        setPanelPos(panel, { left: rect.left, top: rect.top }, true);
        setTimeout(() => { delete panel.dataset.dragged; }, 150);
      }
      drag = null;
    };

    toggle.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      startDrag(event.clientX, event.clientY);
    });
    document.addEventListener("mousemove", (event) => moveDrag(event.clientX, event.clientY, event));
    document.addEventListener("mouseup", finishDrag);

    toggle.addEventListener("touchstart", (event) => {
      if (!event.touches.length) return;
      startDrag(event.touches[0].clientX, event.touches[0].clientY);
    }, { passive: true });
    document.addEventListener("touchmove", (event) => {
      if (!event.touches.length) return;
      moveDrag(event.touches[0].clientX, event.touches[0].clientY, event);
    }, { passive: false });
    document.addEventListener("touchend", finishDrag);
    document.addEventListener("touchcancel", finishDrag);
  }

  function bindTabs(panel) {
    panel.querySelectorAll(".qbr-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        const name = tab.dataset.tab;
        panel.querySelectorAll(".qbr-tab").forEach((item) => item.classList.toggle("is-active", item === tab));
        panel.querySelectorAll(".qbr-pane").forEach((pane) => pane.classList.toggle("is-active", pane.dataset.pane === name));
        keepPanelInViewport(panel);
      });
    });
  }

  async function runVideoScan(panel) {
    if (state.busy) return;
    state.busy = true;
    state.stopRequested = false;
    state.movePlan = null;
    setBusy(true, true);
    renderToolsStatus("正在扫描所有子目录...");
    appendToolsLog("开始递归扫描当前目录的所有子文件夹");
    try {
      const plan = await scanNestedVideos(appendToolsLog);
      state.movePlan = plan;
      renderToolsStatus(`扫描完成：可移动 ${plan.candidates.length}，同名跳过 ${plan.conflicts.length}`);
      if (plan.candidates.length) {
        const preview = plan.candidates.slice(0, 40).map((video) => `${video.sourcePath}/${video.file_name}`);
        appendToolsLog(`待移动视频：\n${preview.join("\n")}${plan.candidates.length > preview.length ? `\n...另有 ${plan.candidates.length - preview.length} 个` : ""}`);
      } else appendToolsLog("没有发现可移动的视频文件");
      if (plan.conflicts.length) appendToolsLog(`同名冲突跳过 ${plan.conflicts.length} 个；当前目录或其他候选中已存在同名文件`);
    } catch (error) {
      if (error instanceof StopRequestedError) {
        renderToolsStatus("已停止扫描");
        appendToolsLog("扫描已停止，没有移动文件");
      } else {
        renderToolsStatus(`扫描失败：${error.message}`);
        appendToolsLog(`扫描失败：${error.message}`);
      }
    } finally {
      state.busy = false;
      setBusy(false);
    }
  }

  async function runVideoMove(panel) {
    if (state.busy) return;
    const plan = state.movePlan;
    if (!plan || plan.rootFid !== currentFolderFid()) {
      renderToolsStatus("请先在当前目录扫描子目录视频");
      return;
    }
    if (!plan.candidates.length) {
      renderToolsStatus("扫描结果中没有可移动视频");
      return;
    }
    const shouldDeleteEmpty = panel.querySelector('[name="deleteEmptyFolders"]').checked;
    const confirmed = window.confirm(
      `将 ${plan.candidates.length} 个视频移动到当前目录根层。` +
      (plan.conflicts.length ? `\n同名冲突将跳过 ${plan.conflicts.length} 个。` : "") +
      (shouldDeleteEmpty ? "\n移动完成后，会把确认已为空的子文件夹移入回收站。" : "") +
      "\n\n是否继续？",
    );
    if (!confirmed) return;
    readToolsForm(panel);
    state.busy = true;
    state.stopRequested = false;
    setBusy(true, true);
    appendToolsLog(`开始移动 ${plan.candidates.length} 个视频到当前目录${shouldDeleteEmpty ? "，完成后删除空文件夹" : ""}`);
    try {
      await executeMovePlan(plan, shouldDeleteEmpty, appendToolsLog, renderToolsStatus);
      renderToolsStatus(`移动完成：${state.moved.length} 个视频，删除 ${state.deletedFolders.length} 个空文件夹`);
      appendToolsLog(`移动汇总：成功 ${state.moved.length}，同名跳过 ${plan.conflicts.length}，删除空文件夹 ${state.deletedFolders.length}`);
      state.movePlan = null;
    } catch (error) {
      if (error instanceof StopRequestedError) {
        renderToolsStatus(`已停止：已移动 ${state.moved.length} 个视频`);
        appendToolsLog(`移动已停止；已完成 ${state.moved.length} 个视频，后续项目未处理`);
      } else {
        renderToolsStatus(`移动已停止：${error.message}`);
        appendToolsLog(`移动失败：${error.message}`);
      }
    } finally {
      state.busy = false;
      setBusy(false);
    }
  }

  async function runCloudUnzip(panel) {
    if (state.busy) return;
    let form;
    try {
      form = readToolsForm(panel);
    } catch (error) {
      renderToolsStatus(`压缩包正则错误：${error.message}`);
      return;
    }
    const sourceFolderFid = currentFolderFid();
    state.busy = true;
    state.stopRequested = false;
    setBusy(true, true);
    let archives;
    try {
      archives = await listArchiveNames(form.pattern, sourceFolderFid);
    } catch (error) {
      renderToolsStatus(`读取压缩包失败：${error.message}`);
      state.busy = false;
      setBusy(false);
      return;
    }
    if (!archives.length) {
      state.busy = false;
      setBusy(false);
      renderToolsStatus("当前目录没有识别到压缩包");
      return;
    }
    if (form.config.deleteArchiveAfterComplete && !window.confirm(
      `将依次解压 ${archives.length} 个压缩包。\n` +
      "页面确认每个任务解压完成后，对应源压缩包会被移入回收站。\n\n是否继续？",
    )) {
      state.busy = false;
      setBusy(false);
      return;
    }

    const knownExisting = new Set(
      form.config.extraSkip.split(/[,，\n]/).map((name) => name.trim()).filter(Boolean),
    );
    Object.assign(state, {
      busy: true,
      stopRequested: false,
      submitted: [],
      skipped: [],
      failed: [],
      deletedArchives: [],
    });
    setBusy(true, true);
    const targetLabel = form.config.destinationPath || "当前文件夹";
    appendToolsLog(`开始：${archives.length} 个压缩包 → ${targetLabel}${form.config.deleteArchiveAfterComplete ? "；解压完成后删除源压缩包" : ""}`);
    try {
      for (let index = 0; index < archives.length; index += 1) {
        if (state.stopRequested) throw new StopRequestedError();
        if (currentFolderFid() !== sourceFolderFid) throw new Error("当前文件夹已切换；为避免操作错误目录，已停止批次");
        const archiveName = archives[index];
        renderToolsStatus(`[${index + 1}/${archives.length}] 正在处理 ${archiveName}`);
        appendToolsLog(`处理 ${archiveName}`);
        try {
          const result = await processArchive(
            archiveName,
            form.config.destinationPath,
            knownExisting,
            form.config.skipExisting,
            form.config.deleteArchiveAfterComplete,
            sourceFolderFid,
            appendToolsLog,
          );
          if (result.status === "submitted") {
            state.submitted.push(archiveName);
            if (result.deleted) state.deletedArchives.push(archiveName);
            appendToolsLog(result.deleted ? `已完成并删除源压缩包 ${archiveName}` : `已完成 ${archiveName}`);
          } else {
            state.skipped.push({ archiveName, reason: result.reason });
            appendToolsLog(`已跳过 ${archiveName}：${result.reason}`);
          }
        } catch (error) {
          if (error.archiveSubmitted && !state.submitted.includes(archiveName)) {
            state.submitted.push(archiveName);
            appendToolsLog(`任务已提交，但未删除源压缩包 ${archiveName}：${error.message}`);
          }
          if (error instanceof StopRequestedError) throw error;
          state.failed.push({ archiveName, reason: error.message });
          appendToolsLog(`失败 ${archiveName}：${error.message}`);
          throw error;
        }
      }
      renderToolsStatus(`完成：提交 ${state.submitted.length}，跳过 ${state.skipped.length}，删除压缩包 ${state.deletedArchives.length}`);
    } catch (error) {
      if (error instanceof StopRequestedError) renderToolsStatus(`已停止：提交 ${state.submitted.length}，跳过 ${state.skipped.length}`);
      else renderToolsStatus(`已停止在错误项：${error.message}`);
    } finally {
      state.busy = false;
      setBusy(false);
      appendToolsLog(`汇总：提交 ${state.submitted.length}，跳过 ${state.skipped.length}，删除压缩包 ${state.deletedArchives.length}，失败 ${state.failed.length}`);
    }
  }

  function bindToolActions(panel) {
    panel.querySelector(".qbr-scan-archives").addEventListener("click", async () => {
      if (state.busy) return;
      state.busy = true;
      state.stopRequested = false;
      setBusy(true, true);
      try {
        const { pattern } = readToolsForm(panel);
        const archives = await listArchiveNames(pattern);
        renderToolsStatus(`当前目录识别到 ${archives.length} 个压缩包`);
        appendToolsLog(archives.length ? `扫描结果：${archives.join("、")}` : "未识别到压缩包，请确认当前位于源目录");
      } catch (error) {
        renderToolsStatus(`扫描压缩包失败：${error.message}`);
      } finally {
        state.busy = false;
        setBusy(false);
      }
    });
    panel.querySelector(".qbr-run-unzip").addEventListener("click", () => runCloudUnzip(panel));
    panel.querySelector(".qbr-scan-videos").addEventListener("click", () => runVideoScan(panel));
    panel.querySelector(".qbr-move-videos").addEventListener("click", () => runVideoMove(panel));
    panel.querySelectorAll(".qbr-stop").forEach((stopButton) => stopButton.addEventListener("click", () => {
      state.stopRequested = true;
      panel.querySelectorAll(".qbr-stop").forEach((button) => { button.disabled = true; });
      renderToolsStatus("将在当前安全步骤结束后停止");
      appendToolsLog("收到停止请求；已提交的任务、已完成的移动和已移入回收站的项目不会自动撤销");
    }));
    panel.querySelectorAll(".qbr-tools-config input").forEach((input) => {
      input.addEventListener(input.type === "checkbox" ? "change" : "input", () => {
        try { readToolsForm(panel); } catch {}
      });
    });
  }

  function injectStyle() {
    const style = document.createElement("style");
    style.textContent = `
      #${PANEL_ID} {
        position: fixed;
        left: 0;
        top: 0;
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
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        pointer-events: none;
      }
      #${PANEL_ID} .qbr-icon svg { width: 100%; height: 100%; display: block; }
      #${PANEL_ID}.qbr-collapsed .qbr-icon { width: 28px; height: 28px; }
      #${PANEL_ID} .qbr-close { font-size: 18px; line-height: 1; color: #687084; }
      #${PANEL_ID}.qbr-collapsed .qbr-close { display: none; }
      #${PANEL_ID}.qbr-collapsed .qbr-toggle .qbr-icon { display: block; }
      #${PANEL_ID} .qbr-toggle .qbr-icon { display: none; }
      #${PANEL_ID} .qbr-body { padding: 14px; }
      #${PANEL_ID} .qbr-tabs {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 6px;
        margin-bottom: 12px;
        padding: 4px;
        border-radius: 10px;
        background: #f2f5fa;
      }
      #${PANEL_ID} button.qbr-tab { height: 30px; border: 0; background: transparent; color: #687084; box-shadow: none; }
      #${PANEL_ID} button.qbr-tab.is-active { background: #fff; color: #245bff; box-shadow: 0 2px 7px rgba(22, 28, 45, .1); }
      #${PANEL_ID} .qbr-pane { display: none; }
      #${PANEL_ID} .qbr-pane.is-active { display: block; }
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
      #${PANEL_ID} label.qbr-check {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        margin-top: 10px;
        padding: 7px 8px;
        border: 1px solid #e1e5ee;
        border-radius: 8px;
        background: #fff;
        color: #4b5568;
        font-weight: 500;
        line-height: 1.45;
        cursor: pointer;
      }
      #${PANEL_ID} label.qbr-check:has(input:checked) {
        border-color: #9ab1ff;
        background: #eef3ff;
        color: #1746cc;
      }
      #${PANEL_ID} label.qbr-check input[type="checkbox"] {
        -webkit-appearance: checkbox !important;
        appearance: auto !important;
        position: static !important;
        display: inline-block !important;
        visibility: visible !important;
        opacity: 1 !important;
        width: 16px !important;
        height: 16px !important;
        min-width: 16px;
        margin: 1px 0 0 !important;
        padding: 0 !important;
        border: initial !important;
        border-radius: initial !important;
        background: initial !important;
        box-shadow: none !important;
        accent-color: #245bff;
        flex: 0 0 auto;
        cursor: pointer;
      }
      #${PANEL_ID} .qbr-field { display: none; }
      #${PANEL_ID} .qbr-field.is-active { display: block; }
      #${PANEL_ID} .qbr-help {
        margin-top: 12px;
        padding: 9px 10px;
        border-radius: 8px;
        background: #f6f8fc;
        color: #566074;
        font-size: 12px;
        line-height: 1.55;
      }
      #${PANEL_ID} .qbr-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      #${PANEL_ID} .qbr-actions {
        display: grid;
        grid-template-columns: 1fr 1fr 1.1fr;
        gap: 8px;
        margin-top: 14px;
      }
      #${PANEL_ID} .qbr-actions.qbr-two { grid-template-columns: 1fr 1.25fr; }
      #${PANEL_ID} .qbr-actions.qbr-stop-row { grid-template-columns: 1fr; margin-top: 8px; }
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
      #${PANEL_ID} button.qbr-danger { color: #b42318; border-color: #f1b8b2; }
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
      #${PANEL_ID} .qbr-log {
        height: 180px;
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-word;
        margin: 10px 0 0;
        padding: 9px;
        border-radius: 8px;
        background: #111827;
        color: #d1fae5;
        font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
      }
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
        <div class="qbr-heading" data-userscript-version="0.5.9">
          <span class="qbr-icon">${ICON_SVG}</span>
          <span>夸克网盘文件工具箱</span><small style="font-weight:400;color:#6b7280">v0.5.9</small>
        </div>
        <button type="button" class="qbr-toggle" data-keep-enabled="1" title="拖拽移动 / 点击展开收起">
          <span class="qbr-icon">${ICON_SVG}</span>
          <span class="qbr-close">×</span>
        </button>
      </div>
      <div class="qbr-body">
        <div class="qbr-tabs">
          <button type="button" class="qbr-tab is-active" data-tab="rename">重命名</button>
          <button type="button" class="qbr-tab" data-tab="unzip">云解压</button>
          <button type="button" class="qbr-tab" data-tab="videos">视频归集</button>
        </div>
        <section class="qbr-pane is-active" data-pane="rename">
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
          <div class="qbr-field" data-for="prefix">
            <label>前缀</label>
            <input name="prefix" value="" placeholder="示例：雨霖铃" />
          </div>
          <div class="qbr-field" data-for="regex">
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
          </div>
          <div class="qbr-field" data-for="removeEnglish">
            <div class="qbr-help">自动删除「中文.英文.SxxExx」格式中的英文剧名段，无需填写参数。</div>
          </div>
          <div class="qbr-field" data-for="cnEpisode">
            <label>季号</label>
            <input name="season" value="" placeholder="示例：1" />
          </div>
          <div class="qbr-field" data-for="episode">
            <label>剧名</label>
            <input name="showName" value="" placeholder="示例：仁心俱乐部" />
          </div>
          <div class="qbr-actions">
            <button type="button" class="qbr-load">读取</button>
            <button type="button" class="qbr-preview-btn">预览</button>
            <button type="button" class="qbr-primary qbr-run">执行</button>
          </div>
          <div class="qbr-status qbr-rename-status">准备就绪</div>
          <div class="qbr-preview"></div>
        </section>
        <section class="qbr-pane qbr-tools-config" data-pane="unzip">
          <label>目标目录</label>
          <input name="destinationPath" placeholder="留空表示当前文件夹（默认）" />
          <label>压缩包正则</label>
          <input name="archivePattern" placeholder="\\.(zip|rar|7z)$" />
          <label>额外跳过</label>
          <input name="extraSkip" placeholder="01-02, 03-04" />
          <label class="qbr-check"><input name="skipExisting" type="checkbox" />跳过目标目录已有同名文件夹</label>
          <label class="qbr-check"><input name="deleteArchiveAfterComplete" type="checkbox" />页面确认解压完成后删除源压缩包（移入回收站）</label>
          <div class="qbr-actions qbr-two">
            <button type="button" class="qbr-scan-archives">扫描压缩包</button>
            <button type="button" class="qbr-primary qbr-run-unzip">开始云解压</button>
          </div>
          <div class="qbr-status qbr-tools-status">等待操作</div>
          <pre class="qbr-log"></pre>
          <div class="qbr-actions qbr-stop-row"><button type="button" class="qbr-danger qbr-stop" data-keep-enabled="1" disabled>停止当前任务</button></div>
        </section>
        <section class="qbr-pane qbr-tools-config" data-pane="videos">
          <div class="qbr-help">递归识别当前目录所有子文件夹中的视频，并移动到当前目录根层。同名文件会跳过。</div>
          <label class="qbr-check"><input name="deleteEmptyFolders" type="checkbox" />移动完成后删除确认已为空的相关子文件夹</label>
          <div class="qbr-actions qbr-two">
            <button type="button" class="qbr-scan-videos">扫描子目录</button>
            <button type="button" class="qbr-primary qbr-move-videos">移动到当前目录</button>
          </div>
          <div class="qbr-status qbr-tools-status">等待操作</div>
          <pre class="qbr-log"></pre>
          <div class="qbr-actions qbr-stop-row"><button type="button" class="qbr-danger qbr-stop" data-keep-enabled="1" disabled>停止当前任务</button></div>
        </section>
      </div>
    `;
    document.body.appendChild(panel);
    restorePanelPos(panel);
    restoreFormValues(panel);
    restoreToolsConfig(panel);
    bindFormPersistence(panel);
    syncFieldVisibility(panel);
    bindPanelDrag(panel);
    bindTabs(panel);
    bindToolActions(panel);
    window.addEventListener("resize", () => keepPanelInViewport(panel));
    panel.querySelector(".qbr-toggle").addEventListener("click", (event) => {
      if (panel.dataset.dragged === "1") {
        event.preventDefault();
        event.stopPropagation();
        delete panel.dataset.dragged;
        return;
      }
      panel.classList.toggle("qbr-collapsed");
      // Call synchronously: both rAF and setTimeout(0) get throttled in
      // non-visible tabs, leaving the panel off-screen after a toggle.
      // keepPanelInViewport reads getBoundingClientRect which flushes layout
      // for the new class, so no async wait is needed.
      keepPanelInViewport(panel);
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
