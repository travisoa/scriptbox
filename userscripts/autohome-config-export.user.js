// ==UserScript==
// @name         Autohome Config Export
// @name:zh-CN   汽车之家配置导出 Excel
// @namespace    https://local.travisoa.com/userscripts
// @version      0.2.0
// @description  Export Autohome (car/www.autohome.com.cn) spec/config tables to Excel, by category or all at once. Supports both the legacy and the new Next.js config layouts.
// @description:zh-CN  在汽车之家车型参数配置页导出配置表为 Excel，可按分类导出，也可一键导出全部；兼容旧版与新版（Next.js）两种配置页。
// @author       Claude & travisoa
// @match        https://*.autohome.com.cn/config/*
// @match        https://*.autohome.com.cn/spec/*
// @icon         data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTYiIGZpbGw9IiMxMDdjNDEiLz48cmVjdCB4PSIxMyIgeT0iMTIiIHdpZHRoPSIzOCIgaGVpZ2h0PSI0MCIgcng9IjMiIGZpbGw9IiNmZmYiLz48cmVjdCB4PSIxMyIgeT0iMTIiIHdpZHRoPSIzOCIgaGVpZ2h0PSI4IiBmaWxsPSIjMTA3YzQxIi8+PHJlY3QgeD0iMjUiIHk9IjIwIiB3aWR0aD0iMiIgaGVpZ2h0PSIzMiIgZmlsbD0iIzEwN2M0MSIgb3BhY2l0eT0iLjQiLz48cmVjdCB4PSIzNyIgeT0iMjAiIHdpZHRoPSIyIiBoZWlnaHQ9IjMyIiBmaWxsPSIjMTA3YzQxIiBvcGFjaXR5PSIuNCIvPjxyZWN0IHg9IjEzIiB5PSIzMCIgd2lkdGg9IjM4IiBoZWlnaHQ9IjIiIGZpbGw9IiMxMDdjNDEiIG9wYWNpdHk9Ii40Ii8+PHJlY3QgeD0iMTMiIHk9IjQwIiB3aWR0aD0iMzgiIGhlaWdodD0iMiIgZmlsbD0iIzEwN2M0MSIgb3BhY2l0eT0iLjQiLz48L3N2Zz4=
// @homepageURL  https://github.com/travisoa/scriptbox
// @downloadURL  https://raw.githubusercontent.com/travisoa/scriptbox/main/userscripts/autohome-config-export.user.js
// @updateURL    https://raw.githubusercontent.com/travisoa/scriptbox/main/userscripts/autohome-config-export.user.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const PANEL_ID = "autohome-config-export";
  const POS_KEY = "autohome-config-export-pos";
  const COLLAPSED_KEY = "autohome-config-export-collapsed";
  const PANEL_MARGIN = 12;
  const COLLAPSED_SIZE = 46;

  // 汽车之家把部分文字藏进 CSS ::before content（反爬）。下面这些类名家族用到。
  const KW_RE = /hs_kw\d+_\w+/;
  const ICON_MAP = {
    "icons-standard": "●", // 标配
    "icons-option": "○", // 选装
    "icons-no": "-", // 无
  };

  /* ---------------------------------------------------------------- 数据解析 */

  // 扫描所有样式表，建立 { 完整类名 -> 真实字符 } 映射
  function buildKwMap() {
    const map = {};
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try {
        rules = sheet.cssRules || sheet.rules;
      } catch (e) {
        continue; // 跨域样式表读不到，跳过
      }
      if (!rules) continue;
      for (const rule of Array.from(rules)) {
        const sel = rule.selectorText || "";
        const m = sel.match(KW_RE);
        if (!m || !rule.style || !rule.style.content) continue;
        const content = rule.style.content;
        if (!content || content === "none" || content === "normal") continue;
        map[m[0]] = content.replace(/^['"]|['"]$/g, "");
      }
    }
    return map;
  }

  // 还原一个单元格的真实文本：文本节点 + CSS 注入字符 + 图标
  function decodeCell(el, kwMap) {
    let s = "";
    el.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) {
        s += n.nodeValue;
      } else if (n.nodeType === Node.ELEMENT_NODE) {
        const cls = "" + (n.className || "");
        const km = cls.match(KW_RE);
        if (km && kwMap[km[0]] != null) s += kwMap[km[0]];
        if (n.tagName === "I") {
          const ic = cls.split(/\s+/).find((c) => ICON_MAP[c]);
          if (ic) s += ICON_MAP[ic];
        }
        s += decodeCell(n, kwMap);
      }
    });
    return s.replace(/\s+/g, " ").trim();
  }

  // 取所有车型名称（按列顺序，去重）
  function getCars() {
    const seen = new Set();
    const cars = [];
    document.querySelectorAll('a[href*="/spec/"]').forEach((a) => {
      const name = a.textContent.trim();
      const m = (a.getAttribute("href") || "").match(/\/spec\/(\d+)/);
      if (name && m && !seen.has(m[1])) {
        seen.add(m[1]);
        cars.push({ id: m[1], name });
      }
    });
    return cars;
  }

  function getSeriesName(cars) {
    // 旧版标题形如「汽车之家|昂科威Plus|报价大全|参数配置」
    const parts = (document.title || "").split(/[|｜]/).map((s) => s.trim());
    const good = parts.find(
      (p) => p && !/汽车之家|参数配置|报价大全|报价|配置$/.test(p)
    );
    if (good) return good;
    // 新版标题无车系名，从车型名取第一段，如「小鹏GX 2026款…」-> 小鹏GX
    if (cars && cars.length) {
      const first = cars[0].name.split(/\s+/)[0];
      if (first) return first;
    }
    return "车型配置";
  }

  /* ---- 旧版布局（car.autohome.com.cn，#config_data + table#tab_N，含 CSS 反爬） ---- */
  function parseOld(cars) {
    const kwMap = buildKwMap();
    const nCars = cars.length;
    const cd = document.querySelector("#config_data");
    const categories = [];

    const readRow = (row) => {
      const cells = row.cells;
      if (!cells || !cells.length) return null;
      const label = decodeCell(cells[0], kwMap);
      if (!label) return null;
      const out = [label];
      for (let i = 1; i <= nCars; i++) {
        out.push(cells[i] ? decodeCell(cells[i], kwMap) : "");
      }
      return out;
    };

    // 价格表（厂商指导价）：没有 id、没有 .cstitle 的 tbcs 表
    cd.querySelectorAll("table.tbcs").forEach((t) => {
      if (t.id || t.querySelector(".cstitle")) return;
      const first = t.rows[0] && t.rows[0].cells[0];
      if (!first || !/指导价|报价|价格/.test(first.textContent)) return;
      const rows = [];
      Array.from(t.rows).forEach((r) => {
        const parsed = readRow(r);
        if (parsed) rows.push(parsed);
      });
      if (rows.length) categories.push({ name: "价格", rows });
    });

    // 各配置分类：table#tab_N（排除左侧冻结列 tab_side）
    cd.querySelectorAll('table[id^="tab_"]').forEach((t) => {
      if (t.id === "tab_side") return;
      const titleEl = t.querySelector(".cstitle");
      const name = titleEl ? titleEl.textContent.trim() : t.id;
      const rows = [];
      Array.from(t.rows).forEach((r) => {
        if (r.querySelector(".cstitle")) return; // 跳过分类标题行
        const parsed = readRow(r);
        if (parsed) rows.push(parsed);
      });
      if (rows.length) categories.push({ name, rows });
    });

    return categories;
  }

  /* ---- 新版布局（www.autohome.com.cn，Next.js，style_row__ / style_table_title__） ---- */
  // 操作按钮 / 营销文字噪音（计算器、询底价等），导出时剔除
  const NEW_NOISE = /(^|\s)(计算器|询底价|询价|参数纠错|降价通知|降价提醒|预约试驾|对比|分期|金融|车型详情|图片|查看|更多)(?=\s|$)/g;

  // 按 DOM 顺序还原文本：文本节点保留，实心点→●、空心点→○，块级子元素之间补空格避免粘连
  function newWalk(el) {
    const parts = [];
    el.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) {
        const t = n.nodeValue.trim();
        if (t) parts.push(t);
      } else if (n.nodeType === Node.ELEMENT_NODE) {
        const cls = "" + (n.className || "");
        if (/dot_solid/.test(cls)) parts.push("●"); // 标配
        else if (/dot_outline/.test(cls)) parts.push("○"); // 选装
        else {
          const sub = newWalk(n);
          if (sub) parts.push(sub);
        }
      }
    });
    return parts.join(" ");
  }

  function newLabel(cell) {
    return newWalk(cell).replace(/\s+/g, " ").trim();
  }

  function newCellValue(cell) {
    let s = newWalk(cell)
      .replace(NEW_NOISE, " ")
      .replace(/\s+/g, " ")
      .trim();
    // 去掉描述性取值前面单独的标配/选装圆点（复合项内部的点保留）
    s = s.replace(/^[●○]\s+(?=\S)/, "");
    // 复合项分隔符两侧补空格（仅处理「 /字」，不动 265/45 这类）
    s = s.replace(/\s\/(?=\S)/g, " / ");
    return s || "-"; // 无
  }

  function parseNew(cars) {
    const nCars = cars.length;
    const categories = [];
    let cur = null;
    document
      .querySelectorAll('[class*="style_table_title__"],[class*="style_row__"]')
      .forEach((n) => {
        const cls = "" + n.className;
        if (/style_table_title__/.test(cls)) {
          cur = { name: (n.innerText || "").trim().split("\n")[0] || "其他", rows: [] };
          categories.push(cur);
        } else if (/style_row__/.test(cls)) {
          if (!cur) {
            // 标题行之前的行（厂商指导价 / 经销商报价）归到「价格」
            cur = { name: "价格", rows: [] };
            categories.push(cur);
          }
          const cols = n.querySelectorAll('[class*="style_col__"]');
          if (!cols.length) return;
          const label = newLabel(cols[0]);
          if (!label) return;
          const out = [label];
          for (let i = 1; i <= nCars; i++) {
            out.push(cols[i] ? newCellValue(cols[i]) : "");
          }
          cur.rows.push(out);
        }
      });
    return categories.filter((c) => c.rows.length);
  }

  // 解析整张配置表 -> { series, cars, categories:[{name, rows:[[参数, v1, v2...]]}] }
  function extract() {
    const cars = getCars();
    let categories;
    if (document.querySelector("#config_data")) {
      categories = parseOld(cars); // 旧版
    } else if (document.querySelector('[class*="style_table_title__"]')) {
      categories = parseNew(cars); // 新版
    } else {
      return null;
    }
    return { series: getSeriesName(cars), cars, categories };
  }

  /* ---------------------------------------------------------------- 导出 Excel */

  function sanitizeSheetName(name, used) {
    let s = (name || "Sheet").replace(/[\\/?*\[\]:]/g, " ").trim().slice(0, 28) || "Sheet";
    let base = s;
    let i = 1;
    while (used.has(s)) s = (base + "_" + ++i).slice(0, 31);
    used.add(s);
    return s;
  }

  function headerRow(cars) {
    return ["参数"].concat(cars.map((c) => c.name));
  }

  function categoryToAoa(cat, cars) {
    return [headerRow(cars)].concat(cat.rows);
  }

  function fitColumns(aoa) {
    const widths = [];
    aoa.forEach((row) => {
      row.forEach((cell, i) => {
        const len = ("" + (cell == null ? "" : cell)).replace(/[^\x00-\xff]/g, "xx").length;
        widths[i] = Math.max(widths[i] || 8, Math.min(len + 2, 60));
      });
    });
    return widths.map((w) => ({ wch: w }));
  }

  // mode: "split" 每个分类一个工作表；"merge" 合并为一个工作表
  function exportExcel(data, cats, mode) {
    const wb = XLSX.utils.book_new();
    const used = new Set();

    if (mode === "merge") {
      const aoa = [headerRow(data.cars)];
      cats.forEach((cat) => {
        aoa.push(["【" + cat.name + "】"]); // 分类分隔行
        cat.rows.forEach((r) => aoa.push(r));
      });
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws["!cols"] = fitColumns(aoa);
      XLSX.utils.book_append_sheet(wb, ws, sanitizeSheetName(data.series + "配置", used));
    } else {
      cats.forEach((cat) => {
        const aoa = categoryToAoa(cat, data.cars);
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        ws["!cols"] = fitColumns(aoa);
        XLSX.utils.book_append_sheet(wb, ws, sanitizeSheetName(cat.name, used));
      });
    }

    const d = new Date();
    const stamp =
      d.getFullYear() +
      String(d.getMonth() + 1).padStart(2, "0") +
      String(d.getDate()).padStart(2, "0");
    const fname = `${data.series}_配置参数_${stamp}.xlsx`;
    XLSX.writeFile(wb, fname);
  }

  /* ---------------------------------------------------------------- UI */

  const style = document.createElement("style");
  style.textContent = `
#${PANEL_ID}{position:fixed;z-index:999999;right:18px;bottom:90px;font:13px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#1f2329;}
#${PANEL_ID} *{box-sizing:border-box;}
#${PANEL_ID}.collapsed .ace-panel{display:none;}
#${PANEL_ID} .ace-fab{width:${COLLAPSED_SIZE}px;height:${COLLAPSED_SIZE}px;border-radius:14px;background:#107c41;color:#fff;display:flex;align-items:center;justify-content:center;cursor:grab;box-shadow:0 6px 18px rgba(0,0,0,.22);user-select:none;font-size:11px;font-weight:600;text-align:center;letter-spacing:1px;}
#${PANEL_ID}:not(.collapsed) .ace-fab{display:none;}
#${PANEL_ID} .ace-panel{width:300px;max-height:78vh;display:flex;flex-direction:column;background:#fff;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.22);overflow:hidden;}
#${PANEL_ID} .ace-head{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#107c41;color:#fff;cursor:grab;}
#${PANEL_ID} .ace-head b{font-size:14px;flex:1;}
#${PANEL_ID} .ace-head .ace-x{cursor:pointer;opacity:.85;font-size:16px;line-height:1;padding:2px 4px;}
#${PANEL_ID} .ace-head .ace-x:hover{opacity:1;}
#${PANEL_ID} .ace-meta{padding:8px 12px;color:#646a73;border-bottom:1px solid #eef0f2;}
#${PANEL_ID} .ace-meta b{color:#107c41;}
#${PANEL_ID} .ace-tools{display:flex;gap:8px;align-items:center;padding:8px 12px 4px;}
#${PANEL_ID} .ace-tools a{color:#107c41;cursor:pointer;text-decoration:none;}
#${PANEL_ID} .ace-tools a:hover{text-decoration:underline;}
#${PANEL_ID} .ace-tools .sp{flex:1;}
#${PANEL_ID} .ace-list{overflow:auto;padding:4px 12px;flex:1;}
#${PANEL_ID} .ace-list label{display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer;}
#${PANEL_ID} .ace-list label span{flex:1;}
#${PANEL_ID} .ace-list label small{color:#9aa0a6;}
#${PANEL_ID} .ace-mode{display:flex;gap:14px;padding:6px 12px;border-top:1px solid #eef0f2;color:#646a73;}
#${PANEL_ID} .ace-mode label{display:flex;align-items:center;gap:5px;cursor:pointer;}
#${PANEL_ID} .ace-foot{display:flex;gap:8px;padding:10px 12px;border-top:1px solid #eef0f2;}
#${PANEL_ID} .ace-foot button{flex:1;border:0;border-radius:8px;padding:9px 8px;font-size:13px;font-weight:600;cursor:pointer;}
#${PANEL_ID} .ace-foot .sec{background:#eef7f1;color:#107c41;}
#${PANEL_ID} .ace-foot .pri{background:#107c41;color:#fff;}
#${PANEL_ID} .ace-foot button:hover{filter:brightness(.96);}
#${PANEL_ID} .ace-toast{position:fixed;left:50%;bottom:40px;transform:translateX(-50%);background:#1f2329;color:#fff;padding:8px 16px;border-radius:8px;z-index:1000000;opacity:0;transition:opacity .2s;}
#${PANEL_ID} .ace-toast.show{opacity:.95;}
`;
  document.head.appendChild(style);

  const root = document.createElement("div");
  root.id = PANEL_ID;
  root.className = "collapsed";
  root.innerHTML = `
    <div class="ace-fab" title="导出配置到 Excel">配置<br>导出</div>
    <div class="ace-panel">
      <div class="ace-head"><b>配置导出 Excel</b><span class="ace-x" title="收起">—</span></div>
      <div class="ace-meta"></div>
      <div class="ace-tools"><a data-act="all">全选</a><a data-act="none">清空</a><span class="sp"></span><span id="ace-count"></span></div>
      <div class="ace-list"></div>
      <div class="ace-mode">
        <label><input type="radio" name="ace-mode" value="split" checked> 分表(每类一页)</label>
        <label><input type="radio" name="ace-mode" value="merge"> 合并一页</label>
      </div>
      <div class="ace-foot">
        <button class="sec" data-act="selected">导出所选分类</button>
        <button class="pri" data-act="exportall">一键导出全部</button>
      </div>
    </div>
    <div class="ace-toast"></div>`;
  document.body.appendChild(root);

  const fab = root.querySelector(".ace-fab");
  const head = root.querySelector(".ace-head");
  const meta = root.querySelector(".ace-meta");
  const list = root.querySelector(".ace-list");
  const countEl = root.querySelector("#ace-count");
  const toastEl = root.querySelector(".ace-toast");

  let DATA = null;

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    setTimeout(() => toastEl.classList.remove("show"), 2200);
  }

  function refreshCount() {
    const total = list.querySelectorAll("input[type=checkbox]").length;
    const checked = list.querySelectorAll("input[type=checkbox]:checked").length;
    countEl.textContent = `${checked}/${total}`;
  }

  function renderList() {
    DATA = extract();
    list.innerHTML = "";
    if (!DATA || !DATA.categories.length) {
      meta.innerHTML = "未识别到配置表，请在车型「参数配置」页面打开。";
      countEl.textContent = "";
      return;
    }
    if (!DATA.cars.length) {
      meta.innerHTML = "未识别到车型列，请确认页面已加载完成。";
    } else {
      meta.innerHTML = `车系：<b>${DATA.series}</b> · 车型 <b>${DATA.cars.length}</b> 款 · 分类 <b>${DATA.categories.length}</b> 个`;
    }
    DATA.categories.forEach((cat, idx) => {
      const lab = document.createElement("label");
      lab.innerHTML = `<input type="checkbox" data-idx="${idx}" checked><span>${cat.name}</span><small>${cat.rows.length}</small>`;
      list.appendChild(lab);
    });
    refreshCount();
  }

  function selectedCategories() {
    const idxs = Array.from(list.querySelectorAll("input[type=checkbox]:checked")).map((c) =>
      Number(c.dataset.idx)
    );
    return idxs.map((i) => DATA.categories[i]);
  }

  function currentMode() {
    const r = root.querySelector('input[name="ace-mode"]:checked');
    return r ? r.value : "split";
  }

  function doExport(cats) {
    if (!DATA) renderList();
    if (!DATA || !DATA.categories.length) {
      toast("未识别到配置数据");
      return;
    }
    if (!cats.length) {
      toast("请先选择要导出的分类");
      return;
    }
    try {
      exportExcel(DATA, cats, currentMode());
      toast(`已导出 ${cats.length} 个分类`);
    } catch (e) {
      console.error("[配置导出]", e);
      toast("导出失败：" + e.message);
    }
  }

  list.addEventListener("change", refreshCount);

  root.querySelector(".ace-tools").addEventListener("click", (e) => {
    const act = e.target.dataset.act;
    if (act === "all" || act === "none") {
      list
        .querySelectorAll("input[type=checkbox]")
        .forEach((c) => (c.checked = act === "all"));
      refreshCount();
    }
  });

  root.querySelector(".ace-foot").addEventListener("click", (e) => {
    const act = e.target.dataset.act;
    if (act === "selected") {
      doExport(selectedCategories());
    } else if (act === "exportall") {
      renderList(); // 重新抓取，确保是最新全部数据
      doExport(DATA ? DATA.categories : []);
    }
  });

  // 展开 / 收起
  function setCollapsed(v) {
    root.classList.toggle("collapsed", v);
    try {
      localStorage.setItem(COLLAPSED_KEY, v ? "1" : "0");
    } catch (e) {}
    if (!v) renderList();
  }
  fab.addEventListener("click", (e) => {
    if (root.dataset.dragged === "1") {
      root.dataset.dragged = "0";
      return;
    }
    setCollapsed(false);
  });
  root.querySelector(".ace-x").addEventListener("click", () => setCollapsed(true));

  // 拖拽（手柄：收起态的 fab、展开态的标题栏）
  function makeDraggable(handle) {
    handle.addEventListener("mousedown", (e) => {
      if (e.target.classList.contains("ace-x")) return;
      e.preventDefault();
      const rect = root.getBoundingClientRect();
      const offX = e.clientX - rect.left;
      const offY = e.clientY - rect.top;
      let moved = false;
      const move = (ev) => {
        moved = true;
        root.dataset.dragged = "1";
        let left = ev.clientX - offX;
        let top = ev.clientY - offY;
        left = Math.max(PANEL_MARGIN, Math.min(window.innerWidth - rect.width - PANEL_MARGIN, left));
        top = Math.max(PANEL_MARGIN, Math.min(window.innerHeight - rect.height - PANEL_MARGIN, top));
        root.style.left = left + "px";
        root.style.top = top + "px";
        root.style.right = "auto";
        root.style.bottom = "auto";
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        if (moved) {
          try {
            localStorage.setItem(POS_KEY, JSON.stringify({ left: root.style.left, top: root.style.top }));
          } catch (e) {}
        }
        setTimeout(() => (root.dataset.dragged = "0"), 0);
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  }
  makeDraggable(fab);
  makeDraggable(head);

  // 还原位置 / 折叠状态
  try {
    const pos = JSON.parse(localStorage.getItem(POS_KEY) || "null");
    if (pos && pos.left && pos.top) {
      root.style.left = pos.left;
      root.style.top = pos.top;
      root.style.right = "auto";
      root.style.bottom = "auto";
    }
  } catch (e) {}
  if (localStorage.getItem(COLLAPSED_KEY) === "0") setCollapsed(false);
})();
