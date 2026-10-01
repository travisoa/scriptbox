'use strict';

// Offline regressions against the shipped userscripts. No boot, account, network,
// package installation, or cloud file mutations.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Intended location: userscripts/tests/quark-unzip.test.cjs. For a temporary
// harness, set QUARK_USERSCRIPT_DIR or pass explicit userscript file paths.
const scriptsDir = process.env.QUARK_USERSCRIPT_DIR || path.resolve(__dirname, '..');
const scriptPaths = process.argv.slice(2).length ? process.argv.slice(2).map((file) => path.resolve(file)) : [
  path.join(scriptsDir, 'quark-batch-rename.user.js'),
  path.join(scriptsDir, 'quark-cloud-unzip.user.js'),
];

function createDom() {
  const observers = new Set();
  const descendants = (node) => node.childNodes.flatMap((child) => [child, ...descendants(child)]);
  const queueMutation = (record) => {
    for (const observer of observers) {
      if (observer.root !== record.target && !observer.root?.contains(record.target)) continue;
      if (record.type === 'characterData' && !observer.options.characterData) continue;
      if (record.type === 'childList' && !observer.options.childList) continue;
      observer.records.push(record);
      if (!observer.queued) {
        observer.queued = true;
        queueMicrotask(() => {
          observer.queued = false;
          if (!observers.has(observer)) return;
          const records = observer.records.splice(0);
          if (records.length) observer.callback(records, observer);
        });
      }
    }
  };
  class TextNode {
    constructor(value) { this.nodeType = 3; this._value = value; this.parentElement = null; this.childNodes = []; }
    get nodeValue() { return this._value; }
    set nodeValue(value) { this._value = value; queueMutation({ type: 'characterData', target: this }); }
    get textContent() { return this.nodeValue; }
    set textContent(value) { this.nodeValue = value; }
    get isConnected() { return Boolean(this.parentElement?.isConnected); }
    contains(node) { return this === node; }
  }
  class Element {
    constructor(tagName = 'div') {
      this.nodeType = 1;
      this.tagName = tagName.toUpperCase();
      this.childNodes = [];
      this.parentElement = null;
      this.attrs = {};
      this.style = { display: '', visibility: '' };
      this.hidden = false;
      this.dataset = {};
      this.classList = { contains: (value) => (this.attrs.class || '').split(/\s+/).includes(value) };
      this.offsetWidth = 100;
      this.offsetHeight = 20;
    }
    get children() { return this.childNodes.filter((node) => node.nodeType === 1); }
    get parentNode() { return this.parentElement; }
    get isConnected() { return this === document.documentElement || Boolean(this.parentElement?.isConnected); }
    get textContent() { return this.childNodes.map((node) => node.textContent).join(''); }
    set textContent(value) {
      const removedNodes = this.childNodes.splice(0);
      for (const node of removedNodes) node.parentElement = null;
      const addedNodes = value === '' ? [] : [new TextNode(String(value))];
      for (const node of addedNodes) { node.parentElement = this; this.childNodes.push(node); }
      queueMutation({ type: 'childList', target: this, addedNodes, removedNodes });
    }
    appendChild(node) {
      node.parentElement = this;
      this.childNodes.push(node);
      queueMutation({ type: 'childList', target: this, addedNodes: [node], removedNodes: [] });
      return node;
    }
    remove() {
      const parent = this.parentElement;
      if (!parent) return;
      parent.childNodes.splice(parent.childNodes.indexOf(this), 1);
      this.parentElement = null;
      queueMutation({ type: 'childList', target: parent, addedNodes: [], removedNodes: [this] });
    }
    contains(node) { return node === this || descendants(this).includes(node); }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    getAttribute(key) { return this.attrs[key] ?? null; }
    hasAttribute(key) { return key in this.attrs; }
    matches(selector) {
      return selector.split(',').some((raw) => {
        const s = raw.trim();
        if (s === '*') return true;
        const tag = s.match(/^[a-z][a-z\d-]*/i)?.[0];
        if (tag && this.tagName !== tag.toUpperCase()) return false;
        const classes = [...s.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
        if (classes.some((name) => !this.classList.contains(name))) return false;
        for (const match of s.matchAll(/\[([^=\]\s]+)(?:=['"]?([^'"\]]+)['"]?)?\]/g)) {
          if (!this.hasAttribute(match[1]) || (match[2] !== undefined && this.getAttribute(match[1]) !== match[2])) return false;
        }
        return Boolean(tag || classes.length || s.includes('['));
      });
    }
    closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
    querySelectorAll(selector) { return descendants(this).filter((node) => node.nodeType === 1 && node.matches(selector)); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    getClientRects() { return this.hidden || this.style.display === 'none' ? [] : [{ width: 100, height: 20 }]; }
    getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 20, left: 0, top: 0, right: 100, bottom: 20 }; }
    scrollIntoView() {}
    click() { this.onClick?.(); }
    dispatchEvent(event) { if (event.type === 'dblclick') this.onDoubleClick?.(); return true; }
  }
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.records = []; }
    observe(root, options) { this.root = root; this.options = options; observers.add(this); }
    disconnect() { observers.delete(this); this.records = []; }
  }
  const document = {
    createElement: (tag) => new Element(tag),
    createTextNode: (text) => new TextNode(text),
    querySelectorAll(selector) { return this.documentElement.querySelectorAll(selector); },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    getElementById(id) { return this.querySelectorAll('[id]').find((node) => node.getAttribute('id') === id) || null; },
    createTreeWalker(root, whatToShow) {
      const nodes = descendants(root).filter((node) => whatToShow === 4 ? node.nodeType === 3 : node.nodeType === 1);
      let index = 0;
      return { nextNode: () => nodes[index++] || null };
    },
    readyState: 'complete',
  };
  document.documentElement = new Element('html');
  document.body = document.documentElement.appendChild(new Element('body'));
  return {
    document, MutationObserver, HTMLElement: Element,
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 }, NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 },
    getComputedStyle: (node) => ({ display: node.hidden ? 'none' : node.style.display || 'block', visibility: node.style.visibility || 'visible' }),
    element(text, attrs = {}) { const node = new Element(); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value); node.textContent = text; return node; },
  };
}

