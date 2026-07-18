// ==UserScript==
// @name         夸克网盘批量云解压
// @namespace    https://local.travisoa.com/userscripts
// @version      0.2.0
// @description  批量提交夸克云解压，并可将子目录视频归集到当前目录根层。
// @author       Codex
// @match        https://pan.quark.cn/list*
// @homepageURL  https://github.com/travisoa/scriptbox
// @downloadURL  https://raw.githubusercontent.com/travisoa/scriptbox/main/userscripts/quark-cloud-unzip.user.js
// @updateURL    https://raw.githubusercontent.com/travisoa/scriptbox/main/userscripts/quark-cloud-unzip.user.js
// @connect      drive-pc.quark.cn
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

(() => {
  "use strict";

  const PANEL_ID = "codex-quark-cloud-unzip";
  const CONFIG_KEY = "codex-quark-cloud-unzip-config-v1";
  const DEFAULT_CONFIG = {
    destinationPath: "/影视专区/电视剧📺/野狗骨头/Season 01",
    archivePattern: "\\.(zip|rar|7z)$",
    extraSkip: "01-02, 03-04, 05-06",
    skipExisting: true,
    deleteEmptyFolders: false,
  };

  const state = {
    running: false,
    stopRequested: false,
    submitted: [],
    skipped: [],
    failed: [],
    movePlan: null,
    moved: [],
    deletedFolders: [],
  };

  const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const archiveBaseName = (name) => name.replace(/\.(zip|rar|7z)$/i, "");
  const VIDEO_EXT_RE = /\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|ts|m2ts|rmvb)$/i;
  const MAX_SCAN_FOLDERS = 1000;
  const MOVE_BATCH_SIZE = 50;

  class StopRequestedError extends Error {
    constructor() {
      super("用户已请求停止");
      this.name = "StopRequestedError";
    }
  }

  function loadConfig() {
    try {
      return { ...DEFAULT_CONFIG, ...GM_getValue(CONFIG_KEY, {}) };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  function saveConfig(config) {
    GM_setValue(CONFIG_KEY, config);
  }

  function currentFolderFid() {
    const parts = String(location.hash || "").split("/").filter(Boolean);
    const last = parts[parts.length - 1] || "";
    if (!last || last === "all" || last === "root") return "0";
    return last.split("-")[0] || "0";
  }

  async function quarkJson(path, options = {}) {
    const sep = path.includes("?") ? "&" : "?";
    const url = `https://drive-pc.quark.cn${path}${sep}pr=ucpro&fr=pc`;
    const response = await fetch(url, {
      credentials: "include",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`夸克接口返回不是 JSON：${text.slice(0, 160)}`);
    }
    if (
      !response.ok ||
      (json.code && json.code !== 0) ||
      (json.status && json.status !== 200 && json.status !== "OK")
    ) {
      throw new Error(json.message || json.msg || `夸克接口失败：HTTP ${response.status}`);
    }
    return json;
  }

  function normalizeListPayload(json) {
    const data = json.data || json;
    const list = data.list || data.file_list || data.items || [];
    const total =
      data.total ??
      data._total ??
      data.metadata?._total ??
      data.metadata?.total ??
      list.length;
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

    for (const item of rootItems.filter(isFolderItem)) {
      enqueueFolder(item, "", 1, rootFid);
    }

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
        if (reservedNames.has(nameKey)) {
          conflicts.push(video);
        } else {
          reservedNames.add(nameKey);
          candidates.push(video);
        }
      }
      if (folders.length % 10 === 0) {
        log(`已扫描 ${folders.length} 个子目录，发现 ${candidates.length} 个可移动视频`);
      }
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

  async function deleteEmptyFolder(folderFid) {
    return quarkJson("/1/clouddrive/file/delete", {
      method: "POST",
      body: JSON.stringify({
        action_type: 2,
        filelist: [String(folderFid)],
        exclude_fids: [],
      }),
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
        await waitUntilItemsMissing(
          sourceFid,
          batch.map((video) => video.fid),
          `确认 ${batch.length} 个视频移出 ${batch[0].sourcePath}`,
        );
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
      await deleteEmptyFolder(folder.fid);
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
    const candidates = [...root.querySelectorAll(selector)]
      .filter((element) => isVisible(element) && normalizeText(element.textContent) === text)
      .sort((a, b) => a.children.length - b.children.length);
    return candidates[0] || null;
  }

  function findButton(root, text) {
    return [...root.querySelectorAll("button")].find(
      (button) => isVisible(button) && normalizeText(button.textContent) === text,
    ) || null;
  }

  function clickElement(element) {
    if (!element) throw new Error("点击目标不存在");
    element.scrollIntoView({ block: "center", inline: "nearest" });
    element.click();
  }

  function doubleClickElement(element) {
    if (!element) throw new Error("双击目标不存在");
    element.scrollIntoView({ block: "center", inline: "nearest" });
    // Tampermonkey 默认运行在隔离环境中；不要把隔离环境的 window
    // 传给页面 MouseEvent.view，否则 Chrome 会拒绝跨 realm 转换。
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
      const filenameCell = cells[1] || row;
      const textNode = matchingArchiveTextNode(filenameCell, pattern);
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
      const filenameCell = cells[1] || row;
      const textNode = matchingArchiveTextNode(filenameCell, /$^/, archiveName);
      if (textNode?.parentElement) return textNode.parentElement;
    }
    return null;
  }

  function treeItemTitle(item) {
    return normalizeText(
      item.querySelector(":scope > .ant-tree-node-content-wrapper .ant-tree-title")?.textContent,
    );
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
    return waitFor(
      () => directChildByTitle(item, expectedChild),
      `加载目录“${expectedChild}”`,
      15000,
    );
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

    for (const segment of segments) {
      current = await expandTreeItem(current, segment);
    }
    return { item: current, segments };
  }

  async function selectDestination(dialog, item) {
    const content = item.querySelector(":scope > .ant-tree-node-content-wrapper");
    if (!content) throw new Error("未找到最终目录名称");
    clickElement(content);
    await waitFor(
      () => item.classList.contains("ant-tree-treenode-selected"),
      `选择目录“${treeItemTitle(item)}”`,
    );
    const confirm = findButton(dialog, "确认");
    if (!confirm) throw new Error("未找到目录确认按钮");
    clickElement(confirm);
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
    )
      .catch(() => true);
  }

  async function processArchive(archiveName, destinationPath, knownExisting, skipExisting, log) {
    const baseName = archiveBaseName(archiveName);
    if (knownExisting.has(baseName)) {
      return { status: "skipped", reason: "额外跳过列表或本批次已提交" };
    }

    const archiveElement = await waitFor(
      () => findArchiveNameElement(archiveName),
      `定位压缩包“${archiveName}”`,
    );
    doubleClickElement(archiveElement);
    const archiveDialog = await waitFor(
      () => findArchiveDialog(archiveName),
      `打开压缩包“${archiveName}”`,
      20000,
    );

    const change = findExactText(archiveDialog, "更改", "span, div, a");
    if (!change) throw new Error("未找到“更改”目标目录入口");
    clickElement(change);
    const destinationDialog = await waitFor(
      () => findDestinationDialog(),
      "打开目标目录选择框",
    );
    const { item: targetItem, segments } = await locateDestination(destinationDialog, destinationPath);

    if (skipExisting) {
      const existingFolders = await readExistingTargetFolders(targetItem);
      for (const folder of existingFolders) knownExisting.add(folder);
      if (knownExisting.has(baseName)) {
        log(`跳过 ${archiveName}：目标目录已存在 ${baseName}`);
        await cancelDestinationAndCloseArchive(destinationDialog, archiveDialog);
        return { status: "skipped", reason: `目标目录已存在 ${baseName}` };
      }
    }

    await selectDestination(destinationDialog, targetItem);
    const refreshedArchiveDialog = await waitFor(
      () => findArchiveDialog(archiveName),
      `返回压缩包“${archiveName}”预览`,
    );
    const targetTail = segments.at(-1);
    if (!normalizeText(refreshedArchiveDialog.textContent).includes(`/${targetTail}`)) {
      throw new Error(`目标路径回显不包含 /${targetTail}，禁止提交`);
    }

    const submit = findButton(refreshedArchiveDialog, "解压全部文件");
    if (!submit) throw new Error("未找到“解压全部文件”按钮");
    clickElement(submit);

    const acknowledged = await waitFor(() => {
      const currentDialog = findArchiveDialog(archiveName);
      const pageText = normalizeText(document.body.textContent);
      const errorMatch = pageText.match(/(解压失败|压缩包损坏|需要密码|会员.*限制)/);
      if (errorMatch) throw new Error(errorMatch[1]);
      return !currentDialog || /解压(任务|中|成功|完成)|已加入/.test(pageText);
    }, `提交“${archiveName}”`, 20000);

    if (!acknowledged) throw new Error("页面未确认任务已受理");
    knownExisting.add(baseName);
    return { status: "submitted" };
  }

  function createPanel() {
    if (document.getElementById(PANEL_ID)) return;
    const config = loadConfig();
    const panel = document.createElement("section");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <header><strong>夸克批量云解压</strong><button data-action="collapse" title="收起">−</button></header>
      <div class="quark-unzip-body">
        <label>目标目录<input data-field="destination" type="text"></label>
        <label>压缩包正则<input data-field="pattern" type="text"></label>
        <label>额外跳过<input data-field="skip" type="text" placeholder="01-02, 03-04"></label>
        <label class="checkbox"><input data-field="skip-existing" type="checkbox"> 跳过目标目录已有同名文件夹</label>
        <div class="actions">
          <button data-action="scan">扫描</button>
          <button data-action="start" class="primary">开始云解压</button>
          <button data-action="stop" class="danger" disabled>停止</button>
        </div>
        <div class="section-title">子目录视频归集</div>
        <label class="checkbox"><input data-field="delete-empty-folders" type="checkbox"> 删除因移动而变空的文件夹</label>
        <div class="actions">
          <button data-action="scan-videos">扫描子目录视频</button>
          <button data-action="move-videos" class="success">移动到当前目录</button>
        </div>
        <div class="status" data-role="status">等待扫描</div>
        <pre data-role="log"></pre>
      </div>
    `;

    const style = document.createElement("style");
    style.textContent = `
      #${PANEL_ID}{position:fixed;right:18px;top:92px;width:370px;z-index:2147483646;background:#fff;color:#222;border:1px solid #d9d9d9;border-radius:12px;box-shadow:0 10px 35px rgba(0,0,0,.22);font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
      #${PANEL_ID} header{display:flex;align-items:center;justify-content:space-between;padding:11px 13px;background:#1677ff;color:#fff}
      #${PANEL_ID} header button{border:0;background:transparent;color:#fff;font-size:20px;cursor:pointer}
      #${PANEL_ID} .quark-unzip-body{padding:12px}
      #${PANEL_ID}.collapsed .quark-unzip-body{display:none}
      #${PANEL_ID} label{display:block;margin-bottom:9px;font-weight:600}
      #${PANEL_ID} label input[type="text"]{display:block;box-sizing:border-box;width:100%;margin-top:4px;padding:7px 8px;border:1px solid #c9c9c9;border-radius:6px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
      #${PANEL_ID} label.checkbox{font-weight:400;display:flex;align-items:center;gap:6px}
      #${PANEL_ID} .section-title{margin:13px 0 8px;padding-top:11px;border-top:1px solid #ececec;font-weight:700;color:#0f766e}
      #${PANEL_ID} .actions{display:flex;gap:7px;margin:10px 0}
      #${PANEL_ID} .actions button{border:1px solid #bbb;background:#fff;border-radius:6px;padding:7px 10px;cursor:pointer}
      #${PANEL_ID} .actions button.primary{background:#1677ff;border-color:#1677ff;color:#fff;flex:1}
      #${PANEL_ID} .actions button.success{background:#0f766e;border-color:#0f766e;color:#fff;flex:1}
      #${PANEL_ID} .actions button.danger{color:#cf1322;border-color:#ffccc7}
      #${PANEL_ID} button:disabled{opacity:.45;cursor:not-allowed}
      #${PANEL_ID} .status{padding:7px 9px;border-radius:6px;background:#f5f5f5;margin-bottom:8px}
      #${PANEL_ID} pre{height:180px;overflow:auto;white-space:pre-wrap;word-break:break-word;margin:0;padding:8px;background:#111827;color:#d1fae5;border-radius:7px;font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
    `;
    document.head.appendChild(style);
    document.body.appendChild(panel);

    const destinationInput = panel.querySelector('[data-field="destination"]');
    const patternInput = panel.querySelector('[data-field="pattern"]');
    const skipInput = panel.querySelector('[data-field="skip"]');
    const skipExistingInput = panel.querySelector('[data-field="skip-existing"]');
    const deleteEmptyFoldersInput = panel.querySelector('[data-field="delete-empty-folders"]');
    const scanArchiveButton = panel.querySelector('[data-action="scan"]');
    const startButton = panel.querySelector('[data-action="start"]');
    const scanVideosButton = panel.querySelector('[data-action="scan-videos"]');
    const moveVideosButton = panel.querySelector('[data-action="move-videos"]');
    const stopButton = panel.querySelector('[data-action="stop"]');
    const status = panel.querySelector('[data-role="status"]');
    const logArea = panel.querySelector('[data-role="log"]');

    destinationInput.value = config.destinationPath;
    patternInput.value = config.archivePattern;
    skipInput.value = config.extraSkip;
    skipExistingInput.checked = config.skipExisting;
    deleteEmptyFoldersInput.checked = config.deleteEmptyFolders;

    const log = (message) => {
      const time = new Date().toLocaleTimeString();
      logArea.textContent += `[${time}] ${message}\n`;
      logArea.scrollTop = logArea.scrollHeight;
    };
    const setStatus = (message) => { status.textContent = message; };
    const setBusy = (busy) => {
      for (const button of [scanArchiveButton, startButton, scanVideosButton, moveVideosButton]) {
        button.disabled = busy;
      }
      stopButton.disabled = !busy;
    };

    function readForm() {
      const nextConfig = {
        destinationPath: destinationInput.value.trim(),
        archivePattern: patternInput.value.trim(),
        extraSkip: skipInput.value.trim(),
        skipExisting: skipExistingInput.checked,
        deleteEmptyFolders: deleteEmptyFoldersInput.checked,
      };
      if (!nextConfig.destinationPath) throw new Error("请填写目标目录");
      const pattern = new RegExp(nextConfig.archivePattern, "i");
      saveConfig(nextConfig);
      return { config: nextConfig, pattern };
    }

    panel.querySelector('[data-action="collapse"]').addEventListener("click", () => {
      panel.classList.toggle("collapsed");
    });

    deleteEmptyFoldersInput.addEventListener("change", () => {
      saveConfig({ ...loadConfig(), deleteEmptyFolders: deleteEmptyFoldersInput.checked });
    });

    panel.querySelector('[data-action="scan"]').addEventListener("click", () => {
      try {
        const { pattern } = readForm();
        const archives = listArchiveNames(pattern);
        setStatus(`当前目录识别到 ${archives.length} 个压缩包`);
        log(archives.length ? `扫描结果：${archives.join("、")}` : "未识别到压缩包，请确认当前位于源目录");
      } catch (error) {
        setStatus(error.message);
      }
    });

    stopButton.addEventListener("click", () => {
      state.stopRequested = true;
      stopButton.disabled = true;
      setStatus("将在当前安全步骤结束后停止");
      log("收到停止请求；已提交的云解压任务和已完成的文件移动不会撤销");
    });

    scanVideosButton.addEventListener("click", async () => {
      if (state.running) return;
      state.running = true;
      state.stopRequested = false;
      state.movePlan = null;
      setBusy(true);
      setStatus("正在扫描所有子目录...");
      log("开始递归扫描当前目录的所有子文件夹");
      try {
        const plan = await scanNestedVideos(log);
        state.movePlan = plan;
        setStatus(`扫描完成：可移动 ${plan.candidates.length}，同名跳过 ${plan.conflicts.length}`);
        if (plan.candidates.length) {
          const preview = plan.candidates.slice(0, 40)
            .map((video) => `${video.sourcePath}/${video.file_name}`);
          log(`待移动视频：\n${preview.join("\n")}${plan.candidates.length > preview.length ? `\n...另有 ${plan.candidates.length - preview.length} 个` : ""}`);
        } else {
          log("没有发现可移动的视频文件");
        }
        if (plan.conflicts.length) {
          log(`同名冲突跳过 ${plan.conflicts.length} 个；根目录或其他候选中已存在同名文件`);
        }
      } catch (error) {
        if (error instanceof StopRequestedError) {
          setStatus("已停止扫描");
          log("扫描已停止，没有移动文件");
        } else {
          setStatus(`扫描失败：${error.message}`);
          log(`扫描失败：${error.message}`);
        }
      } finally {
        state.running = false;
        setBusy(false);
      }
    });

    moveVideosButton.addEventListener("click", async () => {
      if (state.running) return;
      const plan = state.movePlan;
      if (!plan || plan.rootFid !== currentFolderFid()) {
        setStatus("请先在当前目录扫描子目录视频");
        return;
      }
      if (!plan.candidates.length) {
        setStatus("扫描结果中没有可移动视频");
        return;
      }
      const shouldDeleteEmpty = deleteEmptyFoldersInput.checked;
      const confirmed = window.confirm(
        `将 ${plan.candidates.length} 个视频移动到当前目录根层。` +
        (plan.conflicts.length ? `\n同名冲突将跳过 ${plan.conflicts.length} 个。` : "") +
        (shouldDeleteEmpty ? "\n移动完成后，会把确认已为空的子文件夹移入回收站。" : "") +
        "\n\n是否继续？",
      );
      if (!confirmed) return;

      saveConfig({ ...loadConfig(), deleteEmptyFolders: shouldDeleteEmpty });
      state.running = true;
      state.stopRequested = false;
      setBusy(true);
      log(`开始移动 ${plan.candidates.length} 个视频到当前目录${shouldDeleteEmpty ? "，完成后删除空文件夹" : ""}`);
      try {
        await executeMovePlan(plan, shouldDeleteEmpty, log, setStatus);
        setStatus(`移动完成：${state.moved.length} 个视频，删除 ${state.deletedFolders.length} 个空文件夹`);
        log(`移动汇总：成功 ${state.moved.length}，同名跳过 ${plan.conflicts.length}，删除空文件夹 ${state.deletedFolders.length}`);
        state.movePlan = null;
      } catch (error) {
        if (error instanceof StopRequestedError) {
          setStatus(`已停止：已移动 ${state.moved.length} 个视频`);
          log(`移动已停止；已完成 ${state.moved.length} 个视频，后续项目未处理`);
        } else {
          setStatus(`移动已停止：${error.message}`);
          log(`移动失败：${error.message}`);
        }
      } finally {
        state.running = false;
        setBusy(false);
      }
    });

    startButton.addEventListener("click", async () => {
      if (state.running) return;
      let form;
      try {
        form = readForm();
      } catch (error) {
        setStatus(error.message);
        return;
      }

      const archives = listArchiveNames(form.pattern);
      if (!archives.length) {
        setStatus("当前目录没有识别到压缩包");
        return;
      }

      const knownExisting = new Set(
        form.config.extraSkip.split(/[,，\n]/).map((name) => name.trim()).filter(Boolean),
      );
      state.running = true;
      state.stopRequested = false;
      state.submitted = [];
      state.skipped = [];
      state.failed = [];
      setBusy(true);
      log(`开始：${archives.length} 个压缩包 → ${form.config.destinationPath}`);

      try {
        for (let index = 0; index < archives.length; index += 1) {
          if (state.stopRequested) throw new StopRequestedError();
          const archiveName = archives[index];
          setStatus(`[${index + 1}/${archives.length}] 正在处理 ${archiveName}`);
          log(`处理 ${archiveName}`);
          try {
            const result = await processArchive(
              archiveName,
              form.config.destinationPath,
              knownExisting,
              form.config.skipExisting,
              log,
            );
            if (result.status === "submitted") {
              state.submitted.push(archiveName);
              log(`已提交 ${archiveName}`);
            } else {
              state.skipped.push({ archiveName, reason: result.reason });
              log(`已跳过 ${archiveName}：${result.reason}`);
            }
          } catch (error) {
            if (error instanceof StopRequestedError) throw error;
            state.failed.push({ archiveName, reason: error.message });
            log(`失败 ${archiveName}：${error.message}`);
            throw error;
          }
        }
        setStatus(`完成：提交 ${state.submitted.length}，跳过 ${state.skipped.length}`);
      } catch (error) {
        if (error instanceof StopRequestedError) {
          setStatus(`已停止：提交 ${state.submitted.length}，跳过 ${state.skipped.length}`);
        } else {
          setStatus(`已停止在错误项：${error.message}`);
        }
      } finally {
        state.running = false;
        setBusy(false);
        log(`汇总：提交 ${state.submitted.length}，跳过 ${state.skipped.length}，失败 ${state.failed.length}`);
      }
    });
  }

  function boot() {
    if (!document.body) return setTimeout(boot, 500);
    createPanel();
  }

  boot();
})();
