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
      return { overflowY: node.style.overflowY || 'visible', display: node.hidden ? 'none' : node.style.display || 'block', visibility: visibility || 'visible', opacity: node.style.opacity === '' ? (node.classList.contains('MessageUserLimit--out-screen--TFf6L-d') ? '0' : '1') : String(node.style.opacity) };
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
    'destinationMatchesAfterSelection', 'readTreeTargetSegments', 'selectDestination', 'locateDestination',
    'listArchiveNames', 'locateArchiveNameElement', 'findArchiveNameElement',
    'readUnzipPageError', 'watchUnzipTask', 'waitFor', 'deleteCompletedArchive',
    'processArchive', 'state', 'StopRequestedError', 'UnzipPageError',
  ];
  vm.runInContext(source.slice(strictIndex, bootIndex) + '\nglobalThis.api = {' + names.join(',') + '};', ctx, { filename: scriptPath });
  return { api: ctx.api, dom, location, ctx, evaluate: (code) => vm.runInContext(code, ctx) };
}

const task = (h, text, attrs = {}) => h.dom.document.body.appendChild(h.dom.element(text, { class: 'ant-message-notice-content', ...attrs }));
function completedNativeTask(h) {
  const element = h.dom.document.createElement('div');
  element.setAttribute('class', 'decompressing');
  const tips = h.dom.document.createElement('div');
  tips.setAttribute('class', 'progress-tips');
  tips.textContent = '文件解压成功100%';
  element.appendChild(tips);
  const close = h.dom.document.createElement('div');
  close.setAttribute('class', 'decompressing-close');
  close.onClick = () => element.remove();
  element.appendChild(close);
  h.dom.document.body.appendChild(element);
  return element;
}

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
    const firstFid = '11111111111111111111111111111111';
    const sourceFid = '22222222222222222222222222222222';
    const h = load(scriptPath, `#/list/all/${firstFid}-${encodeURIComponent('电视剧📺')}/${sourceFid}-${encodeURIComponent('早春 晴朗-a-b')}`);
    assert.deepEqual(Array.from(h.api.currentFolderDestination(sourceFid)), ['电视剧📺', '早春 晴朗-a-b']);
    h.location.hash = '#/list/all';
    assert.deepEqual(Array.from(h.api.currentFolderDestination('0')), []);
  });
  test(`${variant}: route ambiguity or source directory change aborts resolution`, () => {
    const fid = '22222222222222222222222222222222';
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
  test(`${variant}: processArchive accepts observed abbreviation only after full tree selection`, async () => {
    const fid = '33333333333333333333333333333333';
    const segments = ['影视专区', '电视剧📺', '早春晴朗', '4K DV 60帧率 高码率'];
    const h = load(scriptPath, '#/list/all/' + segments.map((segment, i) =>
      `${i === segments.length - 1 ? fid : 'a'.repeat(32)}-${encodeURIComponent(segment)}`).join('/'));
    h.ctx.archiveElement = h.dom.element('01.zip');
    h.ctx.archiveDialog = h.dom.element('01.zip 解压全部文件');
    h.ctx.destinationDialog = h.dom.element('解压到 新建文件夹 确认');
    h.ctx.change = h.dom.element('更改');
    h.ctx.submit = h.dom.element('解压全部文件');
    h.ctx.currentTarget = '我的网盘/... /电视剧📺/早春晴朗/4K DV 60帧率 高码率';
    h.ctx.selectCalls = 0;
    h.ctx.submitClicks = 0;
    h.ctx.emitAcceptance = () => completedNativeTask(h);
    h.evaluate(`
      findArchiveNameElement = () => globalThis.archiveElement;
      doubleClickElement = () => {};
      findArchiveDialog = () => globalThis.archiveDialog;
      readArchiveTargetLabel = () => globalThis.currentTarget;
      findExactText = () => globalThis.change;
      findDestinationDialog = () => globalThis.destinationDialog;
      locateDestination = async () => ({ item: {} });
      selectDestination = async (_dialog, _item, expected) => { globalThis.selectCalls += 1; return expected.slice(); };
      findButton = () => globalThis.submit;
      clickElement = (node) => { if (node === globalThis.submit) { globalThis.submitClicks += 1; globalThis.emitAcceptance(); } else node.click(); };
    `);
    const result = await h.api.processArchive('01.zip', '', new Set(), false, false, fid, () => {});
    assert.equal(result.status, 'submitted');
    assert.equal(h.ctx.selectCalls, 1, 'an abbreviated initial label must force a fresh complete selection');
    assert.equal(h.ctx.submitClicks, 1);
  });

  const routeCases = [
    { label: 'source path', sourceFid: '22222222222222222222222222222222', hash: `#/list/all/11111111111111111111111111111111-${encodeURIComponent('影视专区')}/22222222222222222222222222222222-${encodeURIComponent('早春 晴朗')}`, initial: '全部文件/夸克云解压', expected: '全部文件/影视专区/早春 晴朗' },
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
    h.ctx.emitAcceptance = () => completedNativeTask(h);
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
      clickElement = (node) => { if (node === globalThis.submit) { globalThis.submitClicks += 1; globalThis.emitAcceptance(); } else node.click(); };
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

for (const scriptPath of scriptPaths) {
  const variant = scriptPath.split('/').pop();
const targetSegments = ['影视专区', '电视剧📺', '早春晴朗', '4K DV 60帧率 高码率'];
const targetCases = [
  {
    label: 'observed shortened path is accepted with proof of full selection',
    text: '我的网盘/... /电视剧📺/早春晴朗/4K DV 60帧率 高码率',
    expected: targetSegments, proof: targetSegments, matches: true,
  },
  {
    label: 'unicode ellipsis and root alias are accepted with exact proof',
    text: '全部文件/…/电视剧📺/早春晴朗/4K DV 60帧率 高码率',
    expected: targetSegments, proof: targetSegments, matches: true,
  },
  {
    label: 'abbreviated path without selection proof is rejected',
    text: '我的网盘/.../电视剧📺/早春晴朗/4K DV 60帧率 高码率',
    expected: targetSegments, proof: undefined, matches: false,
  },
  {
    label: 'abbreviated path with empty selection proof is rejected',
    text: '我的网盘/.../电视剧📺/早春晴朗/4K DV 60帧率 高码率',
    expected: targetSegments, proof: [], matches: false,
  },
  {
    label: 'visible wrong ancestor cannot be hidden by same leaf',
    text: '我的网盘/其他/.../早春晴朗/4K DV 60帧率 高码率',
    expected: targetSegments, proof: targetSegments, matches: false,
  },
  {
    label: 'proof from another ancestor with same leaf is rejected',
    text: '我的网盘/.../早春晴朗/4K DV 60帧率 高码率',
    expected: targetSegments, proof: ['其他', '电视剧📺', '早春晴朗', '4K DV 60帧率 高码率'], matches: false,
  },
  {
    label: 'multiple ellipsis segments are rejected',
    text: '我的网盘/.../电视剧📺/…/4K DV 60帧率 高码率',
    expected: targetSegments, proof: targetSegments, matches: false,
  },
  {
    label: 'four dots are not an ellipsis directory marker',
    text: '我的网盘/..../电视剧📺/早春晴朗/4K DV 60帧率 高码率',
    expected: targetSegments, proof: targetSegments, matches: false,
  },
  {
    label: 'spaced dots are not an ellipsis directory marker',
    text: '我的网盘/. . ./电视剧📺/早春晴朗/4K DV 60帧率 高码率',
    expected: targetSegments, proof: targetSegments, matches: false,
  },
  {
    label: 'embedded dots in ordinary folder name are not a wildcard',
    text: '我的网盘/影视.../电视剧📺/早春晴朗/4K DV 60帧率 高码率',
    expected: targetSegments, proof: targetSegments, matches: false,
  },
  {
    label: 'ellipsis must omit at least one complete directory',
    text: '我的网盘/影视专区/.../电视剧📺/早春晴朗/4K DV 60帧率 高码率',
    expected: targetSegments, proof: targetSegments, matches: false,
  },
  {
    label: 'leaf directory cannot itself be omitted',
    text: '我的网盘/影视专区/电视剧📺/早春晴朗/...',
    expected: targetSegments, proof: targetSegments, matches: false,
  },
  {
    label: 'full conflicting path is rejected even with correct proof',
    text: '我的网盘/其他/电视剧📺/早春晴朗/4K DV 60帧率 高码率',
    expected: targetSegments, proof: targetSegments, matches: false,
  },
  {
    label: 'exact full path remains valid without proof',
    text: '我的网盘/影视专区/电视剧📺/早春晴朗/4K DV 60帧率 高码率',
    expected: targetSegments, proof: undefined, matches: true,
  },
  {
    label: 'exact root remains valid without proof',
    text: '我的网盘', expected: [], proof: undefined, matches: true,
  },
  {
    label: 'abbreviation cannot turn root into a folder target',
    text: '我的网盘/...', expected: [], proof: [], matches: false,
  },
  {
    label: 'emoji and internal spaces in visible suffix must match',
    text: '我的网盘/.../电视剧📺/早春晴朗/4KDV60帧率高码率',
    expected: targetSegments, proof: targetSegments, matches: false,
  },
  {
    label: 'wrong emoji in suffix is rejected',
    text: '我的网盘/.../电视剧🎬/早春晴朗/4K DV 60帧率 高码率',
    expected: targetSegments, proof: targetSegments, matches: false,
  },
];

for (const targetCase of targetCases) test(`${variant}: ${targetCase.label}`, () => {
  const h = load(scriptPath);
  assert.equal(h.api.destinationMatchesAfterSelection(targetCase.text, targetCase.expected, targetCase.proof), targetCase.matches);
});

// Patch only :scope > queries on fixture nodes. The shared lightweight selector
// matcher otherwise treats them as descendant selectors and cannot distinguish
// the proper root/parent branch from a nested node with the same title.
function targetFixtureNode(h, tag = 'div', text = '', attrs = {}) {
  const node = h.dom.document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  node.textContent = text;
  const fallbackQueryAll = node.querySelectorAll.bind(node);
  node.querySelectorAll = (selector) => {
    const results = [];
    for (const clause of selector.split(',')) {
      const trimmed = clause.trim();
      if (!trimmed.startsWith(':scope > ')) { results.push(...fallbackQueryAll(trimmed)); continue; }
      const rest = trimmed.slice(':scope > '.length);
      const firstSpace = rest.search(/\s/);
      const first = firstSpace < 0 ? rest : rest.slice(0, firstSpace);
      const tail = firstSpace < 0 ? '' : rest.slice(firstSpace).trim();
      for (const child of node.children.filter((candidate) => candidate.matches(first))) {
        if (!tail) results.push(child);
        else if (tail.startsWith('> ')) results.push(...child.querySelectorAll(':scope ' + tail));
        else results.push(...child.querySelectorAll(tail));
      }
    }
    return [...new Set(results)];
  };
  node.querySelector = (selector) => node.querySelectorAll(selector)[0] || null;
  return node;
}

function buildTargetFixture(h, segments, rootName = '全部文件') {
  const dialog = targetFixtureNode(h, 'div', '', { role: 'dialog' });
  dialog.appendChild(targetFixtureNode(h, 'div', '解压到 新建文件夹'));
  const tree = dialog.appendChild(targetFixtureNode(h, 'ul', '', { role: 'tree' }));
  const items = [];
  const titles = [];
  const contents = [];
  let group = tree;
  for (const name of [rootName, ...segments]) {
    const item = group.appendChild(targetFixtureNode(h, 'li', '', { role: 'treeitem', class: 'ant-tree-treenode-switcher-open' }));
    const content = item.appendChild(targetFixtureNode(h, 'span', '', { class: 'ant-tree-node-content-wrapper' }));
    const title = content.appendChild(targetFixtureNode(h, 'span', name, { class: 'ant-tree-title' }));
    content.onClick = () => item.setAttribute('class', 'ant-tree-treenode-switcher-open ant-tree-treenode-selected');
    group = item.appendChild(targetFixtureNode(h, 'ul', '', { role: 'group', class: 'ant-tree-child-tree' }));
    items.push(item); titles.push(title); contents.push(content);
  }
  const confirm = dialog.appendChild(targetFixtureNode(h, 'button', '确认'));
  const result = { dialog, tree, items, titles, contents, item: items.at(-1), confirm, confirmClicks: 0 };
  confirm.onClick = () => { result.confirmClicks += 1; dialog.remove(); };
  h.dom.document.body.appendChild(dialog);
  return result;
}

function targetImmediateWait(h) {
  // Retain selection predicates but avoid spending a real 15 seconds proving
  // that deliberately wrong selected state never becomes correct.
  h.evaluate(`waitFor = async (getter, label) => { const value = getter(); if (!value) throw new Error(label + ' failed'); return value; };`);
}

test(`${variant}: selected node yields the complete path from the proper visible root`, () => {
  const h = load(scriptPath);
  const f = buildTargetFixture(h, targetSegments);
  assert.deepEqual(Array.from(h.api.readTreeTargetSegments(f.dialog, f.item)), targetSegments);
});

test(`${variant}: root selected node yields empty target segments`, () => {
  const h = load(scriptPath);
  const f = buildTargetFixture(h, []);
  assert.deepEqual(Array.from(h.api.readTreeTargetSegments(f.dialog, f.item)), []);
});

test(`${variant}: node outside the expected dialog cannot prove selection`, () => {
  const h = load(scriptPath);
  const f = buildTargetFixture(h, targetSegments);
  const other = buildTargetFixture(h, targetSegments);
  assert.throws(() => h.api.readTreeTargetSegments(f.dialog, other.item));
});

test(`${variant}: wrong root name cannot prove target path`, () => {
  const h = load(scriptPath);
  const f = buildTargetFixture(h, targetSegments, '其他文件');
  assert.throws(() => h.api.readTreeTargetSegments(f.dialog, f.item));
});

test(`${variant}: hidden ancestor cannot prove a visible target path`, () => {
  const h = load(scriptPath);
  const f = buildTargetFixture(h, targetSegments);
  f.items[1].style.opacity = '0';
  assert.throws(() => h.api.readTreeTargetSegments(f.dialog, f.item));
});


test(`${variant}: invisible tree title alone cannot prove target path`, () => {
  const h = load(scriptPath);
  const f = buildTargetFixture(h, targetSegments);
  f.titles[1].style.opacity = '0';
  assert.throws(() => h.api.readTreeTargetSegments(f.dialog, f.item));
});

test(`${variant}: hidden child text inside a visible title cannot prove the requested directory`, () => {
  const h = load(scriptPath);
  const f = buildTargetFixture(h, targetSegments);
  const title = f.titles[1];
  title.textContent = '';
  const hidden = title.appendChild(targetFixtureNode(h, 'span', targetSegments[0]));
  hidden.style.opacity = '0';
  assert.throws(() => h.api.readTreeTargetSegments(f.dialog, f.item));
});

test(`${variant}: hidden full-path title cannot repair an incorrectly named ancestor`, () => {
  const h = load(scriptPath);
  const f = buildTargetFixture(h, ['其他', ...targetSegments.slice(1)]);
  const hidden = targetFixtureNode(h, 'span', targetSegments[0], { class: 'ant-tree-title', title: '全部文件/' + targetSegments.join('/') });
  hidden.style.opacity = '0';
  f.contents[1].appendChild(hidden);
  targetImmediateWait(h);
  return assert.rejects(h.api.selectDestination(f.dialog, f.item, targetSegments));
});

test(`${variant}: selection rejects another ancestor with the same final folder name`, async () => {
  const h = load(scriptPath);
  const f = buildTargetFixture(h, ['其他', ...targetSegments.slice(1)]);
  targetImmediateWait(h);
  await assert.rejects(h.api.selectDestination(f.dialog, f.item, targetSegments));
  assert.equal(f.confirmClicks, 0);
});

test(`${variant}: correct selection returns complete path proof only after confirmation`, async () => {
  const h = load(scriptPath);
  const f = buildTargetFixture(h, targetSegments);
  targetImmediateWait(h);
  const proof = await h.api.selectDestination(f.dialog, f.item, targetSegments);
  assert.deepEqual(Array.from(proof), targetSegments);
  assert.equal(f.confirmClicks, 1);
});

test(`${variant}: selection that activates a different node is never confirmed`, async () => {
  const h = load(scriptPath);
  const f = buildTargetFixture(h, targetSegments);
  f.contents.at(-1).onClick = () => f.items[0].setAttribute('class', 'ant-tree-treenode-selected');
  targetImmediateWait(h);
  await assert.rejects(h.api.selectDestination(f.dialog, f.item, targetSegments));
  assert.equal(f.confirmClicks, 0);
});

// Insert INSIDE the existing target-tree `for (const scriptPath of scriptPaths)`
// block, where targetSegments, targetFixtureNode and buildTargetFixture exist.
// These retain the real waitFor and locateDestination implementations. Only the
// deliberately wrong-root case caps the real wait's deadline to avoid 15 s.

test(`${variant}: destination waits for asynchronous tree/root loading and visible root titles`, async () => {
  for (const mode of ['treeLate', 'rootLate', 'rootOpacityReveal', 'titleOpacityReveal']) {
    const h = load(scriptPath);
    h.evaluate(`Object.assign(globalThis.api, { locateDestination });`);
    const f = buildTargetFixture(h, targetSegments);
    const root = f.items[0];
    if (mode === 'treeLate') f.tree.remove();
    if (mode === 'rootLate') root.remove();
    if (mode === 'rootOpacityReveal') root.style.opacity = '0';
    if (mode === 'titleOpacityReveal') f.titles[0].style.opacity = '0';
    let revealed = false;
    const reveal = setTimeout(() => {
      revealed = true;
      if (mode === 'treeLate') f.dialog.appendChild(f.tree);
      if (mode === 'rootLate') f.tree.appendChild(root);
      if (mode === 'rootOpacityReveal') root.style.opacity = '1';
      if (mode === 'titleOpacityReveal') f.titles[0].style.opacity = '1';
    }, 10);
    try {
      const result = await h.api.locateDestination(f.dialog, '全部文件/' + targetSegments.join('/'));
      assert.equal(revealed, true, mode + ': resolution must wait for the visible root');
      assert.equal(result.item, f.item, mode);
      assert.deepEqual(Array.from(result.segments), targetSegments, mode);
      assert.equal(f.confirmClicks, 0, 'locating the destination does not confirm or submit it');
    } finally { clearTimeout(reveal); }
  }
});

test(`${variant}: wrong root times out without confirming another root`, async () => {
  const h = load(scriptPath);
  h.evaluate(`
    Object.assign(globalThis.api, { locateDestination });
    const actualWaitForWrongRootTest = waitFor;
    waitFor = (getter, label, timeout = 15000, interval = 250, archiveName = '') =>
      actualWaitForWrongRootTest(getter, label, Math.min(timeout, 40), Math.min(interval, 2), archiveName);
  `);
  const f = buildTargetFixture(h, targetSegments, '错误根目录');
  await assert.rejects(h.api.locateDestination(f.dialog, '全部文件/' + targetSegments.join('/')), /超时/);
  assert.equal(f.confirmClicks, 0);
  assert.equal(f.item.classList.contains('ant-tree-treenode-selected'), false);
});

test(`${variant}: stop during asynchronous root loading interrupts the real wait immediately`, async () => {
  const h = load(scriptPath);
  h.evaluate(`Object.assign(globalThis.api, { locateDestination });`);
  const f = buildTargetFixture(h, targetSegments);
  f.items[0].remove();
  const started = Date.now();
  const stop = setTimeout(() => { h.api.state.stopRequested = true; }, 10);
  try {
    await assert.rejects(h.api.locateDestination(f.dialog, '全部文件/' + targetSegments.join('/')), /停止/);
    assert.ok(Date.now() - started < 500, 'stop must not wait for the 15 s root-load timeout');
    assert.equal(f.confirmClicks, 0);
    assert.equal(f.item.classList.contains('ant-tree-treenode-selected'), false);
  } finally { clearTimeout(stop); }
});

test(`${variant}: changed ancestor after selection click invalidates path proof`, async () => {
  const h = load(scriptPath);
  const f = buildTargetFixture(h, targetSegments);
  f.contents.at(-1).onClick = () => {
    f.item.setAttribute('class', 'ant-tree-treenode-selected');
    f.titles[1].textContent = '其他';
  };
  targetImmediateWait(h);
  await assert.rejects(h.api.selectDestination(f.dialog, f.item, targetSegments));
  assert.equal(f.confirmClicks, 0);
});

}

// These exercise the shipped processArchive and its real watcher/modal helpers.
// Quark accepts each request but leaves the preview open until its close button
// is clicked. The task completes through native progress and automatic deletion is off.
function batchPreviewFixture(scriptPath, closeMode = 'normal') {
  const h = load(scriptPath);
  const opened = [];
  const submitted = [];
  const closed = [];
  const table = h.dom.document.createElement('table');
  h.dom.document.body.appendChild(table);

  // Bound only DOM-helper timeouts; retain the real polling, stop and error logic.
  h.evaluate(`
    const originalWaitForBatchPreviewTest = waitFor;
    waitFor = (getter, label, timeout = 15000, interval = 250, archiveName = '') =>
      originalWaitForBatchPreviewTest(getter, label, Math.min(timeout, 40), Math.min(interval, 2), archiveName);
  `);

  for (const archiveName of ['01.zip', '02.zip']) {
    const row = h.dom.document.createElement('tr');
    const filename = h.dom.document.createElement('span');
    filename.textContent = archiveName;
    row.appendChild(filename);
    table.appendChild(row);
    filename.onDoubleClick = () => {
      assert.equal(h.dom.document.querySelector('[role="dialog"]'), null,
        'the previous archive preview must close before opening the next archive');
      opened.push(archiveName);
      const dialog = h.dom.document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.appendChild(h.dom.element(`${archiveName} 解压到全部文件更改`));
      const submit = h.dom.document.createElement('button');
      submit.textContent = '解压全部文件';
      submit.onClick = () => {
        submitted.push(archiveName);
        completedNativeTask(h);
        // Deliberately leave the preview mounted and visible after acceptance.
      };
      dialog.appendChild(submit);
      const close = h.dom.document.createElement('button');
      close.setAttribute('aria-label', 'Close');
      close.textContent = '关闭';
      close.onClick = () => {
        closed.push(archiveName);
        if (closeMode === 'stop') h.api.state.stopRequested = true;
        if (closeMode !== 'failedClose') dialog.remove();
      };
      dialog.appendChild(close);
      h.dom.document.body.appendChild(dialog);
    };
  }
  return { h, opened, submitted, closed };
}

for (const scriptPath of scriptPaths) {
  const variant = scriptPath.split('/').pop();
  test(`${variant}: two accepted archives close retained previews and continue in order`, async () => {
    const fixture = batchPreviewFixture(scriptPath);
    const { h } = fixture;
    const knownExisting = new Set();
    for (const archiveName of ['01.zip', '02.zip']) {
      const result = await h.api.processArchive(archiveName, '', knownExisting, false, false, '0', () => {});
      assert.equal(result.status, 'submitted');
      assert.equal(result.deleted, false);
    }
    assert.deepEqual(fixture.opened, ['01.zip', '02.zip']);
    assert.deepEqual(fixture.submitted, ['01.zip', '02.zip']);
    assert.deepEqual(fixture.closed, ['01.zip', '02.zip']);
    assert.equal(h.dom.document.querySelector('[role="dialog"]'), null);
  });

  test(`${variant}: stop or failed preview close preserves submission evidence and prevents the next archive`, async () => {
    for (const closeMode of ['stop', 'failedClose']) {
      const fixture = batchPreviewFixture(scriptPath, closeMode);
      const { h } = fixture;
      const knownExisting = new Set();
      const runBatch = async () => {
        for (const archiveName of ['01.zip', '02.zip']) {
          await h.api.processArchive(archiveName, '', knownExisting, false, false, '0', () => {});
        }
      };
      await assert.rejects(runBatch(), (error) => {
        assert.equal(error.archiveSubmitted, true, `${closeMode}: the first request was already accepted`);
        assert.match(error.message, closeMode === 'stop' ? /停止/ : /超时|关闭|预览/);
        return true;
      });
      assert.deepEqual(fixture.opened, ['01.zip'], closeMode);
      assert.deepEqual(fixture.submitted, ['01.zip'], closeMode);
      assert.deepEqual(fixture.closed, ['01.zip'], closeMode);
    }
  });
}

// Directory API and virtual scrolling stay within the fake VM.
function virtualArchiveFixture(scriptPath, options = {}) {
  const h = load(scriptPath);
  h.evaluate(`Object.assign(globalThis.api, { listArchiveNames, locateArchiveNameElement, findArchiveNameElement });`);
  const names = Array.from({ length: 24 }, (_, index) => `${String(index + 1).padStart(2, '0')}.zip`);
  const apiItems = names.map((file_name, index) => ({ fid: `archive-${index + 1}`, file_name, file_type: 1, parent_fid: '0' }));
  const opened = [];
  const submitted = [];
  const scrolls = [];
  const container = h.dom.document.createElement('div');
  container.setAttribute('class', 'ant-table-body');
  container.style.overflowY = 'auto';
  container.clientHeight = 380;
  container.scrollHeight = 480;
  const table = h.dom.document.createElement('table');
  container.appendChild(table);
  h.dom.document.body.appendChild(container);
  let scrollPosition = Math.max(0, Math.min(100, options.initialScrollTop || 0));

  const render = () => {
    for (const row of [...table.children]) row.remove();
    const start = Math.floor(scrollPosition / 20);
    for (const archiveName of names.slice(start, start + 19)) {
      if (archiveName === options.omitName) continue;
      const row = h.dom.document.createElement('tr');
      row.setAttribute('data-row-key', apiItems[names.indexOf(archiveName)].fid);
      const filename = h.dom.document.createElement('span');
      filename.textContent = archiveName;
      filename.onDoubleClick = () => {
        opened.push(archiveName);
        const dialog = h.dom.document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.appendChild(h.dom.element(`${archiveName} 解压到全部文件更改`));
        const submit = h.dom.document.createElement('button');
        submit.textContent = '解压全部文件';
        submit.onClick = () => { submitted.push(archiveName); completedNativeTask(h); };
        dialog.appendChild(submit);
        const close = h.dom.document.createElement('button');
        close.setAttribute('aria-label', 'Close');
        close.textContent = '关闭';
        close.onClick = () => dialog.remove();
        dialog.appendChild(close);
        h.dom.document.body.appendChild(dialog);
      };
      row.appendChild(filename);
      table.appendChild(row);
    }
  };
  Object.defineProperty(container, 'scrollTop', {
    get: () => scrollPosition,
    set: (value) => {
      const oldValue = scrollPosition;
      scrollPosition = Math.max(0, Math.min(100, Number(value) || 0));
      scrolls.push(scrollPosition);
      render();
      if (scrollPosition !== oldValue) options.onScroll?.(h, scrollPosition);
    },
  });
  container.scrollTo = (value, y) => { container.scrollTop = typeof value === 'object' ? value.top : y; };
  render();
  h.ctx.virtualApiItems = apiItems;
  h.ctx.virtualApiCalls = 0;
  h.evaluate(`listFolderItems = async () => { globalThis.virtualApiCalls += 1; return globalThis.virtualApiItems; };`);
  return { h, names, apiItems, container, table, opened, submitted, scrolls };
}

for (const scriptPath of scriptPaths) {
  const variant = scriptPath.split('/').pop();
  test(`${variant}: API scan returns all 24 archives although only 19 rows are mounted`, async () => {
    const f = virtualArchiveFixture(scriptPath);
    assert.equal(f.table.children.length, 19);
    f.h.ctx.virtualApiItems = [
      ...f.apiItems.slice().reverse(),
      { fid: 'zip-folder', file_name: 'folder.zip', file_type: 0, parent_fid: '0' },
      { fid: 'video', file_name: 'video.mp4', file_type: 1, parent_fid: '0' },
    ];
    const pattern = /\.(zip|rar|7z)$/gi;
    pattern.lastIndex = 5;
    const result = await f.h.api.listArchiveNames(pattern, '0');
    assert.deepEqual(Array.from(result), f.names);
    assert.equal(f.h.ctx.virtualApiCalls, 1);
    assert.equal(f.table.children.length, 19, 'API discovery does not need to mount every row');
  });

  test(`${variant}: API scan error is reported and never falls back to mounted rows`, async () => {
    const f = virtualArchiveFixture(scriptPath);
    f.h.evaluate(`listFolderItems = async () => { throw new Error('API scan denied'); };`);
    await assert.rejects(f.h.api.listArchiveNames(/\.zip$/i, '0'), /API scan denied/);
    assert.equal(f.table.children.length, 19);
    assert.deepEqual(f.submitted, []);
  });

  test(`${variant}: source change or stop during API discovery invalidates the result`, async () => {
    for (const mode of ['sourceChange', 'stop']) {
      const f = virtualArchiveFixture(scriptPath);
      f.h.ctx.onApiReturn = () => {
        if (mode === 'stop') f.h.api.state.stopRequested = true;
        else f.h.location.hash = `#/list/all/${'e'.repeat(32)}-其他目录`;
      };
      f.h.evaluate(`listFolderItems = async () => { globalThis.onApiReturn(); return globalThis.virtualApiItems; };`);
      await assert.rejects(f.h.api.listArchiveNames(/\.zip$/i, '0'), mode === 'stop' ? /停止/ : /目录|文件夹/);
      assert.deepEqual(f.submitted, []);
    }
  });

  test(`${variant}: locator mounts the offscreen tail archive by scrolling only its file table`, async () => {
    const f = virtualArchiveFixture(scriptPath);
    assert.equal(f.h.api.findArchiveNameElement('24.zip'), null);
    const element = await f.h.api.locateArchiveNameElement('24.zip', '0', 100);
    assert.equal(element.textContent, '24.zip');
    assert.equal(element.isConnected, true, 'success must not restore scroll and detach the selected row');
    assert.ok(f.scrolls.some((value) => value > 0));
    assert.deepEqual(f.opened, [], 'locating alone must not double-click or submit');
  });

  test(`${variant}: locator resets a bottom window to find an archive above it`, async () => {
    const f = virtualArchiveFixture(scriptPath, { initialScrollTop: 100 });
    assert.equal(f.h.api.findArchiveNameElement('01.zip'), null);
    const element = await f.h.api.locateArchiveNameElement('01.zip', '0', 100);
    assert.equal(element.textContent, '01.zip');
    assert.equal(element.isConnected, true);
    assert.ok(f.scrolls.includes(0));
  });

  test(`${variant}: an exact archive name in a modal table is excluded from source-row lookup`, () => {
    const f = virtualArchiveFixture(scriptPath);
    const dialog = f.h.dom.document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const table = dialog.appendChild(f.h.dom.document.createElement('table'));
    const row = table.appendChild(f.h.dom.document.createElement('tr'));
    const filename = row.appendChild(f.h.dom.document.createElement('span'));
    filename.textContent = '24.zip';
    f.h.dom.document.body.appendChild(dialog);
    assert.equal(f.h.api.findArchiveNameElement('24.zip'), null);
  });

  test(`${variant}: a source change or stop at a scroll boundary prevents accepting the newly mounted row`, async () => {
    for (const mode of ['sourceChange', 'stop']) {
      const f = virtualArchiveFixture(scriptPath, { onScroll: (h) => {
        if (mode === 'stop') h.api.state.stopRequested = true;
        else h.location.hash = `#/list/all/${'e'.repeat(32)}-其他目录`;
      } });
      await assert.rejects(f.h.api.locateArchiveNameElement('24.zip', '0', 100), mode === 'stop' ? /停止/ : /目录|文件夹/);
      assert.deepEqual(f.opened, []);
      assert.deepEqual(f.submitted, []);
    }
  });

  test(`${variant}: missing virtual row reaches the bottom, restores scroll and never submits`, async () => {
    const f = virtualArchiveFixture(scriptPath, { initialScrollTop: 40, omitName: '24.zip' });
    f.h.evaluate(`
      const originalVirtualLocatorTest = locateArchiveNameElement;
      locateArchiveNameElement = (name, sourceFid, timeout = 15000) =>
        originalVirtualLocatorTest(name, sourceFid, Math.min(timeout, 100));
    `);
    await assert.rejects(f.h.api.processArchive('24.zip', '', new Set(), false, false, '0', () => {}), /定位|找到|超时|文件/);
    assert.ok(f.scrolls.includes(100), 'the whole mounted window range was searched');
    assert.equal(f.container.scrollTop, 40, 'unsuccessful search restores the original scroll position');
    assert.deepEqual(f.opened, []);
    assert.deepEqual(f.submitted, []);
  });

  test(`${variant}: actual processArchive continues from an early row to a virtualized tail row`, async () => {
    const f = virtualArchiveFixture(scriptPath);
    const knownExisting = new Set();
    for (const archiveName of ['01.zip', '24.zip']) {
      const result = await f.h.api.processArchive(archiveName, '', knownExisting, false, false, '0', () => {});
      assert.equal(result.status, 'submitted');
      assert.equal(result.deleted, false);
    }
    assert.deepEqual(f.opened, ['01.zip', '24.zip']);
    assert.deepEqual(f.submitted, ['01.zip', '24.zip']);
    assert.equal(f.h.dom.document.querySelector('[role="dialog"]'), null);
  });
}

// Insert before module.exports. These native widgets deliberately contain no
// archive name. Their status is correlated only by the explicit prepared flag,
// a newly mounted unique visible widget, and its exact progress state.
function nativeProgressFixture(scriptPath) {
  const h = load(scriptPath);
  h.evaluate(`Object.assign(globalThis.api, { prepareUnzipProgress, closeUnzipProgress });`);
  const widgets = [];
  const widget = (text = '文件解压中35%', mode = '') => {
    const element = h.dom.document.createElement('div');
    element.setAttribute('class', 'decompressing');
    const tips = h.dom.document.createElement('div');
    tips.setAttribute('class', 'progress-tips');
    tips.textContent = text;
    element.appendChild(tips);
    const close = h.dom.document.createElement('button');
    close.setAttribute('class', 'close decompressing-close anticon anticon-close');
    close.setAttribute('aria-label', 'Close');
    close.textContent = '关闭';
    element.appendChild(close);
    const result = { element, tips, close, closeClicks: 0 };
    close.onClick = () => { result.closeClicks += 1; element.remove(); };
    if (mode === 'opacity0') element.style.opacity = '0';
    if (mode === 'hiddenTips') tips.style.opacity = '0';
    if (mode === 'ariaHidden') element.setAttribute('aria-hidden', 'true');
    h.dom.document.body.appendChild(element);
    widgets.push(result);
    return result;
  };
  return { h, widgets, widget };
}

async function nativeHostWaitFor(predicate, label, timeout = 300) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(label + ' did not become ready');
}

for (const scriptPath of scriptPaths) {
  const variant = scriptPath.split('/').pop();

  test(`${variant}: a new native pending widget acknowledges, then success100 completes the same task`, async () => {
    const f = nativeProgressFixture(scriptPath);
    const watcher = f.h.api.watchUnzipTask('01.zip', { nativeProgressReady: true });
    const current = f.widget();
    await flush();
    try {
      await watcher.waitForAcknowledgement(40);
      assert.equal(watcher.progressElement(), current.element);
      await assert.rejects(watcher.wait(15), /超时|完成|保留/);
      current.tips.textContent = '文件解压成功100%';
      await flush();
      await watcher.wait(40);
      assert.equal(watcher.progressElement(), current.element);
    } finally { watcher.cancel(); }
  });

  test(`${variant}: a unique new native widget whose first frame is success100 can acknowledge and complete`, async () => {
    const f = nativeProgressFixture(scriptPath);
    const watcher = f.h.api.watchUnzipTask('01.zip', { nativeProgressReady: true });
    const current = f.widget('文件解压成功100%');
    await flush();
    try {
      await watcher.waitForAcknowledgement(40);
      await watcher.wait(40);
      assert.equal(watcher.progressElement(), current.element);
    } finally { watcher.cancel(); }
  });

  test(`${variant}: native progress is not evidence unless preparation was explicitly enabled`, async () => {
    const f = nativeProgressFixture(scriptPath);
    const watcher = f.h.api.watchUnzipTask('01.zip');
    f.widget('文件解压成功100%');
    await flush();
    try { await assert.rejects(watcher.waitForAcknowledgement(15), /确认|受理|超时/); }
    finally { watcher.cancel(); }
  });

  test(`${variant}: old native refs remain ignored when their text changes or they are reinserted`, async () => {
    const f = nativeProgressFixture(scriptPath);
    const old = f.widget('文件解压成功100%');
    const watcher = f.h.api.watchUnzipTask('01.zip', { nativeProgressReady: true });
    old.tips.textContent = '文件解压中35%';
    await flush();
    old.element.remove();
    f.h.dom.document.body.appendChild(old.element);
    old.tips.textContent = '文件解压成功100%';
    await flush();
    try { await assert.rejects(watcher.waitForAcknowledgement(15), /确认|受理|超时/); }
    finally { watcher.cancel(); }
  });

  test(`${variant}: hidden native widgets or hidden progress tips never acknowledge`, async () => {
    for (const mode of ['opacity0', 'hiddenTips', 'ariaHidden']) {
      const f = nativeProgressFixture(scriptPath);
      const watcher = f.h.api.watchUnzipTask('01.zip', { nativeProgressReady: true });
      f.widget('文件解压成功100%', mode);
      await flush();
      try { await assert.rejects(watcher.waitForAcknowledgement(15), /确认|受理|超时/); }
      finally { watcher.cancel(); }
    }
  });

  test(`${variant}: two new visible native widgets cannot identify which task completed`, async () => {
    const f = nativeProgressFixture(scriptPath);
    const watcher = f.h.api.watchUnzipTask('01.zip', { nativeProgressReady: true });
    f.widget('文件解压成功100%');
    f.widget('文件解压成功100%');
    await flush();
    try { await assert.rejects(watcher.waitForAcknowledgement(20)); }
    finally { watcher.cancel(); }
  });

  test(`${variant}: adding a second native widget after acknowledgement makes completion ambiguous`, async () => {
    const f = nativeProgressFixture(scriptPath);
    const watcher = f.h.api.watchUnzipTask('01.zip', { nativeProgressReady: true });
    const first = f.widget();
    await flush();
    try {
      await watcher.waitForAcknowledgement(40);
      first.tips.textContent = '文件解压成功100%';
      f.widget('文件解压成功100%');
      await flush();
      await assert.rejects(watcher.wait(20));
    } finally { watcher.cancel(); }
  });

  test(`${variant}: a generic success100 notice outside a native widget remains unrelated`, async () => {
    const f = nativeProgressFixture(scriptPath);
    const watcher = f.h.api.watchUnzipTask('01.zip', { nativeProgressReady: true });
    task(f.h, '文件解压成功100%');
    await flush();
    try { await assert.rejects(watcher.waitForAcknowledgement(15), /确认|受理|超时/); }
    finally { watcher.cancel(); }
  });

  test(`${variant}: partial success or pending100 never authorizes task completion`, async () => {
    for (const text of ['文件解压成功99%', '文件解压成功', '文件解压中100%']) {
      const f = nativeProgressFixture(scriptPath);
      const watcher = f.h.api.watchUnzipTask('01.zip', { nativeProgressReady: true });
      f.widget(text);
      await flush();
      try { await assert.rejects(watcher.wait(15), /超时|完成|保留/); }
      finally { watcher.cancel(); }
    }
  });

  test(`${variant}: a named generic completion cannot replace completion of the owned native widget`, async () => {
    const f = nativeProgressFixture(scriptPath);
    const watcher = f.h.api.watchUnzipTask('01.zip', { nativeProgressReady: true });
    f.widget();
    await flush();
    try {
      await watcher.waitForAcknowledgement(40);
      task(f.h, '01.zip 解压完成');
      await flush();
      await assert.rejects(watcher.wait(15), /超时|完成|保留/);
    } finally { watcher.cancel(); }
  });

  test(`${variant}: native failure is latched after its widget disappears`, async () => {
    const f = nativeProgressFixture(scriptPath);
    const watcher = f.h.api.watchUnzipTask('01.zip', { nativeProgressReady: true });
    const current = f.widget();
    await flush();
    try {
      await watcher.waitForAcknowledgement(40);
      current.tips.textContent = '文件解压失败';
      await flush();
      current.element.remove();
      f.widget('文件解压成功100%');
      await flush();
      await assert.rejects(watcher.wait(20), /失败|保留/);
    } finally { watcher.cancel(); }
  });

  test(`${variant}: stop takes precedence over a newly completed native widget`, async () => {
    const f = nativeProgressFixture(scriptPath);
    const watcher = f.h.api.watchUnzipTask('01.zip', { nativeProgressReady: true });
    const current = f.widget();
    await flush();
    try {
      await watcher.waitForAcknowledgement(40);
      f.h.api.state.stopRequested = true;
      current.tips.textContent = '文件解压成功100%';
      await flush();
      await assert.rejects(watcher.wait(20), /停止/);
    } finally { watcher.cancel(); }
  });

  test(`${variant}: preparation closes an old success100 widget before another task begins`, async () => {
    const f = nativeProgressFixture(scriptPath);
    const old = f.widget('文件解压成功100%');
    await f.h.api.prepareUnzipProgress('01.zip');
    assert.equal(old.closeClicks, 1);
    assert.equal(old.element.isConnected, false);
  });

  test(`${variant}: preparation refuses old running or partial-success progress without closing it`, async () => {
    for (const [text, mode] of [['文件解压中35%', ''], ['文件解压成功99%', ''], ['文件解压中35%', 'opacity0']]) {
      const f = nativeProgressFixture(scriptPath);
      const old = f.widget(text, mode);
      await assert.rejects(f.h.api.prepareUnzipProgress('01.zip'), /解压|进度|任务|100|完成/);
      assert.equal(old.closeClicks, 0);
      assert.equal(old.element.isConnected, true);
    }
  });

  test(`${variant}: closing completed native progress acts only on the supplied widget`, async () => {
    const f = nativeProgressFixture(scriptPath);
    const unrelated = f.widget('文件解压成功100%');
    const current = f.widget('文件解压成功100%');
    await f.h.api.closeUnzipProgress(current.element, '01.zip');
    assert.equal(current.closeClicks, 1);
    assert.equal(current.element.isConnected, false);
    assert.equal(unrelated.closeClicks, 0);
    assert.equal(unrelated.element.isConnected, true);
  });

  test(`${variant}: closing a running native widget never clicks its close control`, async () => {
    const f = nativeProgressFixture(scriptPath);
    const running = f.widget('文件解压中100%');
    try { await f.h.api.closeUnzipProgress(running.element, '01.zip'); }
    catch (error) { assert.match(error.message, /解压|进度|完成|成功|100/); }
    assert.equal(running.closeClicks, 0);
    assert.equal(running.element.isConnected, true);
  });

  test(`${variant}: two real processArchive calls wait for native completion even when deletion is disabled`, async () => {
    const f = nativeProgressFixture(scriptPath);
    const { h } = f;
    const opened = [];
    const submitted = [];
    const previewClosed = [];
    const currentWidgets = new Map();
    const table = h.dom.document.createElement('table');
    h.dom.document.body.appendChild(table);
    h.ctx.nativeDeleteCalls = 0;
    h.evaluate(`deleteDriveItems = async () => { globalThis.nativeDeleteCalls += 1; };`);
    for (const archiveName of ['01.zip', '02.zip']) {
      const row = table.appendChild(h.dom.document.createElement('tr'));
      const filename = row.appendChild(h.dom.document.createElement('span'));
      filename.textContent = archiveName;
      filename.onDoubleClick = () => {
        opened.push(archiveName);
        assert.equal(h.dom.document.querySelector('.decompressing'), null, 'the previous progress must close before the next preview opens');
        const dialog = h.dom.document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.appendChild(h.dom.element(`${archiveName} 解压到全部文件更改`));
        const submit = dialog.appendChild(h.dom.document.createElement('button'));
        submit.textContent = '解压全部文件';
        submit.onClick = () => { submitted.push(archiveName); currentWidgets.set(archiveName, f.widget()); };
        const close = dialog.appendChild(h.dom.document.createElement('button'));
        close.setAttribute('aria-label', 'Close');
        close.textContent = '关闭';
        close.onClick = () => { previewClosed.push(archiveName); dialog.remove(); };
        h.dom.document.body.appendChild(dialog);
      };
    }
    const knownExisting = new Set();
    const results = [];
    let batchError;
    let batchDone = false;
    const batch = (async () => {
      for (const archiveName of ['01.zip', '02.zip']) {
        results.push(await h.api.processArchive(archiveName, '', knownExisting, false, false, '0', () => {}));
      }
      batchDone = true;
    })();
    batch.catch((error) => { batchError = error; });
    const ready = (predicate) => () => { if (batchError) throw batchError; return predicate(); };
    await nativeHostWaitFor(ready(() => submitted.length === 1 && previewClosed.length === 1), 'first native pending task');
    assert.equal(batchDone, false);
    assert.deepEqual(opened, ['01.zip']);
    const first = currentWidgets.get('01.zip');
    first.tips.textContent = '文件解压成功99%';
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(batchDone, false, '99% must not complete an archive');
    assert.deepEqual(opened, ['01.zip'], 'deletion=false still waits before opening the next archive');
    first.tips.textContent = '文件解压成功100%';
    await flush();
    await nativeHostWaitFor(ready(() => submitted.length === 2 && previewClosed.length === 2), 'second native pending task');
    assert.equal(first.closeClicks, 1);
    assert.equal(first.element.isConnected, false);
    assert.equal(batchDone, false);
    const second = currentWidgets.get('02.zip');
    second.tips.textContent = '文件解压成功100%';
    await flush();
    await batch;
    assert.deepEqual(opened, ['01.zip', '02.zip']);
    assert.deepEqual(submitted, ['01.zip', '02.zip']);
    assert.equal(second.closeClicks, 1);
    assert.equal(second.element.isConnected, false);
    assert.equal(results.length, 2);
    assert.ok(results.every((result) => result.status === 'submitted' && result.deleted === false));
    assert.equal(h.ctx.nativeDeleteCalls, 0);
  });
}

// Insert before module.exports; reuses nativeProgressFixture from native tests.
for (const scriptPath of scriptPaths) {
  const variant = scriptPath.split('/').pop();

  test(`${variant}: replacing an acknowledged native widget cannot complete the original task`, async () => {
    const f = nativeProgressFixture(scriptPath);
    const watcher = f.h.api.watchUnzipTask('01.zip', { nativeProgressReady: true });
    const original = f.widget();
    await flush();
    try {
      await watcher.waitForAcknowledgement(40);
      original.element.remove();
      f.widget('文件解压成功100%');
      await flush();
      await assert.rejects(watcher.wait(20), /替换|消失|关联|进度/);
      assert.equal(watcher.progressElement(), original.element, 'ownership never migrates to the replacement');
    } finally { watcher.cancel(); }
  });

  test(`${variant}: native ambiguity remains latched after the second widget is removed`, async () => {
    const f = nativeProgressFixture(scriptPath);
    const watcher = f.h.api.watchUnzipTask('01.zip', { nativeProgressReady: true });
    const original = f.widget();
    await flush();
    try {
      await watcher.waitForAcknowledgement(40);
      const other = f.widget();
      await flush();
      other.element.remove();
      original.tips.textContent = '文件解压成功100%';
      await flush();
      await assert.rejects(watcher.wait(20), /多个|替换|关联|进度/);
    } finally { watcher.cancel(); }
  });

  test(`${variant}: a lost or hidden owned native widget cannot recover by reappearing at success100`, async () => {
    for (const mode of ['removed', 'hidden']) {
      const f = nativeProgressFixture(scriptPath);
      const watcher = f.h.api.watchUnzipTask('01.zip', { nativeProgressReady: true });
      const original = f.widget();
      await flush();
      try {
        await watcher.waitForAcknowledgement(40);
        if (mode === 'removed') original.element.remove();
        else original.element.style.opacity = '0';
        await flush();
        if (mode === 'removed') f.h.dom.document.body.appendChild(original.element);
        else original.element.style.opacity = '1';
        original.tips.textContent = '文件解压成功100%';
        await flush();
        await assert.rejects(watcher.wait(20), /消失|进度|保留/);
      } finally { watcher.cancel(); }
    }
  });

  test(`${variant}: an old same-name generic completion does not block a newly owned native completion`, async () => {
    const f = nativeProgressFixture(scriptPath);
    task(f.h, '01.zip 解压完成');
    const watcher = f.h.api.watchUnzipTask('01.zip', { nativeProgressReady: true });
    const current = f.widget();
    await flush();
    try {
      await watcher.waitForAcknowledgement(40);
      current.tips.textContent = '文件解压成功100%';
      await flush();
      await watcher.wait(40);
      assert.equal(watcher.progressElement(), current.element);
    } finally { watcher.cancel(); }
  });
}

// Insert before module.exports; reuses nativeProgressFixture.
for (const scriptPath of scriptPaths) {
  const variant = scriptPath.split('/').pop();

  test(`${variant}: completed native status reverting to pending is latched even if success100 returns`, async () => {
    const f = nativeProgressFixture(scriptPath);
    const watcher = f.h.api.watchUnzipTask('01.zip', { nativeProgressReady: true });
    const current = f.widget('文件解压成功100%');
    await flush();
    try {
      await watcher.waitForAcknowledgement(40);
      await watcher.wait(40);
      current.tips.textContent = '文件解压中35%';
      await flush();
      assert.throws(() => watcher.checkErrors(), /回退|状态|进度|完成/);
      current.tips.textContent = '文件解压成功100%';
      await flush();
      await assert.rejects(watcher.wait(20), /回退|状态|进度|完成/);
    } finally { watcher.cancel(); }
  });

  test(`${variant}: a second hidden native ref causes ambiguity that stays latched after it is removed`, async () => {
    const f = nativeProgressFixture(scriptPath);
    const watcher = f.h.api.watchUnzipTask('01.zip', { nativeProgressReady: true });
    const current = f.widget();
    await flush();
    try {
      await watcher.waitForAcknowledgement(40);
      const hidden = f.widget('文件解压成功100%', 'opacity0');
      await flush();
      assert.throws(() => watcher.checkErrors(), /多个|替换|关联|进度/);
      hidden.element.remove();
      current.tips.textContent = '文件解压成功100%';
      await flush();
      await assert.rejects(watcher.wait(20), /多个|替换|关联|进度/);
    } finally { watcher.cancel(); }
  });

  test(`${variant}: actual processArchive retains the source when completed native progress cannot close`, async () => {
    const f = nativeProgressFixture(scriptPath);
    const { h } = f;
    h.ctx.nativeDeleteCalls = 0;
    h.ctx.nativeDeleteReadbacks = 0;
    h.evaluate(`
      const originalNativeCloseFailureWait = waitFor;
      waitFor = (getter, label, timeout = 15000, interval = 250, archiveName = '') =>
        originalNativeCloseFailureWait(getter, label, Math.min(timeout, 40), Math.min(interval, 2), archiveName);
      listFolderItems = async () => [{ fid: 'source-01', file_name: '01.zip', file_type: 1, parent_fid: '0' }];
      deleteDriveItems = async () => { globalThis.nativeDeleteCalls += 1; };
      waitUntilItemsMissing = async () => { globalThis.nativeDeleteReadbacks += 1; };
    `);
    let submitClicks = 0;
    let native;
    const table = h.dom.document.body.appendChild(h.dom.document.createElement('table'));
    const row = table.appendChild(h.dom.document.createElement('tr'));
    const filename = row.appendChild(h.dom.document.createElement('span'));
    filename.textContent = '01.zip';
    filename.onDoubleClick = () => {
      const dialog = h.dom.document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.appendChild(h.dom.element('01.zip 解压到全部文件更改'));
      const submit = dialog.appendChild(h.dom.document.createElement('button'));
      submit.textContent = '解压全部文件';
      submit.onClick = () => {
        submitClicks += 1;
        native = f.widget('文件解压成功100%');
        native.close.onClick = () => { native.closeClicks += 1; }; // Deliberately remains mounted.
      };
      const close = dialog.appendChild(h.dom.document.createElement('button'));
      close.setAttribute('aria-label', 'Close');
      close.textContent = '关闭';
      close.onClick = () => dialog.remove();
      h.dom.document.body.appendChild(dialog);
    };
    await assert.rejects(h.api.processArchive('01.zip', '', new Set(), false, true, '0', () => {}), (error) => {
      assert.equal(error.archiveSubmitted, true, 'successful acceptance remains recorded after close failure');
      assert.match(error.message, /关闭.*超时|超时/);
      return true;
    });
    assert.equal(submitClicks, 1);
    assert.equal(native.closeClicks, 1);
    assert.equal(native.element.isConnected, true);
    assert.equal(h.ctx.nativeDeleteCalls, 0, 'native close must finish before any source deletion');
    assert.equal(h.ctx.nativeDeleteReadbacks, 0);
  });
}

module.exports = { load, task, flush, scriptPaths, message, nestedNotice };
