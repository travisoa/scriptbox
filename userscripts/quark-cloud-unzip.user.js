// ==UserScript==
// @name         夸克网盘批量云解压
// @namespace    https://local.travisoa.com/userscripts
// @version      0.1.2
// @description  在夸克网盘网页内批量提交服务端云解压，支持指定目标目录、跳过已完成文件夹和随时停止。
// @author       Codex
// @match        https://pan.quark.cn/list*
// @homepageURL  https://github.com/travisoa/scriptbox
// @downloadURL  https://raw.githubusercontent.com/travisoa/scriptbox/main/userscripts/quark-cloud-unzip.user.js
// @updateURL    https://raw.githubusercontent.com/travisoa/scriptbox/main/userscripts/quark-cloud-unzip.user.js
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
  };

  const state = {
    running: false,
    stopRequested: false,
    submitted: [],
    skipped: [],
    failed: [],
  };

  const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const archiveBaseName = (name) => name.replace(/\.(zip|rar|7z)$/i, "");

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
      #${PANEL_ID} .actions{display:flex;gap:7px;margin:10px 0}
      #${PANEL_ID} .actions button{border:1px solid #bbb;background:#fff;border-radius:6px;padding:7px 10px;cursor:pointer}
      #${PANEL_ID} .actions button.primary{background:#1677ff;border-color:#1677ff;color:#fff;flex:1}
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
    const startButton = panel.querySelector('[data-action="start"]');
    const stopButton = panel.querySelector('[data-action="stop"]');
    const status = panel.querySelector('[data-role="status"]');
    const logArea = panel.querySelector('[data-role="log"]');

    destinationInput.value = config.destinationPath;
    patternInput.value = config.archivePattern;
    skipInput.value = config.extraSkip;
    skipExistingInput.checked = config.skipExisting;

    const log = (message) => {
      const time = new Date().toLocaleTimeString();
      logArea.textContent += `[${time}] ${message}\n`;
      logArea.scrollTop = logArea.scrollHeight;
    };
    const setStatus = (message) => { status.textContent = message; };

    function readForm() {
      const nextConfig = {
        destinationPath: destinationInput.value.trim(),
        archivePattern: patternInput.value.trim(),
        extraSkip: skipInput.value.trim(),
        skipExisting: skipExistingInput.checked,
      };
      if (!nextConfig.destinationPath) throw new Error("请填写目标目录");
      const pattern = new RegExp(nextConfig.archivePattern, "i");
      saveConfig(nextConfig);
      return { config: nextConfig, pattern };
    }

    panel.querySelector('[data-action="collapse"]').addEventListener("click", () => {
      panel.classList.toggle("collapsed");
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
      log("收到停止请求；已经提交的任务不会撤销");
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
      startButton.disabled = true;
      stopButton.disabled = false;
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
        startButton.disabled = false;
        stopButton.disabled = true;
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
