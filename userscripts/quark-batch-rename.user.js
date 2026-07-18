// ==UserScript==
// @name         夸克网盘文件工具箱
// @namespace    https://local.travisoa.com/userscripts
// @version      0.5.2
// @description  批量重命名、云解压、删除已完成压缩包，以及归集子目录视频。
// @author       Codex
// @match        https://pan.quark.cn/*
// @icon         data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTYiIGZpbGw9IiMyNDViZmYiLz48cmVjdCB4PSIxNCIgeT0iMTIiIHdpZHRoPSIyOCIgaGVpZ2h0PSIzNiIgcng9IjMiIGZpbGw9IiNmZmYiLz48cmVjdCB4PSIxOSIgeT0iMjAiIHdpZHRoPSIxOCIgaGVpZ2h0PSIyIiBmaWxsPSIjM2I2ZGZmIiBvcGFjaXR5PSIuNTUiLz48cmVjdCB4PSIxOSIgeT0iMjYiIHdpZHRoPSIxNCIgaGVpZ2h0PSIyIiBmaWxsPSIjM2I2ZGZmIiBvcGFjaXR5PSIuNTUiLz48cmVjdCB4PSIxOSIgeT0iMzIiIHdpZHRoPSIxOCIgaGVpZ2h0PSIyIiBmaWxsPSIjM2I2ZGZmIiBvcGFjaXR5PSIuNTUiLz48cmVjdCB4PSIxOSIgeT0iMzgiIHdpZHRoPSIxMCIgaGVpZ2h0PSIyIiBmaWxsPSIjM2I2ZGZmIiBvcGFjaXR5PSIuNTUiLz48cGF0aCBkPSJNMzYgMzhMNTIgMjJMNTcgMjdMNDEgNDNMMzQgNDRaIiBmaWxsPSIjZmZkMzRhIiBzdHJva2U9IiMxZDRkZDYiIHN0cm9rZS13aWR0aD0iMS40Ii8+PC9zdmc+
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
    confirmedCurrentTarget: "",
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
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  async function waitFor(getter, label, timeout = 15000, interval = 250) {
    const deadline = Date.now() + timeout;
    let lastError;
    while (Date.now() < deadline) {
      if (state.stopRequested) throw new StopRequestedError();
      try {
        const value = getter();
        if (value) return value;
      } catch (error) {
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

  function documentTextOutsidePanel() {
    const panel = document.getElementById(PANEL_ID);
    const texts = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (!panel?.contains(node) && node.parentElement && isVisible(node.parentElement)) texts.push(node.nodeValue);
      node = walker.nextNode();
    }
    return normalizeText(texts.join(" "));
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

  function listArchiveNames(pattern) {
    const names = [];
    const seen = new Set();
    for (const row of document.querySelectorAll("tr")) {
      if (!isVisible(row)) continue;
      const cells = [...row.querySelectorAll(":scope > td, :scope > [role='cell']")];
      const textNode = matchingArchiveTextNode(cells[1] || row, pattern);
      const archiveName = normalizeText(textNode?.nodeValue);
      if (archiveName && !seen.has(archiveName)) {
        seen.add(archiveName);
        names.push(archiveName);
      }
    }
    return names;
  }

  function findArchiveNameElement(archiveName) {
    const titled = [...document.querySelectorAll("tr [title]")].find(
      (element) => isVisible(element) && normalizeText(element.getAttribute("title")) === archiveName,
    );
    if (titled) return titled;
    for (const row of document.querySelectorAll("tr")) {
      if (!isVisible(row)) continue;
      const cells = [...row.querySelectorAll(":scope > td, :scope > [role='cell']")];
      const textNode = matchingArchiveTextNode(cells[1] || row, /$^/, archiveName);
      if (textNode?.parentElement) return textNode.parentElement;
    }
    return null;
  }

  function treeItemTitle(item) {
    return normalizeText(item.querySelector(":scope > .ant-tree-node-content-wrapper .ant-tree-title")?.textContent);
  }

  function directTreeChildren(item) {
    const group = item.querySelector(":scope > ul[role='group'], :scope > ul.ant-tree-child-tree");
    return group ? [...group.children].filter((child) => child.matches("li[role='treeitem']")) : [];
  }

  function directChildByTitle(item, title) {
    return directTreeChildren(item).find((child) => treeItemTitle(child) === title) || null;
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
    if (!segments.length) throw new Error("目标目录不能是根目录");
    return segments;
  }

  async function locateDestination(dialog, destinationPath) {
    const segments = normalizeDestinationPath(destinationPath);
    const tree = dialog.querySelector('[role="tree"]');
    if (!tree) throw new Error("未找到目标目录树");
    let current = [...tree.querySelectorAll(":scope > li[role='treeitem']")]
      .find((item) => treeItemTitle(item) === "全部文件");
    if (!current) throw new Error("未找到“全部文件”根节点");
    for (const segment of segments) current = await expandTreeItem(current, segment);
    return { item: current, segments };
  }

  async function selectDestination(dialog, item) {
    const content = item.querySelector(":scope > .ant-tree-node-content-wrapper");
    if (!content) throw new Error("未找到最终目录名称");
    clickElement(content);
    await waitFor(() => item.classList.contains("ant-tree-treenode-selected"), `选择目录“${treeItemTitle(item)}”`);
    const confirmButton = findButton(dialog, "确认");
    if (!confirmButton) throw new Error("未找到目录确认按钮");
    clickElement(confirmButton);
    await waitFor(() => !findDestinationDialog(), "关闭目标目录选择框");
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

  function watchUnzipCompletion(archiveName) {
    const baseName = archiveBaseName(archiveName);
    let outcome = null;
    const inspectText = (value) => {
      if (outcome) return;
      const text = normalizeText(value);
      if (!text || text.length > 500 || (!text.includes(archiveName) && !text.includes(baseName))) return;
      const errorMatch = text.match(/(解压失败|压缩包损坏|需要密码|会员.*限制)/);
      if (errorMatch) outcome = { type: "error", message: errorMatch[1] };
      else if (!/(等待.*解压完成|正在解压|解压中)/.test(text) &&
        /(解压已完成|解压成功|已完成解压|云解压完成|解压完成)/.test(text)) {
        outcome = { type: "completed" };
      }
    };
    const observer = new MutationObserver((records) => {
      const panel = document.getElementById(PANEL_ID);
      const inspectNodeContext = (node) => {
        let current = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
        for (let depth = 0; current && depth < 5; depth += 1) {
          if (panel?.contains(current)) return;
          inspectText(current.textContent);
          current = current.parentElement;
        }
      };
      for (const record of records) {
        if (record.type === "characterData") {
          if (!panel?.contains(record.target)) inspectNodeContext(record.target);
        } else {
          for (const node of record.addedNodes) if (!panel?.contains(node)) inspectNodeContext(node);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return {
      async wait() {
        const deadline = Date.now() + UNZIP_COMPLETION_TIMEOUT_MS;
        while (Date.now() < deadline) {
          if (state.stopRequested) throw new StopRequestedError();
          if (outcome?.type === "completed") return;
          if (outcome?.type === "error") throw new Error(outcome.message);
          await sleep(1000);
        }
        throw new Error("等待页面确认解压完成超时；源压缩包已保留");
      },
      cancel() { observer.disconnect(); },
    };
  }

  async function findSourceArchive(archiveName, sourceFolderFid) {
    const items = await listFolderItems(sourceFolderFid, { allowStop: false });
    return items.find((item) => !isFolderItem(item) && item.file_name === archiveName) || null;
  }

  async function deleteCompletedArchive(archiveName, archiveFid, sourceFolderFid, log) {
    const archive = await findSourceArchive(archiveName, sourceFolderFid);
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
    const baseName = archiveBaseName(archiveName);
    if (knownExisting.has(baseName)) return { status: "skipped", reason: "额外跳过列表或本批次已提交" };
    const archiveElement = await waitFor(() => findArchiveNameElement(archiveName), `定位压缩包“${archiveName}”`);
    let sourceArchive = null;
    if (deleteArchiveAfterComplete) {
      sourceArchive = await findSourceArchive(archiveName, sourceFolderFid);
      if (!sourceArchive) throw new Error(`无法确认源压缩包 ${archiveName} 的文件 ID，禁止自动删除`);
    }
    doubleClickElement(archiveElement);
    const archiveDialog = await waitFor(() => findArchiveDialog(archiveName), `打开压缩包“${archiveName}”`, 20000);
    let refreshedArchiveDialog = archiveDialog;

    if (!destinationPath) {
      const currentTargetLabel = readArchiveTargetLabel(archiveDialog);
      if (!currentTargetLabel) throw new Error("预览框未显示解压目标，无法确认当前文件夹默认值");
      if (state.confirmedCurrentTarget !== currentTargetLabel) {
        const confirmed = window.confirm(`目标目录留空，夸克预览框当前显示：\n${currentTargetLabel}\n\n请确认这就是当前文件夹。`);
        if (!confirmed) {
          closeDialog(archiveDialog);
          throw new Error("未确认当前文件夹目标，已停止提交");
        }
        state.confirmedCurrentTarget = currentTargetLabel;
      }
      if (skipExisting) {
        const currentItems = await listFolderItems(sourceFolderFid);
        for (const folder of currentItems.filter(isFolderItem)) knownExisting.add(folder.file_name);
        if (knownExisting.has(baseName)) {
          closeDialog(archiveDialog);
          await waitFor(
            () => !document.body.contains(archiveDialog) || !isVisible(archiveDialog),
            "关闭压缩包预览",
            5000,
          ).catch(() => true);
          return { status: "skipped", reason: `当前文件夹已存在 ${baseName}` };
        }
      }
      log(`${archiveName} 使用已确认的当前文件夹目标：${currentTargetLabel}`);
    } else {
      const change = findExactText(archiveDialog, "更改", "span, div, a");
      if (!change) throw new Error("未找到“更改”目标目录入口");
      clickElement(change);
      const destinationDialog = await waitFor(() => findDestinationDialog(), "打开目标目录选择框");
      const { item: targetItem, segments } = await locateDestination(destinationDialog, destinationPath);
      if (skipExisting) {
        const existingFolders = await readExistingTargetFolders(targetItem);
        for (const folder of existingFolders) knownExisting.add(folder);
        if (knownExisting.has(baseName)) {
          await cancelDestinationAndCloseArchive(destinationDialog, archiveDialog);
          return { status: "skipped", reason: `目标目录已存在 ${baseName}` };
        }
      }
      await selectDestination(destinationDialog, targetItem);
      refreshedArchiveDialog = await waitFor(() => findArchiveDialog(archiveName), `返回压缩包“${archiveName}”预览`);
      const targetTail = segments.at(-1);
      if (!normalizeText(refreshedArchiveDialog.textContent).includes(`/${targetTail}`)) {
        throw new Error(`目标路径回显不包含 /${targetTail}，禁止提交`);
      }
    }

    const submit = findButton(refreshedArchiveDialog, "解压全部文件");
    if (!submit) throw new Error("未找到“解压全部文件”按钮");
    const completionWatcher = deleteArchiveAfterComplete ? watchUnzipCompletion(archiveName) : null;
    try {
      clickElement(submit);
      const acknowledged = await waitFor(() => {
        const currentDialog = findArchiveDialog(archiveName);
        const pageText = documentTextOutsidePanel();
        const errorMatch = pageText.match(/(解压失败|压缩包损坏|需要密码|会员.*限制)/);
        if (errorMatch) throw new Error(errorMatch[1]);
        return !currentDialog || /解压(任务|中|成功|完成)|已加入/.test(pageText);
      }, `提交“${archiveName}”`, 20000);
      if (!acknowledged) throw new Error("页面未确认任务已受理");
      knownExisting.add(baseName);
      let deleted = false;
      if (completionWatcher) {
        log(`${archiveName} 已受理，等待页面确认解压完成后再删除源压缩包`);
        try {
          await completionWatcher.wait();
          deleted = await deleteCompletedArchive(archiveName, sourceArchive.fid, sourceFolderFid, log);
        } catch (error) {
          error.archiveSubmitted = true;
          throw error;
        }
      }
      return { status: "submitted", deleted };
    } finally {
      completionWatcher?.cancel();
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
    const archives = listArchiveNames(form.pattern);
    if (!archives.length) {
      renderToolsStatus("当前目录没有识别到压缩包");
      return;
    }
    if (form.config.deleteArchiveAfterComplete && !window.confirm(
      `将依次解压 ${archives.length} 个压缩包。\n` +
      "页面确认每个任务解压完成后，对应源压缩包会被移入回收站。\n\n是否继续？",
    )) return;

    const knownExisting = new Set(
      form.config.extraSkip.split(/[,，\n]/).map((name) => name.trim()).filter(Boolean),
    );
    const sourceFolderFid = currentFolderFid();
    Object.assign(state, {
      busy: true,
      stopRequested: false,
      submitted: [],
      skipped: [],
      failed: [],
      deletedArchives: [],
      confirmedCurrentTarget: "",
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
            appendToolsLog(result.deleted ? `已完成并删除源压缩包 ${archiveName}` : `已提交 ${archiveName}`);
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
    panel.querySelector(".qbr-scan-archives").addEventListener("click", () => {
      try {
        const { pattern } = readToolsForm(panel);
        const archives = listArchiveNames(pattern);
        renderToolsStatus(`当前目录识别到 ${archives.length} 个压缩包`);
        appendToolsLog(archives.length ? `扫描结果：${archives.join("、")}` : "未识别到压缩包，请确认当前位于源目录");
      } catch (error) {
        renderToolsStatus(`压缩包正则错误：${error.message}`);
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
      #${PANEL_ID} button.qbr-success { background: #0f766e; border-color: #0f766e; color: #fff; box-shadow: 0 6px 14px rgba(15, 118, 110, .18); }
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
        <div class="qbr-heading">
          <span class="qbr-icon">${ICON_SVG}</span>
          <span>夸克网盘文件工具箱</span>
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
            <button type="button" class="qbr-success qbr-move-videos">移动到当前目录</button>
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
