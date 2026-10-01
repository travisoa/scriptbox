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
      if (record.type === 'attributes' && (!observer.options.attributes ||
        (observer.options.attributeFilter && !observer.options.attributeFilter.includes(record.attributeName)))) continue;
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
      this.style = new Proxy({ display: '', visibility: '', opacity: '' }, {
        set: (style, key, value) => {
          const oldValue = style[key];
          style[key] = String(value);
          if (oldValue !== style[key]) queueMutation({ type: 'attributes', target: this, attributeName: 'style' });
          return true;
        },
      });
      this.rect = null;
      this.hidden = false;
      this.dataset = {};
      this.classList = { contains: (value) => (this.attrs.class || '').split(/\s+/).includes(value) };
      this.offsetWidth = 100;
      this.offsetHeight = 20;
      this.clientWidth = 1280;
      this.clientHeight = 800;
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
    setAttribute(key, value) {
      const oldValue = this.getAttribute(key);
      this.attrs[key] = String(value);
      if (key === 'style') for (const declaration of String(value).split(';')) {
        const [property, ...rest] = declaration.split(':');
        if (rest.length) this.style[property.trim().replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = rest.join(':').trim();
      }
      if (oldValue !== this.attrs[key]) queueMutation({ type: 'attributes', target: this, attributeName: key, oldValue });
    }
    removeAttribute(key) {
      const oldValue = this.getAttribute(key);
      if (oldValue === null) return;
      delete this.attrs[key];
      queueMutation({ type: 'attributes', target: this, attributeName: key, oldValue });
    }
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
        for (const match of s.matchAll(/\[([^=~^$*\]\s]+)(?:([*^$~]?=)['"]?([^'"\]]+)['"]?)?\]/g)) {
          const value = this.getAttribute(match[1]);
          if (value === null) return false;
          const expected = match[3];
          if (match[2] === '=' && value !== expected) return false;
          if (match[2] === '*=' && !value.includes(expected)) return false;
          if (match[2] === '^=' && !value.startsWith(expected)) return false;
          if (match[2] === '$=' && !value.endsWith(expected)) return false;
          if (match[2] === '~=' && !value.split(/\s+/).includes(expected)) return false;
        }
        return Boolean(tag || classes.length || s.includes('['));
      });
    }
    closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
    querySelectorAll(selector) { return descendants(this).filter((node) => node.nodeType === 1 && node.matches(selector)); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    getClientRects() {
      const rect = this.getBoundingClientRect();
      return rect.width && rect.height ? [rect] : [];
    }
    getBoundingClientRect() {
      for (let node = this; node; node = node.parentElement) {
        if (node.hidden || node.style.display === 'none') return { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };
      }
      let positioned = this;
      while (positioned && !positioned.rect) positioned = positioned.parentElement;
      const raw = positioned?.rect || { x: 20, y: 100, width: 100, height: 20 };
      return { ...raw, left: raw.x, top: raw.y, right: raw.x + raw.width, bottom: raw.y + raw.height };
    }
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
    getComputedStyle: (node) => {
      let visibility = '';
      for (let parent = node; parent && !visibility; parent = parent.parentElement) visibility = parent.style.visibility;
      return { display: node.hidden ? 'none' : node.style.display || 'block', visibility: visibility || 'visible', opacity: node.style.opacity === '' ? (node.classList.contains('MessageUserLimit--out-screen--TFf6L-d') ? '0' : '1') : String(node.style.opacity) };
    },
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
    window: { confirm: () => true, innerWidth: 1280, innerHeight: 800 },
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

const banText = '账号涉嫌违规已被封禁，暂时无法使用该功能 申诉';

function nestedNotice(h, kind = 'visible', text = banText) {
  const wrapper = h.dom.document.createElement('div');
  wrapper.setAttribute('class', 'MessageUserLimit--message-wrap--SDEytO2');
  const span = h.dom.document.createElement('span');
  span.textContent = text;
  wrapper.appendChild(span);
  if (kind === 'opacity0') wrapper.style.opacity = '0';
  if (kind === 'classHidden') wrapper.setAttribute('class', 'MessageUserLimit--message-wrap--SDEytO2 MessageUserLimit--out-screen--TFf6L-d');
  if (kind === 'ariaHidden') wrapper.setAttribute('aria-hidden', 'true');
  if (kind === 'displayNone') wrapper.style.display = 'none';
  if (kind === 'visibilityCollapse') wrapper.style.visibility = 'collapse';
  if (kind === 'visibilityHidden') wrapper.style.visibility = 'hidden';
  if (kind === 'offscreenOpacity0') {
    wrapper.setAttribute('class', 'MessageUserLimit--message-wrap--SDEytO2 MessageUserLimit--out-screen--TFf6L-d');
    wrapper.style.opacity = '0';
    wrapper.rect = { x: 400, y: -66, width: 300, height: 72 };
    span.rect = { x: 412, y: -52, width: 250, height: 20 };
  }
  h.dom.document.body.appendChild(wrapper);
  return wrapper;
}

for (const scriptPath of scriptPaths) {
  const variant = scriptPath.split('/').pop();
  for (const kind of ['opacity0', 'ariaHidden', 'displayNone', 'visibilityCollapse', 'visibilityHidden', 'offscreenOpacity0']) {
    test(`${variant}: existing ban under ${kind} parent does not block normal locator`, async () => {
      const h = load(scriptPath);
      nestedNotice(h, kind);
      assert.equal(await h.api.waitFor(() => 'ready', '定位文件', 20, 1), 'ready');
    });
    test(`${variant}: fresh ban under ${kind} parent is not latched`, async () => {
      const h = load(scriptPath);
      const watcher = h.api.watchUnzipTask('01.zip');
      nestedNotice(h, kind);
      await flush();
      try { assert.doesNotThrow(() => watcher.checkErrors()); }
      finally { watcher.cancel(); }
    });
  }
  test(`${variant}: visible native account restriction notification blocks locator`, async () => {
    const h = load(scriptPath);
    nestedNotice(h);
    await assert.rejects(h.api.waitFor(() => 'ready', '定位文件', 20, 1), /封禁|无法使用/);
  });
  test(`${variant}: fresh visible native account restriction remains latched after disappearing`, async () => {
    const h = load(scriptPath);
    const watcher = h.api.watchUnzipTask('01.zip');
    const notice = nestedNotice(h);
    await flush();
    notice.remove();
    await flush();
    try { assert.throws(() => watcher.checkErrors(), /封禁|无法使用/); }
    finally { watcher.cancel(); }
  });

  for (const attributeKind of ['class', 'style']) {
    test(`${variant}: existing hidden notice revealed by ${attributeKind} is detected and latched`, async () => {
      const h = load(scriptPath);
      const notice = nestedNotice(h, attributeKind === 'class' ? 'classHidden' : 'opacity0');
      const watcher = h.api.watchUnzipTask('01.zip');
      try {
        assert.doesNotThrow(() => watcher.checkErrors(), 'hidden notice must initially be ignored');
        if (attributeKind === 'class') notice.setAttribute('class', 'MessageUserLimit--message-wrap--SDEytO2');
        else notice.style.opacity = '1';
        await flush();
        notice.remove();
        await flush();
        assert.throws(() => watcher.checkErrors(), /封禁|无法使用/, 'newly shown real notice must remain latched after removal');
      } finally { watcher.cancel(); }
    });
  }
  test(`${variant}: archive filename with error words is not an operation error`, async () => {
    const h = load(scriptPath);
    const row = h.dom.document.createElement('div');
    row.setAttribute('role', 'row');
    row.appendChild(h.dom.element('解压失败原因说明.zip', { class: 'file-name' }));
    h.dom.document.body.appendChild(row);
    assert.equal(await h.api.waitFor(() => 'ready', '定位文件', 20, 1), 'ready');
  });
  test(`${variant}: old error of another archive does not block current task`, async () => {
    const h = load(scriptPath);
    task(h, '99.zip 解压失败');
    const watcher = h.api.watchUnzipTask('01.zip');
    try { assert.doesNotThrow(() => watcher.checkErrors()); }
    finally { watcher.cancel(); }
  });
  test(`${variant}: fresh error of another archive does not block current task`, async () => {
    const h = load(scriptPath);
    const watcher = h.api.watchUnzipTask('01.zip');
    const unrelated = task(h, '999.zip 压缩包损坏');
    unrelated.style.opacity = '0';
    await flush();
    unrelated.style.opacity = '1';
    await flush();
    try { assert.doesNotThrow(() => watcher.checkErrors()); }
    finally { watcher.cancel(); }
  });
  test(`${variant}: metadata mutation of old other-archive error does not latch it`, async () => {
    const h = load(scriptPath);
    const old = task(h, '99.zip 解压失败');
    const watcher = h.api.watchUnzipTask('01.zip');
    old.appendChild(h.dom.element('更新于15:00'));
    await flush();
    old.remove();
    await flush();
    try { assert.doesNotThrow(() => watcher.checkErrors()); }
    finally { watcher.cancel(); }
  });

  test(`${variant}: completion of Chinese-prefixed archive does not acknowledge numeric archive`, async () => {
    const h = load(scriptPath);
    const watcher = h.api.watchUnzipTask('01.zip');
    task(h, '前缀01.zip 解压完成');
    await flush();
    try { await assert.rejects(watcher.waitForAcknowledgement(25), /确认|受理|超时/); }
    finally { watcher.cancel(); }
  });
  test(`${variant}: error of Chinese-prefixed archive does not block numeric archive`, async () => {
    const h = load(scriptPath);
    const watcher = h.api.watchUnzipTask('01.zip');
    task(h, '前缀01.zip 压缩包损坏');
    await flush();
    try { assert.doesNotThrow(() => watcher.checkErrors()); }
    finally { watcher.cancel(); }
  });
  test(`${variant}: correlated fresh current-archive error blocks current task`, async () => {
    const h = load(scriptPath);
    const watcher = h.api.watchUnzipTask('01.zip');
    task(h, '01.zip 压缩包损坏');
    await flush();
    try { assert.throws(() => watcher.checkErrors(), /损坏/); }
    finally { watcher.cancel(); }
  });
}

module.exports = { load, task, flush, scriptPaths, message, nestedNotice };