function load(scriptPath, hash = '#/list/all') {
  const source = fs.readFileSync(scriptPath, 'utf8');
  const strictIndex = source.indexOf('  "use strict";');
  const bootIndex = source.lastIndexOf('\n  function boot() {');
  assert.ok(strictIndex > 0 && bootIndex > strictIndex, 'known IIFE and boot boundary');
  const dom = createDom();
  const location = { hash };
  const ctx = vm.createContext({
    ...dom, location, URLSearchParams, console,
    setTimeout: (fn, ms, ...args) => setTimeout(fn, Math.min(ms, 3), ...args), clearTimeout,
    Date, Promise, Set, Map, Error, RegExp,
    MouseEvent: class { constructor(type) { this.type = type; } },
    fetch: async () => { throw new Error('Network forbidden in offline regression harness'); },
    window: { confirm: () => true },
    GM_getValue: (_key, fallback) => fallback, GM_setValue: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  });
  const names = [
    'currentFolderDestination', 'normalizeDestinationPath', 'destinationMatches',
    'readUnzipPageError', 'watchUnzipTask', 'waitFor', 'deleteCompletedArchive',
    'processArchive', 'state', 'StopRequestedError', 'UnzipPageError',
  ];
  vm.runInContext(source.slice(strictIndex, bootIndex) + '\nglobalThis.api = {' + names.join(',') + '};', ctx, { filename: scriptPath });
  return { api: ctx.api, dom, location, ctx, evaluate: (code) => vm.runInContext(code, ctx) };
}

const task = (h, text, attrs = {}) => h.dom.document.body.appendChild(h.dom.element(text, { class: 'ant-message-notice-content', ...attrs }));
const flush = () => new Promise((resolve) => setImmediate(resolve));
const message = (value) => String(value?.message ?? value ?? '');

