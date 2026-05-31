// ==UserScript==
// @name         Autohome Config Export
// @name:zh-CN   汽车之家配置导出 Excel
// @namespace    https://local.travisoa.com/userscripts
// @version      0.3.6
// @description  Export Autohome (car/www.autohome.com.cn) spec/config tables to Excel — by config category, by car group (energy type / drivetrain / model year, read from the page filters), or all at once. Supports both the legacy and new Next.js layouts.
// @description:zh-CN  在汽车之家车型参数配置页导出配置表为 Excel：可按配置分类导出、按车型分组（能源类型/驱动形式/年款，取自表头筛选项）导出，也可一键导出全部；兼容旧版与新版（Next.js）两种配置页。
// @author       Claude & travisoa
// @match        https://*.autohome.com.cn/config/*
// @match        https://*.autohome.com.cn/spec/*
// @icon         https://raw.githubusercontent.com/travisoa/scriptbox/main/userscripts/assets/autohome-config-export.png
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
  const FLOATING_ICON_URL =
    "https://raw.githubusercontent.com/travisoa/scriptbox/main/userscripts/assets/autohome-config-export.png";
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
    // 单个「● 皮质」这类描述性取值去掉前导圆点；复合项保留每个子项的圆点。
    const markCount = (s.match(/[●○]/g) || []).length;
    if (markCount === 1) s = s.replace(/^[●○]\s+(?=\S)/, "");
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

  /* ---- 按车型分组（能源类型 / 驱动形式 / 年款…） ---- */

  // 全表行铺平，便于按某一行的取值给车型归类
  function flattenRows(data) {
    const out = [];
    data.categories.forEach((c) =>
      c.rows.forEach((r) => out.push({ label: r[0], vals: r.slice(1) }))
    );
    return out;
  }

  // 把「驱动方式 / 电机布局」取值归一为 两驱/四驱/后驱/前驱
  function bucketDrive(v) {
    if (/四驱/.test(v)) return "四驱";
    if (/前.*后|后.*前/.test(v)) return "四驱"; // 前置+后置（双电机）即四驱
    if (/后驱|后置/.test(v)) return "后驱";
    if (/前驱|前置/.test(v)) return "前驱";
    if (/两驱/.test(v)) return "两驱";
    return "";
  }

  // row 标签与维度名是否相关（共享任意 2 字子串）
  function rowRelated(label, dimName) {
    for (let i = 0; i + 2 <= dimName.length; i++) {
      if (label.indexOf(dimName.substr(i, 2)) >= 0) return true;
    }
    return false;
  }

  // 从页面表头上方的筛选区提取可分组维度 [{name, options}]
  function getFilterDimensions() {
    let panel = null,
      best = 1e9;
    document.querySelectorAll("div,form").forEach((e) => {
      const t = (e.innerText || "").replace(/\s+/g, "");
      if (!t || t.length >= best || t.length > 320) return;
      const hits = (t.match(/能源类型|驱动形式|年款|变速箱|排量|续航|座位|级别/g) || []).length;
      if (hits >= 2) {
        panel = e;
        best = t.length;
      }
    });
    if (!panel) return [];
    const dims = [],
      seen = {};
    panel.querySelectorAll("*").forEach((row) => {
      if (row.children.length < 2) return;
      const first = row.children[0];
      if (first.children.length !== 0) return; // 维度名必须是叶子节点
      const name = (first.innerText || "").trim();
      if (!name || name.length > 8 || /^全部/.test(name)) return;
      if ((row.innerText || "").length > 60) return; // 只取较短的条件行
      const opts = [];
      for (let i = 1; i < row.children.length; i++) {
        const c = row.children[i];
        const leaves = c.children.length
          ? Array.from(c.querySelectorAll("*")).filter((x) => x.children.length === 0)
          : [c];
        leaves.forEach((l) => {
          const tx = (l.innerText || "").trim();
          if (tx) opts.push(tx);
        });
      }
      const options = Array.from(new Set(opts)).filter(
        (o) => o && o !== name && !/^全部/.test(o)
      );
      if (name && options.length && !seen[name]) {
        seen[name] = 1;
        dims.push({ name, options });
      }
    });
    return dims;
  }

  // 筛选区取不到时（旧版页面等），从数据本身推导维度
  function deriveDimensions(data) {
    const rows = flattenRows(data),
      cars = data.cars,
      dims = [];
    const uniq = (a) => Array.from(new Set(a.filter(Boolean)));
    const er = rows.find((r) => /能源类型/.test(r.label));
    if (er) {
      const o = uniq(er.vals);
      if (o.length > 1) dims.push({ name: "能源类型", options: o });
    }
    const dr = rows.find((r) => /^驱动方式$|^驱动形式$/.test(r.label));
    if (dr) {
      const o = uniq(dr.vals.map(bucketDrive));
      if (o.length > 1) dims.push({ name: "驱动形式", options: o });
    }
    const years = uniq(cars.map((c) => (c.name.match(/(\d{4})\s*款/) || [])[0]));
    if (years.length > 1) dims.push({ name: "年款", options: years });
    return dims;
  }

  function getGroupDimensions(data) {
    let dims = getFilterDimensions();
    if (!dims.length) dims = deriveDimensions(data);
    return dims.filter((d) => d.options.length >= 1);
  }

  // 计算每个车型在某维度下的组名（按列顺序）
  function carGroupKeys(dim, data) {
    const opts = dim.options.map((o) => o.trim());
    const rows = flattenRows(data);
    const cars = data.cars;
    const matchOpt = (text) => {
      if (!text) return null;
      let hit = opts.find((o) => text.indexOf(o) >= 0);
      if (hit) return hit;
      const b = bucketDrive(text); // 驱动类归一后再比
      if (b) {
        hit = opts.find((o) => o.indexOf(b) >= 0 || b.indexOf(o) >= 0);
        if (hit) return hit;
      }
      return null;
    };
    // 1) 优先：在与维度名相关的配置行里找能给所有车型归类的那一行
    //    （避免「电机布局: 前置+后置」这类无关行抢先误判驱动形式）
    const related = rows.filter((r) => rowRelated(r.label, dim.name));
    for (const row of related) {
      const keys = cars.map((c, ci) => matchOpt(row.vals[ci]));
      if (keys.every(Boolean)) return keys;
    }
    // 2) 兜底：扫描全表任意一行
    for (const row of rows) {
      const keys = cars.map((c, ci) => matchOpt(row.vals[ci]));
      if (keys.every(Boolean)) return keys;
    }
    // 3) 退化：车型名 + 全表逐车匹配，仍匹配不到归入「其他」
    return cars.map((c, ci) => {
      let k = matchOpt(c.name);
      if (k) return k;
      for (const row of rows) {
        k = matchOpt(row.vals[ci]);
        if (k) return k;
      }
      return "其他";
    });
  }

  // 按维度把车型列拆成若干组 [{name, idx:[列下标]}]
  function buildGroups(data, dim) {
    const keys = carGroupKeys(dim, data);
    const order = dim.options.slice();
    keys.forEach((k) => {
      if (order.indexOf(k) < 0) order.push(k);
    });
    return order
      .map((g) => ({
        name: g,
        idx: keys.map((k, i) => (k === g ? i : -1)).filter((i) => i >= 0),
      }))
      .filter((g) => g.idx.length);
  }

  // 取某组车型对应的分类（按列下标裁剪取值）
  function subsetCat(cat, idx) {
    return {
      name: cat.name,
      rows: cat.rows.map((r) => [r[0]].concat(idx.map((i) => r[i + 1]))),
    };
  }

  /* ---- 生成并下载 Excel ----
     mode:     "split" 每个分类一个工作表；"merge" 合并为一个工作表
     groupDim: 为 null 时不分组；否则按该维度把车型拆成多组分别导出 */
  function exportExcel(data, cats, mode, groupDim) {
    const wb = XLSX.utils.book_new();
    const used = new Set();
    const groups = groupDim
      ? buildGroups(data, groupDim)
      : [{ name: null, idx: data.cars.map((_, i) => i) }];

    groups.forEach((g) => {
      const gcars = g.idx.map((i) => data.cars[i]);
      const gcats = cats.map((c) => subsetCat(c, g.idx));
      if (mode === "merge") {
        const aoa = [headerRow(gcars)];
        gcats.forEach((cat) => {
          aoa.push(["【" + cat.name + "】"]); // 分类分隔行
          cat.rows.forEach((r) => aoa.push(r));
        });
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        ws["!cols"] = fitColumns(aoa);
        const sheetName = g.name || data.series + "配置";
        XLSX.utils.book_append_sheet(wb, ws, sanitizeSheetName(sheetName, used));
      } else {
        gcats.forEach((cat) => {
          const aoa = categoryToAoa(cat, gcars);
          const ws = XLSX.utils.aoa_to_sheet(aoa);
          ws["!cols"] = fitColumns(aoa);
          const sheetName = g.name ? g.name + "-" + cat.name : cat.name;
          XLSX.utils.book_append_sheet(wb, ws, sanitizeSheetName(sheetName, used));
        });
      }
    });

    const d = new Date();
    const stamp =
      d.getFullYear() +
      String(d.getMonth() + 1).padStart(2, "0") +
      String(d.getDate()).padStart(2, "0");
    const by = groupDim ? "_按" + groupDim.name : "";
    const fname = `${data.series}_配置参数${by}_${stamp}.xlsx`;
    XLSX.writeFile(wb, fname);
  }

  /* ---------------------------------------------------------------- UI */

  const style = document.createElement("style");
  style.textContent = `
#${PANEL_ID}{position:fixed;z-index:999999;right:18px;bottom:90px;font:13px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#1f2329;}
#${PANEL_ID} *{box-sizing:border-box;}
#${PANEL_ID}.collapsed .ace-panel{display:none;}
#${PANEL_ID} .ace-fab{width:${COLLAPSED_SIZE}px;height:${COLLAPSED_SIZE}px;border-radius:50%;background:#eef7ff;display:flex;align-items:center;justify-content:center;cursor:grab;box-shadow:0 6px 18px rgba(0,0,0,.22);user-select:none;overflow:hidden;}
#${PANEL_ID} .ace-fab img{width:78%;height:78%;display:block;object-fit:contain;border-radius:50%;pointer-events:none;}
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
#${PANEL_ID} .ace-group{display:flex;align-items:center;gap:8px;padding:8px 12px 4px;border-top:1px solid #eef0f2;color:#646a73;}
#${PANEL_ID} .ace-group select{flex:1;padding:5px 6px;border:1px solid #dcdfe3;border-radius:6px;background:#fff;color:#1f2329;font-size:13px;cursor:pointer;}
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
    <div class="ace-fab" title="导出配置到 Excel"><img src="${FLOATING_ICON_URL}" alt=""></div>
    <div class="ace-panel">
      <div class="ace-head"><b>配置导出 Excel</b><span class="ace-x" title="收起">—</span></div>
      <div class="ace-meta"></div>
      <div class="ace-tools"><a data-act="all">全选</a><a data-act="none">清空</a><span class="sp"></span><span id="ace-count"></span></div>
      <div class="ace-list"></div>
      <div class="ace-group">按车型分组
        <select class="ace-group-sel"><option value="">不分组</option></select>
      </div>
      <div class="ace-mode">
        <label><input type="radio" name="ace-mode" value="merge" checked> 合并一页</label>
        <label><input type="radio" name="ace-mode" value="split"> 分表(每类一页)</label>
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
  const groupSel = root.querySelector(".ace-group-sel");

  let DATA = null;
  let DIMS = [];
  let retryTimer = null;
  let renderRetries = 0;
  const MAX_RENDER_RETRIES = 30; // 30 × 500ms ≈ 15s，等待配置异步加载

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
    // 填充「按车型分组」下拉（从表头筛选区或数据推导）
    const prev = groupSel.value;
    DIMS = DATA.cars.length ? getGroupDimensions(DATA) : [];
    groupSel.innerHTML =
      '<option value="">不分组</option>' +
      DIMS.map(
        (d, i) => `<option value="${i}">按${d.name}（${d.options.length} 组）</option>`
      ).join("");
    if (prev && DIMS[Number(prev)]) groupSel.value = prev;
    refreshCount();
  }

  function dataIncomplete() {
    return !DATA || !DATA.categories.length || !DATA.cars.length;
  }

  // 渲染一次；若配置还在异步加载（新版页面数据是 XHR 后注入的），
  // 且面板处于展开态，则定时重试，直到识别到数据或超时。
  function requestRender(reset) {
    if (reset) renderRetries = 0;
    clearTimeout(retryTimer);
    retryTimer = null;
    renderList();
    if (dataIncomplete() && !root.classList.contains("collapsed")) {
      if (renderRetries < MAX_RENDER_RETRIES) {
        renderRetries++;
        meta.innerHTML = "正在读取配置数据…（页面加载中，请稍候）";
        retryTimer = setTimeout(() => requestRender(false), 500);
      }
    }
    keepInViewport(); // 数据加载后列表变高，重新夹回可视区域
  }

  function currentGroupDim() {
    const v = groupSel.value;
    return v === "" ? null : DIMS[Number(v)] || null;
  }

  function selectedCategories() {
    const idxs = Array.from(list.querySelectorAll("input[type=checkbox]:checked")).map((c) =>
      Number(c.dataset.idx)
    );
    return idxs.map((i) => DATA.categories[i]);
  }

  function currentMode() {
    const r = root.querySelector('input[name="ace-mode"]:checked');
    return r ? r.value : "merge";
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
      const dim = currentGroupDim();
      exportExcel(DATA, cats, currentMode(), dim);
      toast(
        dim
          ? `已按${dim.name}分组导出 ${cats.length} 个分类`
          : `已导出 ${cats.length} 个分类`
      );
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

  /* ---- 位置：始终保持在可视区域内 ---- */
  const DEFAULT_RIGHT = 18;
  const DEFAULT_BOTTOM = 90;

  function rootSize() {
    if (root.classList.contains("collapsed")) {
      return { w: COLLAPSED_SIZE, h: COLLAPSED_SIZE };
    }
    const r = root.getBoundingClientRect();
    return {
      w: Math.min(r.width || 300, window.innerWidth - PANEL_MARGIN * 2),
      h: Math.min(r.height || 200, window.innerHeight - PANEL_MARGIN * 2),
    };
  }

  function applyPos(left, top, save) {
    const { w, h } = rootSize();
    const maxLeft = Math.max(PANEL_MARGIN, window.innerWidth - w - PANEL_MARGIN);
    const maxTop = Math.max(PANEL_MARGIN, window.innerHeight - h - PANEL_MARGIN);
    const l = Math.round(Math.min(Math.max(left, PANEL_MARGIN), maxLeft));
    const t = Math.round(Math.min(Math.max(top, PANEL_MARGIN), maxTop));
    root.style.left = l + "px";
    root.style.top = t + "px";
    root.style.right = "auto";
    root.style.bottom = "auto";
    if (save) {
      try {
        localStorage.setItem(POS_KEY, JSON.stringify({ left: l, top: t }));
      } catch (e) {}
    }
  }

  function defaultPos() {
    const { w, h } = rootSize();
    return {
      left: Math.max(PANEL_MARGIN, window.innerWidth - w - DEFAULT_RIGHT),
      top: Math.max(PANEL_MARGIN, window.innerHeight - h - DEFAULT_BOTTOM),
    };
  }

  function readSavedPos() {
    try {
      const p = JSON.parse(localStorage.getItem(POS_KEY) || "null");
      if (p) {
        const left = parseInt(p.left, 10);
        const top = parseInt(p.top, 10);
        if (Number.isFinite(left) && Number.isFinite(top)) return { left, top };
      }
    } catch (e) {}
    return null;
  }

  // 收起态：回到用户保存的拖拽位置；展开态：把面板夹回可视区域（不覆盖保存位置）
  function keepInViewport() {
    if (root.classList.contains("collapsed")) {
      const s = readSavedPos() || defaultPos();
      applyPos(s.left, s.top, false);
    } else {
      const r = root.getBoundingClientRect();
      applyPos(r.left, r.top, false);
    }
  }

  // 展开 / 收起
  function setCollapsed(v) {
    root.classList.toggle("collapsed", v);
    try {
      localStorage.setItem(COLLAPSED_KEY, v ? "1" : "0");
    } catch (e) {}
    if (v) {
      clearTimeout(retryTimer); // 收起时停止重试
      retryTimer = null;
      keepInViewport();
    } else {
      requestRender(true); // 展开：渲染并在数据未就绪时自动重试
    }
  }

  fab.addEventListener("click", () => {
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
        applyPos(ev.clientX - offX, ev.clientY - offY, false);
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        if (moved) {
          const r = root.getBoundingClientRect();
          applyPos(r.left, r.top, true); // 保存拖拽后的位置
        }
        setTimeout(() => (root.dataset.dragged = "0"), 0);
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  }
  makeDraggable(fab);
  makeDraggable(head);

  // 窗口尺寸变化时保持在可视区域
  window.addEventListener("resize", keepInViewport);

  // SPA 路由切换（车系之间跳转）后，丢弃旧数据并在展开态重新识别
  let lastHref = location.href;
  function onUrlChange() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    DATA = null;
    DIMS = [];
    if (!root.classList.contains("collapsed")) requestRender(true);
  }
  ["pushState", "replaceState"].forEach((m) => {
    const orig = history[m];
    history[m] = function () {
      const ret = orig.apply(this, arguments);
      setTimeout(onUrlChange, 0);
      return ret;
    };
  });
  window.addEventListener("popstate", () => setTimeout(onUrlChange, 0));
  window.addEventListener("hashchange", () => setTimeout(onUrlChange, 0));
  setInterval(onUrlChange, 1500); // 兜底：捕捉未走 history API 的导航

  // 还原位置 / 折叠状态
  const savedInit = readSavedPos();
  if (savedInit) applyPos(savedInit.left, savedInit.top, false);
  if (localStorage.getItem(COLLAPSED_KEY) === "0") setCollapsed(false);
})();