for (const scriptPath of scriptPaths) {
  const variant = scriptPath.split('/').pop();
  test(`${variant}: full target comparison rejects another branch with same leaf`, () => {
    const h = load(scriptPath);
    assert.equal(h.api.destinationMatches('全部文件/影视专区/早春 晴朗', ['影视专区', '早春 晴朗']), true);
    assert.equal(h.api.destinationMatches('全部文件/其他/早春 晴朗', ['影视专区', '早春 晴朗']), false);
    assert.equal(h.api.destinationMatches('全部文件/影视专区/早春 晴朗/子目录', ['影视专区', '早春 晴朗']), false);
    assert.equal(h.api.destinationMatches('全部文件', []), true);
  });
  test(`${variant}: path normalization supports root and aliases`, () => {
    const h = load(scriptPath);
    assert.deepEqual(Array.from(h.api.normalizeDestinationPath('/全部文件/影视专区/早春 晴朗')), ['影视专区', '早春 晴朗']);
    assert.deepEqual(Array.from(h.api.normalizeDestinationPath('/我的网盘')), []);
    assert.deepEqual(Array.from(h.api.normalizeDestinationPath('/')), []);
  });
  test(`${variant}: empty target resolves the actual encoded route`, () => {
    const firstFid = '54c5f33ba1994fa8a301af92590b3740';
    const sourceFid = 'c45769107a6a46b1a94f1de12ad217b3';
    const h = load(scriptPath, `#/list/all/${firstFid}-${encodeURIComponent('电视剧📺')}/${sourceFid}-${encodeURIComponent('早春 晴朗-a-b')}`);
    assert.deepEqual(Array.from(h.api.currentFolderDestination(sourceFid)), ['电视剧📺', '早春 晴朗-a-b']);
    h.location.hash = '#/list/all';
    assert.deepEqual(Array.from(h.api.currentFolderDestination('0')), []);
  });
  test(`${variant}: route ambiguity or source directory change aborts resolution`, () => {
    const fid = 'c45769107a6a46b1a94f1de12ad217b3';
    for (const hash of ['#/list/recent', '#/list/video', '#/list/all/not-a-folder', `#/list/all/${fid}-%E0%A4%A`]) {
      const h = load(scriptPath, hash);
      assert.throws(() => h.api.currentFolderDestination(fid), undefined, hash);
    }
    const h = load(scriptPath, `#/list/all/${fid}-有效目录`);
    assert.throws(() => h.api.currentFolderDestination('different-fid'));
  });
  test(`${variant}: ban and permission errors are recognized`, () => {
    const h = load(scriptPath);
    for (const text of ['账号涉嫌违规已被封禁，暂时无法使用该功能 申诉', '暂无权限操作', '解压失败', '压缩包损坏', '需要密码']) {
      assert.ok(h.api.readUnzipPageError(text), text);
    }
    assert.equal(Boolean(h.api.readUnzipPageError('01.zip 正在解压')), false);
  });
  test(`${variant}: waitFor propagates fatal getter errors without polling again`, async () => {
    const h = load(scriptPath);
    let calls = 0;
    const error = new h.api.UnzipPageError('账号已被封禁');
    await assert.rejects(h.api.waitFor(() => { calls += 1; throw error; }, '提交', 30, 1), /封禁/);
    assert.equal(calls, 1);
  });
  test(`${variant}: closing preview alone is not acknowledgement`, async () => {
    const h = load(scriptPath);
    const preview = task(h, '01.zip 解压全部文件', { role: 'dialog' });
    const watcher = h.api.watchUnzipTask('01.zip');
    preview.remove();
    try { await assert.rejects(watcher.waitForAcknowledgement(25), /确认|受理|超时/); }
    finally { watcher.cancel(); }
  });
  test(`${variant}: existing completion and unrelated mutation do not acknowledge submission`, async () => {
    const h = load(scriptPath);
    task(h, '01.zip 解压完成');
    const watcher = h.api.watchUnzipTask('01.zip');
    task(h, '列表已刷新');
    try { await assert.rejects(watcher.waitForAcknowledgement(25), /确认|受理|超时/); }
    finally { watcher.cancel(); }
  });
  test(`${variant}: reinserting an old completion cannot prove this submission`, async () => {
    const h = load(scriptPath);
    const old = task(h, '01.zip 解压完成');
    const watcher = h.api.watchUnzipTask('01.zip');
    old.remove();
    task(h, '01.zip 解压完成');
    await flush();
    try { await assert.rejects(watcher.waitForAcknowledgement(25), /确认|受理|超时/); }
    finally { watcher.cancel(); }
  });
  test(`${variant}: metadata appended to an old completed card is not new completion`, async () => {
    const h = load(scriptPath);
    const old = task(h, '01.zip 解压完成');
    const watcher = h.api.watchUnzipTask('01.zip');
    old.appendChild(h.dom.element('更新于14:45'));
    await flush();
    try {
      await assert.rejects(watcher.waitForAcknowledgement(25), /确认|受理|超时/);
      await assert.rejects(watcher.wait(25), /确认|超时|保留/);
    } finally { watcher.cancel(); }
  });
  test(`${variant}: metadata appended to an old pending card is not acknowledgement`, async () => {
    const h = load(scriptPath);
    const old = task(h, '01.zip 正在解压');
    const watcher = h.api.watchUnzipTask('01.zip');
    old.appendChild(h.dom.element('进度10%'));
    await flush();
    try { await assert.rejects(watcher.waitForAcknowledgement(25), /确认|受理|超时/); }
    finally { watcher.cancel(); }
  });
  test(`${variant}: an unrelated basename completion does not acknowledge`, async () => {
    const h = load(scriptPath);
    const watcher = h.api.watchUnzipTask('01.zip');
    task(h, '01 解压完成');
    task(h, '另一个文件 解压成功');
    await flush();
    try { await assert.rejects(watcher.waitForAcknowledgement(25), /确认|受理|超时/); }
    finally { watcher.cancel(); }
  });
  test(`${variant}: new correlated acceptance and completion resolve the task`, async () => {
    const h = load(scriptPath);
    const watcher = h.api.watchUnzipTask('01.zip');
    task(h, '01.zip 解压任务已提交，已加入队列');
    await flush();
    try {
      await watcher.waitForAcknowledgement(50);
      task(h, '01.zip 解压完成');
      await flush();
      await watcher.wait(50);
    } finally { watcher.cancel(); }
  });
  test(`${variant}: unambiguous new queue acceptance can acknowledge`, async () => {
    const h = load(scriptPath);
    const watcher = h.api.watchUnzipTask('01.zip');
    task(h, '解压任务已提交，已加入队列');
    await flush();
    try { await watcher.waitForAcknowledgement(50); }
    finally { watcher.cancel(); }
  });
  test(`${variant}: a fresh identical generic submission notice acknowledges a later archive`, async () => {
    const h = load(scriptPath);
    task(h, '解压任务已提交，已加入队列');
    const watcher = h.api.watchUnzipTask('02.zip');
    task(h, '解压任务已提交，已加入队列');
    await flush();
    try { await watcher.waitForAcknowledgement(50); }
    finally { watcher.cancel(); }
  });
  test(`${variant}: short basename, different archive, and waiting phrases never complete this archive`, async () => {
    const h = load(scriptPath);
    const watcher = h.api.watchUnzipTask('01.zip');
    for (const text of ['101.zip 解压完成', '01 解压完成', '2026-10-01 解压完成', '101.zip 解压完成 01.zip 正在解压', '01.zip 等待解压完成', '01.zip 正在解压', '01.zip 解压中']) task(h, text);
    await flush();
    try { await assert.rejects(watcher.wait(25), /确认|超时|保留/); }
    finally { watcher.cancel(); }
  });
  test(`${variant}: hidden success and toolbox content are excluded`, async () => {
    const h = load(scriptPath);
    const watcher = h.api.watchUnzipTask('01.zip');
    const hidden = h.dom.element('01.zip 解压完成');
    hidden.style.display = 'none';
    h.dom.document.body.appendChild(hidden);
    const panel = task(h, '', { id: 'codex-quark-batch-rename' });
    panel.appendChild(h.dom.element('01.zip 解压完成'));
    const otherPanel = task(h, '', { id: 'codex-quark-cloud-unzip' });
    otherPanel.appendChild(h.dom.element('01.zip 解压完成'));
    await flush();
    try { await assert.rejects(watcher.wait(25), /确认|超时|保留/); }
    finally { watcher.cancel(); }
  });
  test(`${variant}: stop and fresh ban interrupt completion wait`, async () => {
    const stopped = load(scriptPath);
    const stoppedWatcher = stopped.api.watchUnzipTask('01.zip');
    stopped.api.state.stopRequested = true;
    try { await assert.rejects(stoppedWatcher.wait(100), /停止/); }
    finally { stoppedWatcher.cancel(); }
    const banned = load(scriptPath);
    const bannedWatcher = banned.api.watchUnzipTask('01.zip');
    const started = Date.now();
    const waiting = bannedWatcher.wait(200);
    task(banned, '账号涉嫌违规已被封禁，暂时无法使用该功能');
    try {
      await assert.rejects(waiting, /封禁|无法使用/);
      assert.ok(Date.now() - started < 100, 'ban interrupts immediately, not at timeout');
    } finally { bannedWatcher.cancel(); }
  });
  test(`${variant}: transient ban is latched even if the notice disappears`, async () => {
    const h = load(scriptPath);
    const watcher = h.api.watchUnzipTask('01.zip');
    const ban = task(h, '账号涉嫌违规已被封禁，暂时无法使用该功能');
    await flush();
    ban.remove();
    task(h, '01.zip 解压完成');
    await flush();
    try { await assert.rejects(watcher.waitForAcknowledgement(50), /封禁|无法使用/); }
    finally { watcher.cancel(); }
  });
  test(`${variant}: delete aborts if stop arrives during source lookup`, async () => {
    const h = load(scriptPath, '#/list/all/source-源目录');
    h.ctx.deleteCalls = 0;
    h.evaluate(`findSourceArchive = async () => { state.stopRequested = true; return { fid: 'archive-fid', file_name: '01.zip' }; }; deleteDriveItems = async () => { globalThis.deleteCalls += 1; };`);
    await assert.rejects(h.api.deleteCompletedArchive('01.zip', 'archive-fid', 'source', () => {}), /停止/);
    assert.equal(h.ctx.deleteCalls, 0);
  });
  test(`${variant}: delete aborts on visible ban`, async () => {
    const h = load(scriptPath, '#/list/all/source-源目录');
    task(h, '账号涉嫌违规已被封禁，暂时无法使用该功能');
    h.ctx.deleteCalls = 0;
    h.evaluate(`findSourceArchive = async () => ({ fid: 'archive-fid', file_name: '01.zip' }); deleteDriveItems = async () => { globalThis.deleteCalls += 1; };`);
    await assert.rejects(h.api.deleteCompletedArchive('01.zip', 'archive-fid', 'source', () => {}), /封禁|无法使用/);
    assert.equal(h.ctx.deleteCalls, 0);
  });
  test(`${variant}: a transient ban during source lookup still prevents deletion after completion`, async () => {
    const h = load(scriptPath, '#/list/all/source-源目录');
    const watcher = h.api.watchUnzipTask('01.zip');
    task(h, '01.zip 解压完成');
    await flush();
    await watcher.wait(50);
    h.ctx.deleteCalls = 0;
    h.ctx.lookupWithTransientBan = async () => {
      const ban = task(h, '账号涉嫌违规已被封禁，暂时无法使用该功能');
      await flush();
      ban.remove();
      await flush();
      return { fid: 'archive-fid', file_name: '01.zip' };
    };
    h.evaluate(`findSourceArchive = globalThis.lookupWithTransientBan; deleteDriveItems = async () => { globalThis.deleteCalls += 1; };`);
    try {
      await assert.rejects(h.api.deleteCompletedArchive('01.zip', 'archive-fid', 'source', () => {}, watcher.checkErrors), /封禁|无法使用/);
      assert.equal(h.ctx.deleteCalls, 0);
    } finally { watcher.cancel(); }
  });
  test(`${variant}: delete rejects a replaced file id`, async () => {
    const h = load(scriptPath, '#/list/all/source-源目录');
    h.ctx.deleteCalls = 0;
    h.evaluate(`findSourceArchive = async () => ({ fid: 'different-fid', file_name: '01.zip' }); deleteDriveItems = async () => { globalThis.deleteCalls += 1; };`);
    await assert.rejects(h.api.deleteCompletedArchive('01.zip', 'archive-fid', 'source', () => {}), /ID.*变化|未删除/);
    assert.equal(h.ctx.deleteCalls, 0);
  });
  test(`${variant}: delete confirms removal of the original identified file`, async () => {
    const h = load(scriptPath, '#/list/all/source-源目录');
    h.ctx.deleteCalls = [];
    h.ctx.confirmCalls = [];
    h.evaluate(`findSourceArchive = async () => ({ fid: 'archive-fid', file_name: '01.zip' }); deleteDriveItems = async (fids) => { globalThis.deleteCalls.push(...fids); }; waitUntilItemsMissing = async (parent, fids) => { globalThis.confirmCalls.push(parent, ...fids); };`);
    assert.equal(await h.api.deleteCompletedArchive('01.zip', 'archive-fid', 'source', () => {}), true);
    assert.deepEqual(h.ctx.deleteCalls, ['archive-fid']);
    assert.deepEqual(h.ctx.confirmCalls, ['source', 'archive-fid']);
  });
  const routeCases = [
    { label: 'source path', sourceFid: 'c45769107a6a46b1a94f1de12ad217b3', hash: `#/list/all/54c5f33ba1994fa8a301af92590b3740-${encodeURIComponent('影视专区')}/c45769107a6a46b1a94f1de12ad217b3-${encodeURIComponent('早春 晴朗')}`, initial: '全部文件/夸克云解压', expected: '全部文件/影视专区/早春 晴朗' },
    { label: 'root with empty preview target', sourceFid: '0', hash: '#/list/all', initial: '', expected: '全部文件' },
  ];
  for (const routeCase of routeCases) test(`${variant}: processArchive selects ${routeCase.label}`, async () => {
    const { sourceFid } = routeCase;
    const h = load(scriptPath, routeCase.hash);
    h.ctx.archiveElement = h.dom.element('01.zip');
    h.ctx.archiveDialog = h.dom.element('01.zip 解压全部文件');
    h.ctx.destinationDialog = h.dom.element('解压到 新建文件夹 确认');
    h.ctx.change = h.dom.element('更改');
    h.ctx.submit = h.dom.element('解压全部文件');
    h.ctx.currentTarget = routeCase.initial;
    h.ctx.selectedPaths = [];
    h.ctx.submitClicks = 0;
    h.ctx.emitAcceptance = () => task(h, '01.zip 解压任务已提交，已加入队列');
    h.evaluate(`
      findArchiveNameElement = () => globalThis.archiveElement;
      doubleClickElement = () => {};
      findArchiveDialog = () => globalThis.archiveDialog;
      readArchiveTargetLabel = () => globalThis.currentTarget;
      findExactText = () => globalThis.change;
      findDestinationDialog = () => globalThis.destinationDialog;
      locateDestination = async (_dialog, path) => { globalThis.selectedPaths.push(path); return { item: { chosenPath: path } }; };
      selectDestination = async (_dialog, item) => { globalThis.currentTarget = item.chosenPath; };
      findButton = () => globalThis.submit;
      clickElement = (node) => { if (node === globalThis.submit) { globalThis.submitClicks += 1; globalThis.emitAcceptance(); } };
    `);
    const result = await h.api.processArchive('01.zip', '', new Set(), false, false, sourceFid, () => {});
    assert.equal(result.status, 'submitted');
    assert.equal(result.deleted, false);
    assert.deepEqual(h.ctx.selectedPaths, [routeCase.expected]);
    assert.equal(h.ctx.submitClicks, 1);
    assert.equal(h.ctx.currentTarget, routeCase.expected);
  });
}

module.exports = { load, task, flush, scriptPaths, message };
