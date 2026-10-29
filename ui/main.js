// main.js — Markdown 编辑器工作台主逻辑（无框架，单 IIFE）
// 架构：state.blocks 为唯一真相；编辑器 DOM 由 axMd 渲染；每次输入后
// 序列化光标所在块 -> 更新模型 -> 局部重渲染 -> 按纯文本偏移恢复光标。
(function () {
  "use strict";

  var state = {
    blocks: [],
    path: null,
    mtime: 0,
    dirty: false,
    lang: "zh-CN",
    recent: [],
    dir: null,
    files: [],
    truncated: false,
    collapsed: {},
    sourceMode: false,
    typewriter: false,
    autosave: false,
    sidebar: true,
    composing: false,
    compositionTimer: 0,
    history: [],
    histIdx: -1,
  };
  var els = {};
  var toastTimer = null;
  var autosaveTimer = null;
  var rafId = 0;
  var imageCache = {};
  var activeDialogCancel = null;

  function $(id) { return document.getElementById(id); }
  function t(key) { return window.axI18n.get(key); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function basename(p) {
    return String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || String(p || "");
  }
  function dirname(p) {
    var s = String(p || "");
    var i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
    return i > 0 ? s.slice(0, i) : "";
  }
  function isList(type) { return type === "ul" || type === "ol" || type === "task"; }
  function isEmptySrc(b) {
    if (!b) return true;
    if (b.type === "p" || b.type === "code") return b.src === "";
    if (/^h[1-6]$/.test(b.type)) return b.src === "";
    return false;
  }

  /* ================= RPC / 存储 ================= */

  function rpc(method, params, timeoutMs) {
    if (!window.dbxPlugin || !window.dbxPlugin.invoke) {
      return Promise.reject(new Error(t("toast.bridgeError")));
    }
    return window.dbxPlugin.invoke(method, params || {}, { timeoutMs: timeoutMs || 30000 });
  }
  function hasStorage() {
    return !!(window.dbxPlugin && window.dbxPlugin.capabilities && window.dbxPlugin.capabilities.storage);
  }
  function storageGet(key) {
    if (!hasStorage()) return Promise.resolve(null);
    return window.dbxPlugin.storage.get(key);
  }
  function storageSet(key, val) {
    if (!hasStorage()) return Promise.resolve();
    return window.dbxPlugin.storage.set(key, val);
  }
  async function copyText(text) {
    try {
      if (window.dbxPlugin && window.dbxPlugin.clipboard && window.dbxPlugin.clipboard.writeText) {
        await window.dbxPlugin.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* 降级 */ }
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  /* ================= 启动 ================= */

  async function boot() {
    cacheEls();
    bindStaticEvents();
    try {
      await window.dbxPlugin.ready;
    } catch (e) {
      toast(t("toast.bridgeError"));
    }
    var ctx = (window.dbxPlugin && window.dbxPlugin.context) || {};
    var locale = (ctx.theme && ctx.theme.locale) || "zh-CN";
    try {
      var savedLang = await storageGet("lang");
      if (savedLang === "zh-CN" || savedLang === "en") locale = savedLang;
      var prefs = await storageGet("prefs");
      if (prefs && typeof prefs === "object") {
        if (prefs.sidebar === false) state.sidebar = false;
        if (prefs.typewriter) state.typewriter = true;
        if (prefs.autosave) state.autosave = true;
      }
      var recent = await storageGet("recent");
      if (Array.isArray(recent)) state.recent = recent.filter(function (r) { return r && r.path; });
    } catch (e) { /* 存储不可用用默认值 */ }

    state.lang = locale;
    window.axI18n.set(locale);
    applyStaticI18n();
    bindDynamicLabels();
    applyPrefsUI();
    renderRecent();

    // mermaid 初始化（图表块渲染用；库缺失时图表退化为源码展示）
    if (typeof window.mermaid !== "undefined" && window.mermaid.initialize) {
      try {
        window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default" });
      } catch (e) { /* 忽略：enhanceCharts 有降级 */ }
    }

    var opened = false;
    if (state.recent.length) {
      try {
        var res = await rpc("fs/read", { path: state.recent[0].path });
        loadDoc(res.content, state.recent[0].path, res.mtime);
        opened = true;
      } catch (e) { /* 文件没了就进欢迎页 */ }
    }
    if (!opened) loadDoc(welcomeMd(), null, 0);
    startTimers();
  }

  function cacheEls() {
    [
      "doc-name", "dirty-dot", "dirty-dot-2", "status-file", "status-ext", "status-counts",
      "btn-new", "btn-open", "btn-save", "btn-export", "btn-sidebar", "btn-source", "btn-typewriter", "btn-help",
      "toolbar", "sel-heading", "sidebar", "pane-files", "pane-outline", "pane-picker",
      "picker-up", "picker-crumb", "picker-list", "picker-empty", "picker-name", "picker-cancel", "picker-ok",
      "btn-open-dir", "inp-dir", "btn-dir-go", "files-tree", "btn-clear-recent", "recent-list",
      "outline-list", "editor-wrap", "editor", "source",
      "overlay", "dlg-title", "dlg-body", "dlg-foot", "dlg-close", "toast", "btn-autosave",
    ].forEach(function (id) { els[id] = $(id); });
  }

  function applyStaticI18n() {
    document.querySelectorAll("[data-i18n]").forEach(function (n) {
      n.textContent = t(n.getAttribute("data-i18n"));
    });
    document.querySelectorAll("[data-i18n-title]").forEach(function (n) {
      n.setAttribute("title", t(n.getAttribute("data-i18n-title")));
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach(function (n) {
      n.setAttribute("placeholder", t(n.getAttribute("data-i18n-placeholder")));
    });
  }

  function iconBtn(id, iconName) {
    var b = $(id);
    if (b) b.innerHTML = window.axIcons.get(iconName);
    return b;
  }

  function bindDynamicLabels() {
    iconBtn("btn-new", "file-plus");
    iconBtn("btn-open", "folder");
    iconBtn("btn-save", "save");
    iconBtn("btn-export", "download");
    iconBtn("btn-sidebar", "sidebar");
    iconBtn("btn-source", "edit");
    iconBtn("btn-typewriter", "crosshair");
    iconBtn("btn-help", "help");
    var cmds = {
      bold: "bold", italic: "italic", strike: "strike", code: "code",
      ul: "list", ol: "list-ordered", task: "check-square", quote: "quote",
      link: "link", image: "image", codeblock: "file-code", table: "table", hr: "minus",
    };
    document.querySelectorAll(".tb-btn[data-cmd]").forEach(function (b) {
      b.innerHTML = window.axIcons.get(cmds[b.dataset.cmd] || "file-text");
    });
    applyTableLabels();
  }

  function applyTableLabels() {
    var map = {
      addRow: "tbl.addRow", delRow: "tbl.delRow", addCol: "tbl.addCol", delCol: "tbl.delCol",
      deleteTable: "tbl.deleteTable"
    };
    document.querySelectorAll(".tbl-btn[data-op]").forEach(function (b) {
      b.textContent = t(map[b.dataset.op] || "");
    });
    document.querySelectorAll(".code-copy").forEach(function (b) {
      b.innerHTML = window.axIcons.get("copy");
      b.setAttribute("title", t("code.copy"));
    });
  }

  function applyPrefsUI() {
    els.sidebar.classList.toggle("collapsed", !state.sidebar);
    els["btn-sidebar"].classList.toggle("active", state.sidebar);
    els["btn-typewriter"].classList.toggle("active", state.typewriter);
    els["btn-autosave"].classList.toggle("active", state.autosave);
    els["btn-source"].classList.toggle("active", state.sourceMode);
  }

  function persistPrefs() {
    storageSet("prefs", {
      sidebar: state.sidebar,
      typewriter: state.typewriter,
      autosave: state.autosave,
    });
  }

  function welcomeMd() {
    if (state.lang === "en") {
      return [
        "# Welcome to the Markdown Editor",
        "",
        "A **WYSIWYG** Markdown editor living inside a DBX plugin, modeled after Typora.",
        "",
        "## Quick Start",
        "",
        "- Type and see it rendered: `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``",
        "- Line starters: `# ` heading, `- ` list, `1. ` ordered list, `> ` quote, ` ``` ` code block, `---` divider",
        "- `Ctrl+B` / `Ctrl+I` bold / italic, `Ctrl+K` insert link",
        "- `Ctrl+S` save, `Ctrl+O` open, `Ctrl+E` export HTML",
        "- The Files panel browses folders; the Outline panel navigates headings",
        "",
        "## Task List",
        "",
        "- [x] Open a local Markdown file",
        "- [ ] Write the first note",
        "",
        "## Table",
        "",
        "| Action | Shortcut |",
        "| --- | --- |",
        "| Bold | Ctrl+B |",
        "| Italic | Ctrl+I |",
        "| Save | Ctrl+S |",
        "",
        "> Tip: click Open above, or drop a .md file into the editor.",
        "",
        "## Math and Footnotes",
        "",
        "Inline math $E=mc^2$ and block math:",
        "",
        "$$",
        "\\int_0^1 x^2 \\, dx = \\frac{1}{3}",
        "$$",
        "",
        "Footnote references[^1] are numbered automatically; definitions are collected at the end.",
        "",
        "[^1]: This is a footnote definition, editable in place.",
        "",
        "More block types (Mermaid charts, YAML front matter) live in the toolbar Paragraph menu.",
      ].join("\n");
    }
    return [
      "# 欢迎使用 Markdown 编辑器",
      "",
      "这是一个 DBX 插件内的**所见即所得** Markdown 编辑器，对标 Typora 的核心体验。",
      "",
      "## 快速上手",
      "",
      "- 直接输入即渲染：`**加粗**`、`*斜体*`、`~~删除线~~`、`` `行内代码` ``",
      "- 行首快捷键：`# ` 标题、`- ` 列表、`1. ` 有序列表、`> ` 引用、` ``` ` 代码块、`---` 分割线",
      "- `Ctrl+B` / `Ctrl+I` 加粗 / 斜体，`Ctrl+K` 插入链接",
      "- `Ctrl+S` 保存，`Ctrl+O` 打开，`Ctrl+E` 导出 HTML",
      "- 左侧「文件」面板可打开文件夹浏览笔记，「大纲」面板导航标题",
      "",
      "## 任务列表",
      "",
      "- [x] 打开本地 Markdown 文件",
      "- [ ] 写下第一篇笔记",
      "",
      "## 表格",
      "",
      "| 操作 | 快捷键 |",
      "| --- | --- |",
      "| 加粗 | Ctrl+B |",
      "| 斜体 | Ctrl+I |",
      "| 保存 | Ctrl+S |",
      "",
      "> 提示：点击左上角「打开」选择文件，或把 .md 文件拖进编辑区。",
      "",
      "## 公式与脚注",
      "",
      "行内公式 $E=mc^2$ 与块级公式：",
      "",
      "$$",
      "\\int_0^1 x^2 \\, dx = \\frac{1}{3}",
      "$$",
      "",
      "脚注引用[^1]会自动编号，定义收集在文末。",
      "",
      "[^1]: 这是脚注定义，可直接编辑。",
      "",
      "更多块类型（Mermaid 图表、YAML Front Matter）见工具栏「段落」菜单。",
    ].join("\n");
  }

  function startTimers() {
    setInterval(pollExternal, 5000);
    document.addEventListener("selectionchange", onSelChange);
  }

  /* ================= 文档加载 / 保存 ================= */

  // 核心模块缺失时的诊断横幅（与 index.html 尾部探针协同，幂等）。
  // 触发场景：宿主沙箱内联脚本失败（如 script 标签序列被截断）导致 axMd 未挂载。
  function showBootError(detail) {
    var old = document.querySelector("[data-boot-error]");
    if (old) old.remove();
    var d = document.createElement("div");
    d.setAttribute("data-boot-error", "1");
    d.style.cssText = "position:fixed;left:8px;right:8px;bottom:8px;z-index:2147483647;max-height:45%;overflow:auto;background:#7f1d1d;color:#fff;font:12px/1.6 monospace;padding:10px 12px;border-radius:8px;box-shadow:0 4px 24px rgba(0,0,0,.4)";
    var errs = window.__bootErrors || [];
    var msg = (window.axI18n && typeof t === "function" ? t("err.coreMissing") : "编辑器核心未加载") +
      (detail ? "：" + detail : "");
    d.textContent = msg + "\n" +
      (errs.length ? "捕获到 " + errs.length + " 个错误：\n- " + errs.slice(0, 10).join("\n- ")
        : "未捕获到错误（可能脚本被宿主沙箱拦截，未能开始执行）");
    document.body.appendChild(d);
  }

  function currentSrc() { return window.axMd.serialize(state.blocks); }

  function loadDoc(content, path, mtime) {
    if (!window.axMd) { showBootError(); return; }
    state.path = path || null;
    state.mtime = mtime || 0;
    state.blocks = window.axMd.parse(content == null ? "" : content);
    state.dirty = false;
    state.history = [];
    state.histIdx = -1;
    pushHistory();
    renderAll();
    updateTitle();
    updateStatus();
    updateCounts();
    updateOutline();
    if (state.sourceMode) els.source.value = content == null ? "" : content;
  }

  function renderAll() {
    var frag = document.createDocumentFragment();
    for (var i = 0; i < state.blocks.length; i++) {
      frag.appendChild(window.axMd.renderBlock(state.blocks[i]));
    }
    els.editor.innerHTML = "";
    els.editor.appendChild(frag);
    applyTableLabels();
    resolveImages();
    enhanceCharts();
  }

  function rerenderBlock(b, pt) {
    var old = b._el;
    var node = window.axMd.renderBlock(b);
    if (old && old.parentNode) old.replaceWith(node);
    applyTableLabels();
    resolveImages();
    enhanceCharts();
    if (pt != null) window.axMd.setPlainOffset(node, pt);
    return node;
  }

  function insertBlockAfter(idx, nb) {
    state.blocks.splice(idx + 1, 0, nb);
    var node = window.axMd.renderBlock(nb);
    if (state.blocks[idx]._el && state.blocks[idx]._el.parentNode) {
      state.blocks[idx]._el.after(node);
    } else {
      renderAll();
    }
    applyTableLabels();
    resolveImages();
    enhanceCharts();
    return nb;
  }

  function removeBlockAt(idx) {
    var node = state.blocks[idx]._el;
    state.blocks.splice(idx, 1);
    if (node && node.parentNode) node.remove();
  }

  function updateTitle() {
    var name = state.path ? basename(state.path) : "untitled.md";
    els["doc-name"].textContent = name + (state.dirty ? " •" : "");
    els["status-file"].textContent = state.path || name;
    els["dirty-dot"].classList.toggle("dirty", state.dirty);
    els["dirty-dot-2"].classList.toggle("dirty", state.dirty);
  }

  function updateStatus() {
    updateTitle();
  }

  function updateCounts() {
    var plain = window.axMd.plainText(state.blocks);
    var chars = plain.replace(/\s/g, "").length;
    var cjk = (plain.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
    var words = (plain.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, " ").match(/[A-Za-z0-9_'-]+/g) || []).length + cjk;
    els["status-counts"].textContent =
      words + " " + t("status.words") + " · " + chars + " " + t("status.chars") + " · " +
      state.blocks.length + " " + t("status.blocks");
  }

  function markDirty() {
    if (!state.dirty) {
      state.dirty = true;
      updateTitle();
    }
    scheduleAutosave();
  }

  function afterChange() {
    markDirty();
    updateCounts();
    updateOutline();
    // 记录变更后的快照，否则 redo 只能恢复到变更前的状态。
    pushHistory();
  }

  function scheduleAutosave() {
    if (!state.autosave || !state.path) return;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(function () {
      if (state.autosave && state.path && state.dirty) save(true);
    }, 2000);
  }

  async function save(silent) {
    if (state.sourceMode) syncFromSource();
    if (!window.axMd) { toast(t("err.coreMissing")); return false; }
    if (!state.path) return saveAs();
    try {
      var res = await rpc("fs/write", { path: state.path, content: currentSrc() });
      state.mtime = res.mtime;
      state.dirty = false;
      updateTitle();
      hideExt();
      if (!silent) toast(t("toast.saved"));
      return true;
    } catch (e) {
      toast(t("toast.saveFail") + ": " + e.message);
      return false;
    }
  }

  function saveAs() {
    if (state.sourceMode) syncFromSource();
    var name = state.path ? basename(state.path) : "untitled.md";
    var startDir = state.path ? dirname(state.path) : (state.dir || "");
    return new Promise(function (resolve) {
      pickWithFallback("save", {
        name: name,
        ext: "md",
        startDir: startDir,
        resolve: function (p) {
          if (!p) { resolve(false); return; }
          state.path = p;
          save().then(resolve);
        },
      });
    });
  }

  function openFileDialog() {
    pickWithFallback("open", {
      filter: "markdown",
      startDir: state.dir || "",
      resolve: function (p) {
        if (p) openFile(p);
      },
    });
  }

  async function openFile(path, opts) {
    opts = opts || {};
    if (state.dirty && !opts.force) {
      var c = await confirmSaveDialog();
      if (c === "cancel") return false;
      if (c === "save") {
        var okSaved = await save(true);
        if (!okSaved) return false;
      }
    }
    try {
      var res = await rpc("fs/read", { path: path });
      loadDoc(res.content, path, res.mtime);
      addRecent(path);
      renderFiles();
      return true;
    } catch (e) {
      toast(t("toast.openFail") + ": " + e.message);
      return false;
    }
  }

  async function openFolder(path) {
    try {
      var res = await rpc("fs/list", { dir: path });
      state.dir = res.root;
      state.files = res.entries || [];
      state.truncated = !!res.truncated;
      state.collapsed = {};
      renderFiles();
      toast(t("toast.dirOpened"));
    } catch (e) {
      toast(t("toast.openFail") + ": " + e.message);
    }
  }

  // ================= 内置文件/文件夹选择器（原生对话框不可用时的降级） =================
  // 原生对话框依赖 sidecar  spawn powershell.exe；DBX 宿主环境可能限制子进程，
  // 此时自动改用内置选择器（纯 fs/browse RPC，无外部依赖）。
  var picker = { mode: "dir", path: "", entries: [], sel: null, name: "", ext: "md", resolve: null };
  var nativeDialogOk = true; // 首次失败后置 false，后续直接走内置选择器

  // 侧栏面板切换（files / outline / picker）
  function showPane(which) {
    els["pane-files"].classList.toggle("hidden", which !== "files");
    els["pane-outline"].classList.toggle("hidden", which !== "outline");
    els["pane-picker"].classList.toggle("hidden", which !== "picker");
    var tabWhich = which === "picker" ? "files" : which;
    document.querySelectorAll(".side-tab").forEach(function (x) {
      x.classList.toggle("active", x.dataset.tab === tabWhich);
    });
  }

  // 打开内置选择器。mode: dir=选文件夹 | open=选文件 | save=保存/导出
  // opts: { filter, name, ext, resolve(path|null) }
  function openPicker(mode, opts) {
    opts = opts || {};
    picker.mode = mode;
    picker.name = opts.name || "";
    picker.ext = opts.ext || "md";
    picker.sel = null;
    picker.resolve = opts.resolve || function () {};
    if (!state.sidebar) { state.sidebar = true; applyPrefsUI(); persistPrefs(); }
    showPane("picker");
    els["picker-ok"].textContent = mode === "save" ? t("picker.save")
      : mode === "open" ? t("picker.open") : t("picker.selectFolder");
    els["picker-name"].classList.toggle("hidden", mode !== "save");
    if (mode === "save") els["picker-name"].value = picker.name;
    pickerLoad(opts.startDir || "");
  }

  function pickerParent(p) {
    if (!p) return "";
    var norm = String(p).replace(/\//g, "\\").replace(/\\+$/, "");
    if (/^[A-Za-z]:$/.test(norm)) return ""; // 盘根 -> 回到驱动器列表
    var i = norm.lastIndexOf("\\");
    if (i <= 0) return "";
    return norm.slice(0, i + 1);
  }

  function pickerLoad(dir) {
    picker.path = dir || "";
    picker.sel = null;
    rpc("fs/browse", { dir: picker.path }).then(function (res) {
      picker.entries = res.entries || [];
      pickerRender();
    }).catch(function (e) {
      picker.entries = [];
      pickerRender();
      toast(t("toast.openFail") + ": " + e.message);
    });
  }

  function pickerRender() {
    // 面包屑
    var crumb = els["picker-crumb"];
    crumb.innerHTML = "";
    var mkSeg = function (label, target) {
      var b = el("button", "crumb-seg", label);
      b.type = "button";
      b.addEventListener("click", function () { pickerLoad(target); });
      crumb.appendChild(b);
    };
    if (!picker.path) {
      mkSeg(t("picker.thisPC"), "");
    } else {
      var parts = picker.path.replace(/\//g, "\\").replace(/\\+$/, "").split("\\").filter(Boolean);
      mkSeg(parts[0] || "\\", (parts[0] || "") + "\\");
      for (var i = 1; i < parts.length; i++) {
        (function (label, target) {
          mkSeg(label, target);
        })(parts[i], parts.slice(0, i + 1).join("\\"));
      }
    }
    els["picker-up"].style.visibility = picker.path ? "visible" : "hidden";

    // 条目列表
    var list = els["picker-list"];
    list.innerHTML = "";
    els["picker-empty"].classList.toggle("hidden", picker.entries.length > 0);
    picker.entries.forEach(function (e) {
      var row = el("button", "picker-row" + (e.isDir ? "" : " is-file"));
      row.type = "button";
      row.setAttribute("role", "option");
      if (picker.sel && picker.sel.path === e.path) row.classList.add("sel");
      var ico = el("span", "picker-ico");
      ico.innerHTML = window.axIcons.get(e.isDir ? "folder" : "file-text");
      row.appendChild(ico);
      row.appendChild(el("span", "picker-label", e.name));
      row.addEventListener("click", function () {
        picker.sel = e;
        if (!e.isDir && picker.mode === "save") {
          els["picker-name"].value = e.name;
          picker.name = e.name;
        }
        pickerRender();
      });
      row.addEventListener("dblclick", function () {
        if (e.isDir) pickerLoad(e.path);
        else pickerConfirm();
      });
      list.appendChild(row);
    });
  }

  function pickerClose(path) {
    var resolve = picker.resolve;
    picker.resolve = null;
    showPane("files");
    resolve(path);
  }

  function pickerConfirm() {
    var path = null;
    if (picker.mode === "dir") {
      path = picker.path || null;
    } else if (picker.mode === "open") {
      path = picker.sel && !picker.sel.isDir ? picker.sel.path : null;
      if (!path) { toast(t("picker.pickFile")); return; }
    } else if (picker.mode === "save") {
      var name = (els["picker-name"].value || "").trim();
      if (!name) { toast(t("picker.pickName")); return; }
      if (picker.ext === "html") {
        if (!/\.html?$/i.test(name)) name += ".html";
      } else if (!/\.[a-z0-9]+$/i.test(name)) {
        name += "." + picker.ext;
      }
      if (!picker.path) { toast(t("picker.pickDir")); return; }
      path = picker.path.replace(/\\+$/, "") + "\\" + name;
    }
    pickerClose(path);
  }

  // 原生对话框优先；失败自动降级内置选择器（并记住失败，后续不再重试）
  function pickWithFallback(kind, opts) {
    opts = opts || {};
    var method = kind === "dir" ? "fs/pickDir" : kind === "open" ? "fs/pickFile" : "fs/pickSaveFile";
    var params = {};
    if (kind === "open") params = { filter: opts.filter || "markdown" };
    if (kind === "save") params = { name: opts.name || "untitled.md", filter: opts.filter || "markdown" };
    function fallback(errMsg) {
      if (errMsg) console.error("[picker] native dialog failed:", errMsg);
      nativeDialogOk = false;
      toast(t("toast.dialogFallback"));
      openPicker(kind, opts);
    }
    if (!nativeDialogOk) { fallback(null); return; }
    rpc(method, params, 300000).then(function (res) {
      if (res.cancelled) return;
      if (res.path && opts.resolve) opts.resolve(res.path);
    }).catch(fallback);
  }

  async function exportHtml() {
    if (state.sourceMode) syncFromSource();
    var base = state.path ? basename(state.path).replace(/\.[^.]+$/, "") : "untitled";
    pickWithFallback("save", {
      name: base + ".html",
      filter: "html",
      ext: "html",
      resolve: async function (p) {
        if (!p) return;
        try {
          await rpc("fs/write", {
            path: p,
            content: window.axMd.toStandaloneHtml(state.blocks, base, state.lang),
          });
          toast(t("toast.exported"));
        } catch (e) {
          toast(t("toast.exportFail") + ": " + e.message);
        }
      },
    });
  }

  async function newFile() {
    if (state.dirty) {
      var c = await confirmSaveDialog();
      if (c === "cancel") return;
      if (c === "save") {
        var okSaved = await save(true);
        if (!okSaved) return;
      }
    }
    loadDoc("", null, 0);
    els.editor.focus();
  }

  async function pollExternal() {
    if (!state.path || state.sourceMode) return;
    try {
      var st = await rpc("fs/stat", { path: state.path });
      if (st.exists && st.mtime > state.mtime) {
        if (state.dirty) {
          showExt(true);
        } else {
          var res = await rpc("fs/read", { path: state.path });
          loadDoc(res.content, state.path, res.mtime);
          hideExt();
          toast(t("status.external"));
        }
      }
    } catch (e) { /* 轮询失败静默 */ }
  }

  function showExt(dirty) {
    els["status-ext"].textContent = t(dirty ? "status.externalDirty" : "status.external");
    els["status-ext"].classList.remove("hidden");
  }
  function hideExt() {
    els["status-ext"].classList.add("hidden");
  }

  /* ================= 历史（撤销/重做） ================= */

  function pushHistory() {
    var snap = { src: currentSrc(), caret: caretGlobalPlain() };
    state.history = state.history.slice(0, state.histIdx + 1);
    if (state.history.length && state.history[state.history.length - 1].src === snap.src) {
      state.histIdx = state.history.length - 1;
      return;
    }
    state.history.push(snap);
    if (state.history.length > 200) state.history.shift();
    state.histIdx = state.history.length - 1;
  }

  function restoreSnap(snap) {
    state.blocks = window.axMd.parse(snap.src);
    renderAll();
    setCaretGlobalPlain(snap.caret);
    markDirty();
    updateCounts();
    updateOutline();
  }

  function undo() {
    if (state.histIdx <= 0) return;
    state.histIdx--;
    restoreSnap(state.history[state.histIdx]);
  }

  function redo() {
    if (state.histIdx >= state.history.length - 1) return;
    state.histIdx++;
    restoreSnap(state.history[state.histIdx]);
  }

  /* ================= 光标定位工具 ================= */

  function caretBlockElFrom(node) {
    var n = node && (node.nodeType === 3 ? node.parentNode : node);
    if (!n || !n.closest) return null;
    var b = n.closest("[data-type]");
    return b && els.editor.contains(b) ? b : null;
  }
  function caretBlockEl() {
    var sel = window.getSelection();
    if (!sel.rangeCount) return null;
    return caretBlockElFrom(sel.anchorNode);
  }
  function blockByEl(node) {
    for (var i = 0; i < state.blocks.length; i++) {
      if (state.blocks[i]._el === node) return state.blocks[i];
    }
    return null;
  }
  function blockIndexByEl(node) {
    for (var i = 0; i < state.blocks.length; i++) {
      if (state.blocks[i]._el === node) return i;
    }
    return -1;
  }
  function caretAtBlockStart(node) { window.axMd.setPlainOffset(node, 0); }
  function caretAtBlockEnd(node) { window.axMd.setPlainOffset(node, window.axMd.plainLenOf(node)); }

  function blockEls() {
    var out = [];
    var kids = els.editor.children;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].dataset && kids[i].dataset.type) out.push(kids[i]);
    }
    return out;
  }

  // 光标在整篇文档中的纯文本偏移（块间按 \n\n 计）
  function caretGlobalPlain() {
    var sel = window.getSelection();
    var blockEl = caretBlockEl();
    if (!blockEl || !sel.rangeCount) return 0;
    var acc = 0;
    var elsArr = blockEls();
    for (var i = 0; i < elsArr.length; i++) {
      if (elsArr[i] === blockEl) return acc + window.axMd.plainOffsetIn(blockEl);
      acc += window.axMd.plainLenOf(elsArr[i]) + 2;
    }
    return 0;
  }

  function setCaretGlobalPlain(pt) {
    var elsArr = blockEls();
    for (var i = 0; i < elsArr.length; i++) {
      var len = window.axMd.plainLenOf(elsArr[i]);
      if (pt <= len) { window.axMd.setPlainOffset(elsArr[i], pt); return; }
      pt -= len + 2;
    }
    for (var j = elsArr.length - 1; j >= 0; j--) {
      window.axMd.setPlainOffset(elsArr[j], window.axMd.plainLenOf(elsArr[j]));
      return;
    }
  }

  function textWalkerOf(root) {
    return document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: function (n) {
        if (n.nodeType === 3) return NodeFilter.FILTER_ACCEPT;
        if (n.nodeType === 1 && n.tagName === "BR") return NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_SKIP;
      },
    });
  }

  function locateInEl(node, pt) {
    var w = textWalkerOf(node), acc = 0, n;
    while ((n = w.nextNode())) {
      var len = n.nodeType === 3 ? n.nodeValue.length : 1;
      if (acc + len >= pt) {
        if (n.nodeType === 3) return { node: n, offset: pt - acc };
        return { node: n.parentNode, offset: Array.prototype.indexOf.call(n.parentNode.childNodes, n) + 1 };
      }
      acc += len;
    }
    return { node: node, offset: node.childNodes.length };
  }

  function locateGlobalPlain(pt) {
    var elsArr = blockEls();
    for (var i = 0; i < elsArr.length; i++) {
      var len = window.axMd.plainLenOf(elsArr[i]);
      if (pt <= len) return locateInEl(elsArr[i], pt);
      pt -= len + 2;
    }
    var last = elsArr[elsArr.length - 1];
    return last ? { node: last, offset: last.childNodes.length } : { node: els.editor, offset: 0 };
  }

  function setSelectionGlobalPlain(p1, p2) {
    var a = locateGlobalPlain(p1), b = locateGlobalPlain(p2);
    var r = document.createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  // DOM 位置 -> 整篇文档的 Markdown 源偏移
  function globalSrcOffsetOf(node, offset) {
    var blockEl = caretBlockElFrom(node);
    if (!blockEl) return 0;
    var b = blockByEl(blockEl);
    if (!b) return 0;
    var base = blockSrcBase(b);
    if (b.type === "table") {
      var cell = cellInfo(node);
      if (!cell) return base;
      var cr = tableCellRange(b, cell.r, cell.c);
      return base + cr.start + window.axMd.srcOffsetIn(cell.td, node, offset);
    }
    var loc = window.axMd.blockSrcOffsetOf(b, node, offset);
    return base + localToSerialized(b, loc);
  }

  // 整篇文档的 Markdown 源偏移 -> DOM 位置（块间按 \n\n 计）
  function locateGlobalSrc(g) {
    var acc = 0;
    for (var i = 0; i < state.blocks.length; i++) {
      var b = state.blocks[i];
      var s = window.axMd.serializeBlock(b);
      if (g <= acc + s.length || i === state.blocks.length - 1) {
        var local = Math.max(0, Math.min(g - acc, s.length));
        if (b.type === "quote") {
          var nl = s.slice(0, local).split("\n").length - 1;
          local = local - 2 * (nl + 1);
        } else if (b.type === "code") {
          local = local - ("```" + (b.lang || "") + "\n").length;
        } else if (b.type === "table") {
          // 表格：src 偏移落在脚手架上的概率低，落在格内时按单元格纯文本定位
          var tp = window.axMd.tablePosFromSrc(s, local);
          var trs = b._el ? b._el.querySelectorAll("tr") : [];
          var tr = trs[tp.r];
          var td = tr ? tr.children[tp.c] : null;
          if (td) {
            var w = document.createTreeWalker(td, NodeFilter.SHOW_TEXT, null);
            var n2, acc2 = 0;
            while ((n2 = w.nextNode())) {
              if (acc2 + n2.nodeValue.length >= tp.cellOff) return { node: n2, offset: tp.cellOff - acc2 };
              acc2 += n2.nodeValue.length;
            }
            return { node: td, offset: td.childNodes.length };
          }
          return null;
        }
        return window.axMd.locateBlockSrcPos(b, local);
      }
      acc += s.length + 2;
    }
    return null;
  }

  function setCaretGlobalSrc(g) {
    var pos = locateGlobalSrc(g);
    if (!pos) return;
    var range = document.createRange();
    range.setStart(pos.node, pos.offset);
    range.collapse(true);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function setSelectionGlobalSrc(g1, g2) {
    var a = locateGlobalSrc(g1), b = locateGlobalSrc(g2);
    if (!a || !b) return;
    var r = document.createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  function blockSrcBase(b) {
    var base = 0;
    for (var i = 0; i < state.blocks.length; i++) {
      if (state.blocks[i] === b) return base;
      base += window.axMd.serializeBlock(state.blocks[i]).length + 2;
    }
    return base;
  }

  function localToSerialized(b, local) {
    if (b.type === "quote") {
      var nl = b.src.slice(0, local).split("\n").length - 1;
      return local + 2 * (nl + 1);
    }
    if (b.type === "code") return local + ("```" + (b.lang || "") + "\n").length;
    return local;
  }

  function selectionGlobalRange() {
    var sel = window.getSelection();
    if (!sel.rangeCount) return { start: 0, end: 0 };
    var r = sel.getRangeAt(0);
    var s = globalSrcOffsetOf(r.startContainer, r.startOffset);
    var e = sel.isCollapsed ? s : globalSrcOffsetOf(r.endContainer, r.endOffset);
    if (e < s) { var tmp = s; s = e; e = tmp; }
    return { start: s, end: e };
  }

  /* ================= 输入同步（编辑器心脏） ================= */

  function structureOk() {
    var elsArr = blockEls();
    if (elsArr.length !== state.blocks.length) return false;
    for (var i = 0; i < elsArr.length; i++) {
      if (elsArr[i] !== state.blocks[i]._el) return false;
    }
    return true;
  }

  function blocksFromContainer() {
    var out = [];
    var kids = els.editor.children;
    for (var i = 0; i < kids.length; i++) {
      var node = kids[i];
      if (!node.dataset || !node.dataset.type) continue;
      var arr = window.axMd.blockFromEl(node);
      for (var j = 0; j < arr.length; j++) out.push(arr[j]);
    }
    return out;
  }

  function fullRebuild(pt) {
    state.blocks = blocksFromContainer();
    renderAll();
    if (pt != null) setCaretGlobalPlain(pt);
  }

  // input 事件：只序列化光标所在块，局部重渲染，按源偏移恢复光标
  // （浏览器侧变更的兜底路径：IME 合成提交、以及未能模型驱动的输入类型）
  function syncCaretBlock() {
    var sel = window.getSelection();
    var blockEl = caretBlockEl();
    if (!blockEl) { fullRebuild(caretGlobalPlain()); return; }
    var b = blockByEl(blockEl);
    if (!b || !structureOk()) { fullRebuild(caretGlobalPlain()); return; }
    var pt = window.axMd.plainOffsetIn(blockEl);
    var arr = window.axMd.blockFromEl(blockEl);
    if (arr.length !== 1) { fullRebuild(caretGlobalPlain()); return; }
    var nb = arr[0];
    var g;
    if (isList(b.type)) {
      // 合成输入期间 b.src 仍是上一次模型快照；列表偏移映射会按旧条目长度
      // clamp 光标，导致中文提交后光标落在新文字之前。用当前 DOM 序列化结果映射。
      var liveBlock = { type: b.type, src: nb.src, _el: blockEl };
      g = blockSrcBase(b) + window.axMd.blockSrcOffsetOf(liveBlock, sel.anchorNode, sel.anchorOffset);
    } else {
      g = globalSrcOffsetOf(sel.anchorNode, sel.anchorOffset);
    }
    b.type = nb.type;
    b.src = nb.src;
    if (nb.lang != null) b.lang = nb.lang;
    rerenderBlock(b);
    setCaretGlobalSrc(g);
  }

  // 折叠光标处插入文本：直接改块模型，按源偏移恢复光标。返回 false 表示未处理
  function insertTextAtCaret(data) {
    if (!data) return false;
    var sel = window.getSelection();
    var blockEl = caretBlockEl();
    if (!blockEl || !sel.rangeCount) return false;
    var b = blockByEl(blockEl);
    if (!b) return false;
    var bt = blockEl.dataset.type;
    if (bt === "hr") return false;
    var local;
    if (bt === "table") {
      var info = cellInfo(sel.anchorNode);
      if (!info) return false;
      // 表格 src 先归一化（序列化会 trim 单元格），偏移计算才与 DOM 一致
      b.src = window.axMd.serializeTableCols(window.axMd.parseTableCols(b.src));
      local = window.axMd.tableSrcOffset(b.src, info.r, info.c,
        window.axMd.srcOffsetIn(info.td, sel.anchorNode, sel.anchorOffset));
      pushHistory();
      b.src = b.src.slice(0, local) + data + b.src.slice(local);
      rerenderBlock(b);
      window.axMd.setBlockSrcOffset(b, local + data.length);
      afterChange();
      return true;
    }
    if (bt === "ul" || bt === "ol" || bt === "task") {
      // 列表：按条目行内文本插入，再用 listSrc 重组（保证标记符不丢）
      var items = window.axMd.parseList(b.src);
      var pos = window.axMd.listPosFromSrc(b.src, window.axMd.blockSrcOffsetOf(b, sel.anchorNode, sel.anchorOffset));
      if (!items.length) {
        // 刚转换出的空列表：补一个空条目，让符号立即可见
        items = [{ indent: 0, type: bt === "ol" ? "ol" : (bt === "task" ? "task" : "ul"), num: 1, checked: false, inline: "" }];
        pos = { liIndex: 0, itemLocal: 0 };
      }
      if (pos.liIndex >= items.length) pos.liIndex = items.length - 1;
      if (pos.liIndex < 0) pos.liIndex = 0;
      var it = items[pos.liIndex];
      // 条目行首的空格会被标记符正则吞掉，直接忽略，避免光标跳位
      if (data === " " && pos.itemLocal === 0) { afterChange(); return true; }
      it.inline = it.inline.slice(0, pos.itemLocal) + data + it.inline.slice(pos.itemLocal);
      pushHistory();
      b.src = window.axMd.listSrc(items);
      rerenderBlock(b);
      var lineStart = 0;
      for (var q = 0; q < pos.liIndex; q++) {
        lineStart += items[q].indent + window.axMd.listMarker(items[q]).length + items[q].inline.length + 1;
      }
      window.axMd.setBlockSrcOffset(b, lineStart + it.indent + window.axMd.listMarker(it).length + pos.itemLocal + data.length);
      afterChange();
      return true;
    }
    local = window.axMd.blockSrcOffsetOf(b, sel.anchorNode, sel.anchorOffset);
    pushHistory();
    b.src = b.src.slice(0, local) + data + b.src.slice(local);
    rerenderBlock(b);
    window.axMd.setBlockSrcOffset(b, local + data.length);
    afterChange();
    return true;
  }

  function onEditorInput() {
    if (state.composing) return;
    if (state.compositionTimer) {
      clearTimeout(state.compositionTimer);
      state.compositionTimer = 0;
    }
    syncCaretBlock();
    afterChange();
  }

  function onCompositionEnd() {
    state.composing = false;
    // 浏览器通常紧接 compositionend 派发最终 input。让该事件先同步；
    // 定时器只作为未派发最终 input 的浏览器兼容兜底。
    if (state.compositionTimer) clearTimeout(state.compositionTimer);
    state.compositionTimer = setTimeout(function () {
      state.compositionTimer = 0;
      syncCaretBlock();
      afterChange();
    }, 80);
  }

  /* ================= beforeinput：输入规则与结构性输入 ================= */

  function onBeforeInput(e) {
    if (state.composing) return;
    var type = e.inputType;
    if (type === "historyUndo") { e.preventDefault(); undo(); return; }
    if (type === "historyRedo") { e.preventDefault(); redo(); return; }
    if (type === "insertFromPaste" || type === "insertFromDrop" || type === "insertReplacementText") {
      e.preventDefault();
      return;
    }
    var sel = window.getSelection();
    var blockEl = caretBlockEl();
    if (!blockEl) return;
    var b = blockByEl(blockEl);
    if (!b) return;
    var btype = blockEl.dataset.type;

    // 行首输入规则（输入空格触发；仅段落/标题——列表内空格就是普通空格）
    if (type === "insertText" && e.data === " " && sel.isCollapsed &&
        btype !== "code" && btype !== "table" && btype !== "math" && btype !== "chart" &&
        btype !== "frontmatter" && btype !== "footnotes" &&
        btype !== "ul" && btype !== "ol" && btype !== "task") {
      var off = window.axMd.srcOffsetIn(blockEl, sel.anchorNode, sel.anchorOffset);
      var before = b.src.slice(0, off);
      var m;
      if ((m = /^(#{1,6})$/.exec(before))) {
        e.preventDefault(); pushHistory();
        convertBlock(b, "h" + m[1].length, ""); caretAtBlockStart(b._el);
        afterChange(); return;
      } else if (/^([-*+])$/.test(before)) {
        e.preventDefault(); pushHistory();
        convertBlock(b, "ul", "- "); caretAtBlockStart(b._el);
        afterChange(); return;
      } else if ((m = /^(\d+)[.)]$/.exec(before))) {
        e.preventDefault(); pushHistory();
        convertBlock(b, "ol", "1. "); caretAtBlockStart(b._el);
        afterChange(); return;
      } else if (/^>$/.test(before)) {
        e.preventDefault(); pushHistory();
        convertBlock(b, "quote", ""); caretAtBlockStart(b._el);
        afterChange(); return;
      } else if (/^\[[ xX]\]$/.test(before)) {
        e.preventDefault(); pushHistory();
        convertBlock(b, "task", "- [ ] "); caretAtBlockStart(b._el);
        afterChange(); return;
      } else if ((m = /^(`{3,}|~{3,})([A-Za-z0-9_+-]*)$/.exec(before))) {
        e.preventDefault(); pushHistory();
        // mermaid 围栏归为图表块（与 parse 的行为一致）
        convertBlock(b, /^mermaid$/i.test(m[2]) ? "chart" : "code", "", m[2]);
        if (b.type === "code") focusCodeStart(b._el);
        afterChange(); return;
      }
      // 未命中规则：落入下面的通用插入逻辑
    }

    // 折叠光标插入文本：完全模型驱动。
    // 不依赖浏览器插入——浏览器在空块/刚替换过的块里会把字符插到编辑器根节点，
    // 且标记符折叠后"纯文本偏移"与"源偏移"不再一致，光标会逃逸。
    if (type === "insertText" && sel.isCollapsed) {
      if (insertTextAtCaret(e.data)) { e.preventDefault(); return; }
    }

    // 有选区的文本替换 / 删除：走全局源操作
    if (type === "insertText" && !sel.isCollapsed) {
      e.preventDefault();
      insertSource(e.data);
      return;
    }
    if ((type === "deleteContentBackward" || type === "deleteContentForward") && !sel.isCollapsed) {
      e.preventDefault();
      deleteSelection();
      return;
    }
    if (type === "insertParagraph" || type === "insertLineBreak") {
      // keydown 已拦截；双保险
      e.preventDefault();
      pushHistory();
      if (type === "insertLineBreak") softBreak();
      else onEnterKey();
      afterChange();
      return;
    }
  }

  /* ================= keydown ================= */

  function onEditorKeyDown(e) {
    if (state.composing) return;
    var mod = e.ctrlKey || e.metaKey;
    var key = e.key;

    if (mod && !e.shiftKey && (key === "b" || key === "B")) { e.preventDefault(); wrapSelection("**"); return; }
    if (mod && !e.shiftKey && (key === "i" || key === "I")) { e.preventDefault(); wrapSelection("*"); return; }
    if (mod && !e.shiftKey && (key === "u" || key === "U")) { e.preventDefault(); cmdUnderline(); return; }
    if (mod && e.shiftKey && (key === "x" || key === "X")) { e.preventDefault(); wrapSelection("~~"); return; }
    if (mod && e.shiftKey && (key === "h" || key === "H")) { e.preventDefault(); cmdHighlight(); return; }
    if (mod && e.shiftKey && (key === "i" || key === "I")) { e.preventDefault(); cmdImage(); return; }
    if (mod && key === "\\") { e.preventDefault(); cmdClearFormat(); return; }
    if (!mod && e.altKey && e.shiftKey && key === "5") { e.preventDefault(); wrapSelection("~~"); return; }
    if (mod && key === "`") { e.preventDefault(); wrapSelection("`"); return; }
    if (mod && e.shiftKey && (key === "k" || key === "K")) { e.preventDefault(); cmdCodeBlock(); return; }
    if (mod && e.shiftKey && (key === "t" || key === "T")) { e.preventDefault(); cmdTable(); return; }
    if (mod && e.shiftKey && (key === "m" || key === "M")) { e.preventDefault(); cmdMath(); return; }
    if (mod && e.shiftKey && (key === "q" || key === "Q")) { e.preventDefault(); cmdQuote(); return; }
    if (mod && e.shiftKey && key === "[") { e.preventDefault(); cmdList("ol"); return; }
    if (mod && e.shiftKey && key === "]") { e.preventDefault(); cmdList("ul"); return; }
    if (mod && !e.shiftKey && (key === "=" || key === "+")) { e.preventDefault(); shiftHeading(1); return; }
    if (mod && !e.shiftKey && (key === "-" || key === "_")) { e.preventDefault(); shiftHeading(-1); return; }
    if (mod && (key === "k" || key === "K")) { e.preventDefault(); cmdLink(); return; }
    if (mod && !e.shiftKey && /^Digit[1-6]$/.test(e.code)) { e.preventDefault(); cmdHeading(+e.code.slice(5)); return; }
    if (mod && !e.shiftKey && e.code === "Digit0") { e.preventDefault(); cmdHeading(0); return; }
    if (mod && e.shiftKey && e.code === "Digit8") { e.preventDefault(); cmdList("ul"); return; }
    if (mod && e.shiftKey && e.code === "Digit7") { e.preventDefault(); cmdList("ol"); return; }
    if (mod && e.shiftKey && e.code === "Digit9") { e.preventDefault(); cmdList("task"); return; }
    if (mod && key === "/") { e.preventDefault(); toggleSourceMode(); return; }
    if (mod && !e.shiftKey && (key === "z" || key === "Z")) { e.preventDefault(); undo(); return; }
    if ((mod && (key === "y" || key === "Y")) || (mod && e.shiftKey && (key === "z" || key === "Z"))) {
      e.preventDefault(); redo(); return;
    }

    if (key === "Enter") {
      // Ctrl+Enter 在下方插入段落；Ctrl+Shift+Enter 在上方插入
      if (mod && !e.shiftKey) { e.preventDefault(); insertParagraph("below"); return; }
      if (mod && e.shiftKey) { e.preventDefault(); insertParagraph("above"); return; }
      if (!mod) {
        e.preventDefault();
        pushHistory();
        if (e.shiftKey) softBreak();
        else onEnterKey();
        afterChange();
        return;
      }
      return;
    }
    if (key === "Tab") {
      e.preventDefault();
      pushHistory();
      onTab(e.shiftKey);
      afterChange();
      return;
    }
    if (key === "Backspace" && atBlockStart()) {
      e.preventDefault();
      pushHistory();
      onBackspaceStart();
      afterChange();
      return;
    }
    if (key === "Delete" && atBlockEnd()) {
      e.preventDefault();
      pushHistory();
      onDeleteEnd();
      afterChange();
      return;
    }
  }

  function convertBlock(b, type, src, lang) {
    b.type = type;
    b.src = src;
    if (lang !== undefined) b.lang = lang;
    rerenderBlock(b);
  }

  function focusCodeStart(blockEl) {
    var code = blockEl.querySelector("code");
    if (!code) return;
    var r = document.createRange();
    r.selectNodeContents(code);
    r.collapse(true);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  function atBlockStart() {
    var sel = window.getSelection();
    if (!sel.isCollapsed || !sel.rangeCount) return false;
    var blockEl = caretBlockEl();
    if (!blockEl) return false;
    var btype = blockEl.dataset.type;
    if (btype === "table" || btype === "hr" || btype === "math" || btype === "chart" || btype === "frontmatter") return false;
    return window.axMd.srcOffsetIn(blockEl, sel.anchorNode, sel.anchorOffset) === 0;
  }

  function atBlockEnd() {
    var sel = window.getSelection();
    if (!sel.isCollapsed || !sel.rangeCount) return false;
    var blockEl = caretBlockEl();
    if (!blockEl) return false;
    var btype = blockEl.dataset.type;
    if (btype === "table" || btype === "hr" || btype === "math" || btype === "chart" || btype === "frontmatter") return false;
    var b = blockByEl(blockEl);
    if (!b) return false;
    return window.axMd.srcOffsetIn(blockEl, sel.anchorNode, sel.anchorOffset) >= b.src.length;
  }

  /* ================= Enter / Tab / 退格 / 删除 ================= */

  function onEnterKey() {
    var sel = window.getSelection();
    var blockEl = caretBlockEl();
    if (!blockEl || !sel.rangeCount) return;
    var b = blockByEl(blockEl);
    if (!b) return;
    var idx = state.blocks.indexOf(b);
    var type = blockEl.dataset.type;
    // 列表的 srcOffsetIn 是条目相对的，这里统一换算成块 src 偏移
    var off = (type === "ul" || type === "ol" || type === "task")
      ? window.axMd.blockSrcOffsetOf(b, sel.anchorNode, sel.anchorOffset)
      : window.axMd.srcOffsetIn(blockEl, sel.anchorNode, sel.anchorOffset);

    if (type === "table") { tableEnter(); return; }
    if (type === "hr") return;

    if (type === "code" || type === "frontmatter") {
      // 代码块 / Front Matter：回车插入换行（YAML 与代码同样按源码编辑）
      b.src = b.src.slice(0, off) + "\n" + b.src.slice(off);
      rerenderBlock(b, window.axMd.plainOffsetIn(blockEl) + 1);
      return;
    }

    if (type === "math" || type === "chart") {
      // 公式 / 图表块不可编辑：在其后插入新段落并聚焦
      var nbMath = { type: "p", src: "" };
      insertBlockAfter(idx, nbMath);
      caretAtBlockStart(nbMath._el);
      return;
    }

    if (type === "footnotes") {
      // 脚注区：跳到下一条定义；已是最后一条则在块后插入新段落
      var selFn = window.getSelection();
      var nodeFn = selFn.anchorNode;
      var curLi = nodeFn && (nodeFn.nodeType === 3 ? nodeFn.parentNode : nodeFn);
      curLi = curLi && curLi.closest ? curLi.closest(".fn-item") : null;
      var lisFn = window.axMd.fnLiEls(blockEl);
      var liIdxFn = Array.prototype.indexOf.call(lisFn, curLi);
      if (liIdxFn >= 0 && liIdxFn < lisFn.length - 1) {
        window.axMd.setPlainOffset(lisFn[liIdxFn + 1], 0);
      } else {
        var nbFn = { type: "p", src: "" };
        insertBlockAfter(idx, nbFn);
        caretAtBlockStart(nbFn._el);
      }
      return;
    }

    if (type === "quote") {
      if (b.src === "") { convertBlock(b, "p", ""); caretAtBlockStart(b._el); return; }
      var lines = b.src.split("\n");
      var lineIdx = 0, acc = 0;
      for (var i = 0; i < lines.length; i++) {
        if (acc + lines[i].length >= off) { lineIdx = i; break; }
        acc += lines[i].length + 1;
      }
      var col = off - (lineIdx === 0 ? 0 : lineStart(lines, lineIdx));
      var before = lines.slice(0, lineIdx).concat([lines[lineIdx].slice(0, col)]);
      var after = lines.slice(lineIdx).map(function (l, k) { return k === 0 ? l.slice(col) : l; });
      b.src = before.join("\n");
      var nb = { type: "quote", src: after.join("\n") };
      insertBlockAfter(idx, nb);
      caretAtBlockStart(nb._el);
      return;
    }

    if (isList(type)) { listEnter(blockEl, b, off); return; }

    // p / h：输入规则
    if (type === "p") {
      var m = /^(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)$/.exec(b.src.trim());
      if (m && off >= b.src.length) {
        convertBlock(b, /^mermaid$/i.test(m[2]) ? "chart" : "code", "", m[2]);
        if (b.type === "code") focusCodeStart(b._el);
        return;
      }
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(b.src) && off >= b.src.length) {
        convertBlock(b, "hr", "");
        var p2 = { type: "p", src: "" };
        insertBlockAfter(idx, p2);
        caretAtBlockStart(p2._el);
        return;
      }
    }
    var before = b.src.slice(0, off), after = b.src.slice(off);
    b.src = before;
    var nb2 = { type: "p", src: after };
    insertBlockAfter(idx, nb2);
    caretAtBlockStart(nb2._el);
  }

  function lineStart(lines, idx) {
    var s = 0;
    for (var i = 0; i < idx; i++) s += lines[i].length + 1;
    return s;
  }

  function markerLenOf(line) {
    var m = /^(\s*)(?:([-*+])|(\d+)[.)])(\s+)(\[[ xX]\]\s+)?/.exec(line);
    return m ? m[0].length : 0;
  }

  function listEnter(blockEl, b, off) {
    var sel = window.getSelection();
    var node = sel.anchorNode;
    var li = node && node.nodeType === 3 ? node.parentNode : node;
    li = li && li.closest ? li.closest("li") : null;
    if (!li || !blockEl.contains(li)) return;
    var liIdx = liIndexOf(blockEl, li);
    var items = window.axMd.parseList(b.src);
    if (liIdx < 0 || liIdx >= items.length) return;
    var it = items[liIdx];
    // off 为块 src 偏移：换算成该条目行内文本的列位置
    var lineStart = 0;
    for (var q = 0; q < liIdx; q++) {
      lineStart += items[q].indent + window.axMd.listMarker(items[q]).length + items[q].inline.length + 1;
    }
    var col = Math.max(0, Math.min(off - lineStart - it.indent - window.axMd.listMarker(it).length, it.inline.length));
    var before = it.inline.slice(0, col), after = it.inline.slice(col);

    if (before.trim() === "" && after.trim() === "") {
      // 空项回车：减缩进；已在顶层则结束列表
      if (it.indent > 0) {
        it.indent = Math.max(0, it.indent - 2);
        b.src = window.axMd.listSrc(items);
        rerenderBlock(b);
        window.axMd.setBlockSrcOffset(b, lineStart + it.indent + window.axMd.listMarker(it).length);
      } else {
        items.splice(liIdx, 1);
        if (items.length === 0) {
          var idx0 = state.blocks.indexOf(b);
          convertBlock(b, "p", "");
          caretAtBlockStart(b._el);
        } else {
          b.src = window.axMd.listSrc(items);
          rerenderBlock(b);
          var target = Math.min(liIdx, items.length - 1);
          var ls = 0;
          for (var k = 0; k < target; k++) {
            ls += items[k].indent + window.axMd.listMarker(items[k]).length + items[k].inline.length + 1;
          }
          window.axMd.setBlockSrcOffset(b, ls + items[target].indent + window.axMd.listMarker(items[target]).length);
        }
      }
      return;
    }
    it.inline = before;
    var ni = {
      indent: it.indent,
      type: it.type,
      num: it.type === "ol" ? it.num + 1 : 0,
      checked: false,
      inline: after,
    };
    items.splice(liIdx + 1, 0, ni);
    b.src = window.axMd.listSrc(items);
    rerenderBlock(b);
    // 光标放到新项开头（按 src 偏移定位，空条目也不会错位）
    var newLineStart = lineStart + it.indent + window.axMd.listMarker(it).length + before.length + 1;
    window.axMd.setBlockSrcOffset(b, newLineStart + ni.indent + window.axMd.listMarker(ni).length);
  }

  function lineStarts(src) {
    var starts = [0];
    for (var i = 0; i < src.length; i++) {
      if (src[i] === "\n") starts.push(i + 1);
    }
    return starts;
  }

  function liIndexOf(blockEl, li) {
    var lis = blockEl.querySelectorAll("li");
    return Array.prototype.indexOf.call(lis, li);
  }

  function onTab(shift) {
    var sel = window.getSelection();
    var blockEl = caretBlockEl();
    if (!blockEl || !sel.rangeCount) return;
    var b = blockByEl(blockEl);
    if (!b) return;
    var type = blockEl.dataset.type;

    if (type === "table") {
      var info = cellInfo(sel.anchorNode);
      if (!info) return;
      var cols = blockEl.querySelectorAll("thead th").length || 1;
      var i2 = info.r * cols + info.c + (shift ? -1 : 1);
      if (i2 < 0) return;
      focusCell(blockEl, Math.floor(i2 / cols), i2 % cols, 0);
      return;
    }
    if (isList(type)) {
      var node = sel.anchorNode;
      var li = node && node.nodeType === 3 ? node.parentNode : node;
      li = li && li.closest ? li.closest("li") : null;
      if (!li) return;
      var liIdx = liIndexOf(blockEl, li);
      var items = window.axMd.parseList(b.src);
      if (liIdx < 0 || liIdx >= items.length) return;
      pushHistory();
      var pt = window.axMd.plainOffsetIn(blockEl);
      items[liIdx].indent = Math.max(0, Math.min(6, items[liIdx].indent + (shift ? -2 : 2)));
      b.src = window.axMd.listSrc(items);
      rerenderBlock(b, pt);
      afterChange();
      return;
    }
    if (type === "code") {
      var off = window.axMd.srcOffsetIn(blockEl, sel.anchorNode, sel.anchorOffset);
      pushHistory();
      b.src = b.src.slice(0, off) + "  " + b.src.slice(off);
      rerenderBlock(b, window.axMd.plainOffsetIn(blockEl) + 2);
      afterChange();
      return;
    }
    // 其他块：吞掉 Tab，避免焦点跳转
  }

  function softBreak() {
    var sel = window.getSelection();
    var blockEl = caretBlockEl();
    if (!blockEl || !sel.rangeCount) return;
    var b = blockByEl(blockEl);
    if (!b || blockEl.dataset.type === "table") return;
    var type = blockEl.dataset.type;
    if (isList(type)) {
      // 列表条目内软换行：\n 进条目行内文本（续行），不能按块 src 偏移 splice
      var node = sel.anchorNode;
      var li0 = node && node.nodeType === 3 ? node.parentNode : node;
      li0 = li0 && li0.closest ? li0.closest("li") : null;
      if (!li0 || !blockEl.contains(li0)) return;
      var items0 = window.axMd.parseList(b.src);
      var liIdx0 = liIndexOf(blockEl, li0);
      if (liIdx0 < 0 || liIdx0 >= items0.length) return;
      var it0 = items0[liIdx0];
      var lineStart0 = 0;
      for (var q0 = 0; q0 < liIdx0; q0++) {
        lineStart0 += items0[q0].indent + window.axMd.listMarker(items0[q0]).length + items0[q0].inline.length + 1;
      }
      var off0 = window.axMd.blockSrcOffsetOf(b, sel.anchorNode, sel.anchorOffset);
      var col0 = Math.max(0, Math.min(off0 - lineStart0 - it0.indent - window.axMd.listMarker(it0).length, it0.inline.length));
      it0.inline = it0.inline.slice(0, col0) + "\n" + it0.inline.slice(col0);
      pushHistory();
      b.src = window.axMd.listSrc(items0);
      rerenderBlock(b);
      window.axMd.setBlockSrcOffset(b, lineStart0 + it0.indent + window.axMd.listMarker(it0).length + col0 + 1);
      afterChange();
      return;
    }
    var off = window.axMd.srcOffsetIn(blockEl, sel.anchorNode, sel.anchorOffset);
    var pt = window.axMd.plainOffsetIn(blockEl);
    pushHistory();
    b.src = b.src.slice(0, off) + "\n" + b.src.slice(off);
    rerenderBlock(b, pt + 1);
    afterChange();
  }

  function onBackspaceStart() {
    var sel = window.getSelection();
    var blockEl = caretBlockEl();
    if (!blockEl || !sel.isCollapsed) return;
    var b = blockByEl(blockEl);
    if (!b) return;
    var idx = state.blocks.indexOf(b);
    if (idx <= 0) return;
    var off = window.axMd.srcOffsetIn(blockEl, sel.anchorNode, sel.anchorOffset);
    if (off !== 0) return;
    var type = blockEl.dataset.type;
    if (type === "table") return;
    var prev = state.blocks[idx - 1];

    if (isEmptySrc(b)) {
      removeBlockAt(idx);
      caretAtBlockEnd(prev._el);
      return;
    }
    if (prev.type === "hr") {
      removeBlockAt(idx - 1);
      caretAtBlockStart(b._el);
      return;
    }
    if ((prev.type === "p" || prev.type === "quote") && (type === "p" || type === "quote")) {
      var junction = window.axMd.plainLenOf(prev._el);
      prev.src = prev.src + "\n" + b.src;
      removeBlockAt(idx);
      rerenderBlock(prev);
      window.axMd.setPlainOffset(prev._el, junction + 1);
      return;
    }
    if (prev.type === "code") {
      var j2 = window.axMd.plainLenOf(prev._el);
      prev.src = prev.src ? prev.src + "\n" + b.src : b.src;
      removeBlockAt(idx);
      rerenderBlock(prev);
      window.axMd.setPlainOffset(prev._el, j2);
      return;
    }
    if (isList(prev.type) && (type === "p" || isList(type))) {
      var items = window.axMd.parseList(prev.src);
      if (type === "p") {
        items.push({ indent: 0, type: prev.type === "ol" ? "ol" : "ul", num: items.length + 1, checked: false, inline: b.src });
      } else {
        window.axMd.parseList(b.src).forEach(function (it) { items.push(it); });
      }
      prev.src = window.axMd.listSrc(items);
      removeBlockAt(idx);
      rerenderBlock(prev);
      // 光标放到最后一个条目开头（按 src 偏移，空条目也不会错位）
      var items3 = window.axMd.parseList(prev.src);
      if (items3.length) {
        var last3 = items3[items3.length - 1];
        var ls3 = 0;
        for (var k3 = 0; k3 < items3.length - 1; k3++) {
          ls3 += items3[k3].indent + window.axMd.listMarker(items3[k3]).length + items3[k3].inline.length + 1;
        }
        window.axMd.setBlockSrcOffset(prev, ls3 + last3.indent + window.axMd.listMarker(last3).length);
      }
      return;
    }
    // 其他组合：不处理
  }

  function onDeleteEnd() {
    var sel = window.getSelection();
    var blockEl = caretBlockEl();
    if (!blockEl || !sel.isCollapsed) return;
    var b = blockByEl(blockEl);
    if (!b) return;
    var idx = state.blocks.indexOf(b);
    if (idx >= state.blocks.length - 1) return;
    var off = window.axMd.srcOffsetIn(blockEl, sel.anchorNode, sel.anchorOffset);
    if (off < b.src.length) return;
    var type = blockEl.dataset.type;
    if (type === "table") return;
    var next = state.blocks[idx + 1];

    if (isEmptySrc(next)) { removeBlockAt(idx + 1); return; }
    if (next.type === "hr") { removeBlockAt(idx + 1); return; }
    if (b.type === "p" && next.type === "p") {
      var junction = window.axMd.plainLenOf(b._el);
      b.src = b.src + "\n" + next.src;
      removeBlockAt(idx + 1);
      rerenderBlock(b);
      window.axMd.setPlainOffset(b._el, junction + 1);
      return;
    }
    if (b.type === "quote" && next.type === "quote") {
      var j3 = window.axMd.plainLenOf(b._el);
      b.src = b.src + "\n" + next.src;
      removeBlockAt(idx + 1);
      rerenderBlock(b);
      window.axMd.setPlainOffset(b._el, j3 + 1);
      return;
    }
    if (isList(b.type) && next.type === "p") {
      var items2 = window.axMd.parseList(b.src);
      items2.push({ indent: 0, type: b.type === "ol" ? "ol" : "ul", num: items2.length + 1, checked: false, inline: next.src });
      b.src = window.axMd.listSrc(items2);
      removeBlockAt(idx + 1);
      rerenderBlock(b);
      // 光标放到新条目开头
      var last2 = items2[items2.length - 1];
      var ls2 = 0;
      for (var k4 = 0; k4 < items2.length - 1; k4++) {
        ls2 += items2[k4].indent + window.axMd.listMarker(items2[k4]).length + items2[k4].inline.length + 1;
      }
      window.axMd.setBlockSrcOffset(b, ls2 + last2.indent + window.axMd.listMarker(last2).length);
      return;
    }
    // 其他组合：不处理
  }

  /* ================= 表格操作 ================= */

  function cellInfo(node) {
    var n = node && (node.nodeType === 3 ? node.parentNode : node);
    if (!n || !n.closest) return null;
    var td = n.closest("th,td");
    if (!td) return null;
    var tr = td.parentNode;
    if (!tr) return null;
    var table = tr.closest("table");
    if (!table) return null;
    var trs = table.querySelectorAll("tr");
    var r = Array.prototype.indexOf.call(trs, tr);
    var c = Array.prototype.indexOf.call(tr.children, td);
    return { td: td, r: r, c: c, blockEl: td.closest("[data-type]") };
  }

  function tableCellRange(b, r, c) {
    var lines = b.src.split("\n");
    var lineIdx = r === 0 ? 0 : r + 1; // 0=表头, 1=分隔行, 2..=数据行
    if (lineIdx >= lines.length) return { start: 0, end: 0 };
    var line = lines[lineIdx];
    var cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map(function (s) { return s.trim(); });
    var start = 2;
    for (var j = 0; j < c && j < cells.length; j++) start += cells[j].length + 3;
    var base = lineStart(lines, lineIdx);
    return { start: base + start, end: base + start + (cells[c] || "").length };
  }

  function focusCell(blockEl, r, c, pt) {
    var trs = blockEl.querySelectorAll("tr");
    if (r < 0 || r >= trs.length) return;
    var tds = trs[r].children;
    if (c < 0 || c >= tds.length) return;
    if (pt != null) window.axMd.setPlainOffset(tds[c], pt);
    else window.axMd.setPlainOffset(tds[c], 0);
  }

  function tableEnter() {
    var sel = window.getSelection();
    var info = cellInfo(sel.anchorNode);
    if (!info) return;
    var b = blockByEl(info.blockEl);
    if (!b) return;
    var tb = window.axMd.parseTableCols(b.src);
    if (info.r >= tb.rows.length - 1) {
      tb.rows.push(new Array(tb.cols).fill(""));
      b.src = window.axMd.serializeTableCols(tb);
      rerenderBlock(b);
      focusCell(b._el, tb.rows.length - 1, info.c, 0);
    } else {
      focusCell(info.blockEl, info.r + 1, info.c, 0);
    }
  }

  function tableOp(btn) {
    var op = btn.dataset.op;
    var blockEl = btn.closest("[data-type]");
    var b = blockByEl(blockEl);
    if (!b) return;
    if (op === "deleteTable") {
      var idx = state.blocks.indexOf(b);
      pushHistory();
      removeBlockAt(idx);
      var focusBlock;
      if (!state.blocks.length) {
        focusBlock = { type: "p", src: "" };
        state.blocks.push(focusBlock);
        renderAll();
      } else {
        var focusIdx = Math.min(idx, state.blocks.length - 1);
        focusBlock = state.blocks[focusIdx];
        if (["hr", "math", "chart", "frontmatter"].indexOf(focusBlock.type) >= 0) {
          focusBlock = { type: "p", src: "" };
          state.blocks.splice(focusIdx, 0, focusBlock);
          renderAll();
        }
      }
      if (focusBlock.type === "table") focusCell(focusBlock._el, 0, 0, 0);
      else caretAtBlockStart(focusBlock._el);
      afterChange();
      return;
    }
    var tb = window.axMd.parseTableCols(b.src);
    pushHistory();
    if (op === "addRow") {
      tb.rows.push(new Array(tb.cols).fill(""));
    } else if (op === "delRow") {
      if (tb.rows.length > 2) tb.rows.splice(tb.rows.length - 1, 1);
    } else if (op === "addCol") {
      tb.cols++;
      tb.rows.forEach(function (r) { r.push(""); });
    } else if (op === "delCol") {
      if (tb.cols > 1) {
        tb.cols--;
        tb.rows.forEach(function (r) { r.pop(); });
      }
    }
    b.src = window.axMd.serializeTableCols(tb);
    rerenderBlock(b);
    afterChange();
  }

  /* ================= 格式命令 ================= */

  // 标记 -> 行内格式元素标签（折叠光标切换移除用）
  function formatTagsForMarker(marker) {
    if (marker === "**") return ["STRONG", "B"];
    if (marker === "*") return ["EM", "I"];
    if (marker === "~~") return ["S", "STRIKE", "DEL"];
    if (marker === "==") return ["MARK"];
    if (marker === "<u>") return ["U"];
    if (marker === "`") return ["CODE"];
    return null;
  }

  // 行内格式元素的闭标记长度（与 md.js inlineOpenLen 对应）。
  // A 的闭标记含 URL 变长，返回 0 即不参与光标切换
  function inlineCloseLen(el) {
    var tag = el.tagName;
    if (tag === "STRONG" || tag === "B") return 2; // **
    if (tag === "EM" || tag === "I") return 1;     // *
    if (tag === "S" || tag === "STRIKE" || tag === "DEL" || tag === "MARK") return 2; // ~~ / ==
    if (tag === "U") return 4;                     // </u>
    if (tag === "CODE") return 1;                  // `
    return 0;
  }

  // 折叠光标处最内层的同类行内格式 token（内容区内）；无则 null
  function innermostFormatAt(blockEl, local, marker) {
    var tags = formatTagsForMarker(marker);
    if (!tags) return null;
    var spans = window.axMd.ownSpans(blockEl);
    for (var i = spans.length - 1; i >= 0; i--) {
      var el = spans[i];
      if (tags.indexOf(el.tagName) < 0) continue;
      var a = +el.getAttribute("data-a"), bb = +el.getAttribute("data-b");
      if (a < local && local < bb) return { el: el, a: a, b: bb };
    }
    return null;
  }

  function wrapSelection(marker, closeMarker) {
    var close = closeMarker || marker;
    var sel = window.getSelection();
    var blockEl = caretBlockEl();
    if (!blockEl || !sel.rangeCount) return;
    var b = blockByEl(blockEl);
    if (!b) return;
    if (blockEl.dataset.type === "code") { insertSource(marker + close); return; }
    if (blockEl.dataset.type === "table" && sel.isCollapsed) { insertSource(marker + close); return; }
    if (blockEl.dataset.type === "hr") return;

    // 折叠光标位于同类行内格式的内容区内：切换移除该层格式（Typora 语义）。
    // 否则在 **粗体** 末尾再按 Ctrl+B 会插入多余的 **** 字面文本
    var bt0 = blockEl.dataset.type;
    if (sel.isCollapsed && (bt0 === "p" || bt0 === "quote" || /^h[1-6]$/.test(bt0))) {
      var g0 = selectionGlobalRange();
      var pos0 = globalToBlockLocal(g0.start);
      if (pos0 && pos0.b === b) {
        var tok = innermostFormatAt(blockEl, pos0.local, marker);
        if (tok) {
          var oL = window.axMd.inlineOpenLen(tok.el), cL = inlineCloseLen(tok.el);
          pushHistory();
          b.src = b.src.slice(0, tok.a) + b.src.slice(tok.a + oL, tok.b - cL) + b.src.slice(tok.b);
          rerenderBlock(b);
          setCaretGlobalSrc(g0.start - oL); // 开标记在光标前，移除后光标前移 oL
          afterChange();
          return;
        }
      }
    }

    var g = selectionGlobalRange();
    var src = currentSrc();
    var before = src.slice(0, g.start), mid = src.slice(g.start, g.end), after = src.slice(g.end);
    var next, selStart, selEnd;
    if (!sel.isCollapsed && before.endsWith(marker) && after.startsWith(close)) {
      next = before.slice(0, -marker.length) + mid + after.slice(close.length);
      selStart = g.start - marker.length;
    } else {
      next = before + marker + mid + close + after;
      selStart = g.start + marker.length;
    }
    selEnd = selStart + mid.length;
    pushHistory();
    state.blocks = window.axMd.parse(next);
    renderAll();
    if (sel.isCollapsed) setCaretGlobalSrc(selStart);
    else setSelectionGlobalSrc(selStart, selEnd);
    afterChange();
  }

  function insertSource(text) {
    if (!text) return;
    var g = selectionGlobalRange();
    var src = currentSrc();
    pushHistory();
    state.blocks = window.axMd.parse(src.slice(0, g.start) + text + src.slice(g.end));
    renderAll();
    setCaretGlobalSrc(g.start + text.length);
    afterChange();
  }

  function deleteSelection() {
    var g = selectionGlobalRange();
    var src = currentSrc();
    pushHistory();
    state.blocks = window.axMd.parse(src.slice(0, g.start) + src.slice(g.end));
    renderAll();
    setCaretGlobalSrc(g.start);
    afterChange();
  }

  function cmdHeading(level) {
    var blockEl = caretBlockEl();
    if (!blockEl) return;
    var b = blockByEl(blockEl);
    if (!b) return;
    var type = blockEl.dataset.type;
    if (type === "table" || type === "hr" || type === "code" || type === "math" ||
        type === "chart" || type === "frontmatter" || type === "footnotes") {
      toast(t("toast.unsupportedSelection"));
      return;
    }
    var g = globalSrcOffsetOf(window.getSelection().anchorNode, window.getSelection().anchorOffset);
    pushHistory();
    if (isList(type)) {
      var items = window.axMd.parseList(b.src);
      b.src = items.map(function (it) { return it.inline; }).join("\n");
    }
    b.type = level ? "h" + level : "p";
    rerenderBlock(b);
    setCaretGlobalSrc(g); // 标题级别不改变块内 src，按原光标位置恢复
    afterChange();
  }

  function cmdList(type) {
    var blockEl = caretBlockEl();
    if (!blockEl) return;
    var b = blockByEl(blockEl);
    if (!b) return;
    var cur = blockEl.dataset.type;
    if (cur === "table" || cur === "hr" || cur === "code") {
      toast(t("toast.unsupportedSelection"));
      return;
    }
    pushHistory();
    if (cur === type) {
      var items0 = window.axMd.parseList(b.src);
      b.type = "p";
      b.src = items0.map(function (it) { return it.inline; }).join("\n");
    } else if (isList(cur)) {
      var its = window.axMd.parseList(b.src);
      its.forEach(function (it) {
        it.type = type === "task" ? "task" : type;
        if (type === "task") it.checked = false;
        if (type === "ol") it.num = 1;
        if (type === "ul") it.num = 0;
      });
      b.type = type;
      b.src = window.axMd.listSrc(its);
    } else {
      var lines = b.src.split("\n");
      b.type = type;
      b.src = lines.map(function (l) {
        if (type === "task") return "- [ ] " + l;
        if (type === "ol") return "1. " + l;
        return "- " + l;
      }).join("\n");
    }
    rerenderBlock(b);
    afterChange();
  }

  function cmdQuote() {
    var blockEl = caretBlockEl();
    if (!blockEl) return;
    var b = blockByEl(blockEl);
    if (!b) return;
    var cur = blockEl.dataset.type;
    if (cur !== "quote" && cur !== "p" && !/^h[1-6]$/.test(cur)) {
      toast(t("toast.unsupportedSelection"));
      return;
    }
    pushHistory();
    b.type = cur === "quote" ? "p" : "quote";
    rerenderBlock(b);
    afterChange();
  }

  function cmdCodeBlock() {
    var blockEl = caretBlockEl();
    if (!blockEl) return;
    var b = blockByEl(blockEl);
    if (!b) return;
    var cur = blockEl.dataset.type;
    if (cur === "code") {
      pushHistory();
      b.type = "p";
      rerenderBlock(b);
      afterChange();
      return;
    }
    if (cur !== "p" && !/^h[1-6]$/.test(cur)) {
      toast(t("toast.unsupportedSelection"));
      return;
    }
    pushHistory();
    b.type = "code";
    b.lang = "";
    rerenderBlock(b);
    focusCodeStart(b._el);
    afterChange();
  }

  function cmdTable() {
    var blockEl = caretBlockEl();
    if (!blockEl) return;
    var b = blockByEl(blockEl);
    if (!b) return;
    var idx = state.blocks.indexOf(b);
    pushHistory();
    var nb = { type: "table", src: "|  |  |\n| --- | --- |\n|  |  |" };
    insertBlockAfter(idx, nb);
    focusCell(nb._el, 0, 0, 0);
    afterChange();
  }

  function cmdHr() {
    var blockEl = caretBlockEl();
    if (!blockEl) return;
    var b = blockByEl(blockEl);
    if (!b) return;
    var idx = state.blocks.indexOf(b);
    pushHistory();
    insertBlockAfter(idx, { type: "hr", src: "" });
    var p = { type: "p", src: "" };
    insertBlockAfter(idx + 1, p);
    caretAtBlockStart(p._el);
    afterChange();
  }

  /* ================= 公式 / 图表 / 脚注 / Front Matter / 段落插入 ================= */

  // mermaid 图表模板（图表子菜单）
  var CHART_PRESETS = {
    flow: "flowchart TD\n    A[开始] --> B{条件}\n    B -->|是| C[完成]\n    B -->|否| A",
    sequence: "sequenceDiagram\n    participant 用户\n    participant 系统\n    用户->>系统: 请求数据\n    系统-->>用户: 返回结果",
    pie: 'pie title 占比\n    "甲" : 40\n    "乙" : 35\n    "丙" : 25',
    gantt: "gantt\n    title 计划\n    dateFormat YYYY-MM-DD\n    section 阶段一\n    任务甲 :a1, 2026-01-01, 30d\n    任务乙 :after a1, 20d",
    class: "classDiagram\n    class 动物{\n      +String 名字\n      +叫()\n    }\n    class 狗\n    动物 <|-- 狗",
    state: "stateDiagram-v2\n    [*] --> 待处理\n    待处理 --> 已完成: 提交\n    已完成 --> [*]",
  };

  // 源码编辑对话框（公式 / 图表 / Front Matter 共用）
  function srcEditDialog(title, value, hint, onOk) {
    var body = el("div");
    var ta = document.createElement("textarea");
    ta.className = "dlg-src";
    ta.value = value || "";
    ta.spellcheck = false;
    ta.setAttribute("wrap", "off");
    body.appendChild(ta);
    if (hint) body.appendChild(el("span", "hint", hint));
    dlgOpen(title, body, [
      { label: t("dlg.cancel"), value: null },
      { label: t("dlg.ok"), value: "ok", primary: true },
    ]).then(function (v) {
      if (v === "ok") onOk(ta.value);
    });
    setTimeout(function () { ta.focus(); ta.select(); }, 0);
  }

  function cmdMath() {
    var blockEl = caretBlockEl();
    if (!blockEl) return;
    var b = blockByEl(blockEl);
    if (!b) return;
    var cur = blockEl.dataset.type;
    if (cur === "math") { editMathBlock(b); return; }
    if (cur === "table" || cur === "hr" || cur === "code" || cur === "chart" ||
        cur === "frontmatter" || cur === "footnotes") {
      toast(t("toast.unsupportedSelection"));
      return;
    }
    pushHistory();
    if (isList(cur)) {
      var items = window.axMd.parseList(b.src);
      b.src = items.map(function (it) { return it.inline; }).join("\n");
    }
    b.type = "math";
    b.src = "";
    rerenderBlock(b);
    editMathBlock(b);
    afterChange();
  }

  function editMathBlock(b) {
    srcEditDialog(t("dlg.math.title"), b.src, t("dlg.math.hint"), function (v) {
      b.src = v;
      rerenderBlock(b);
      afterChange();
    });
  }

  function cmdChart(preset) {
    var blockEl = caretBlockEl();
    if (!blockEl) return;
    var b = blockByEl(blockEl);
    if (!b) return;
    var idx = state.blocks.indexOf(b);
    pushHistory();
    var nb = { type: "chart", lang: "mermaid", src: CHART_PRESETS[preset] || CHART_PRESETS.flow };
    insertBlockAfter(idx, nb);
    afterChange();
  }

  function editChartBlock(b) {
    srcEditDialog(t("dlg.chart.title"), b.src, t("dlg.chart.hint"), function (v) {
      b.src = v;
      rerenderBlock(b);
      afterChange();
    });
  }

  function cmdFrontmatter() {
    var first = state.blocks[0];
    if (first && first.type === "frontmatter") {
      var pre = first._el.querySelector(".fm-body");
      if (pre) window.axMd.setPlainOffset(pre, 0);
      return;
    }
    pushHistory();
    var nb = { type: "frontmatter", src: "title: \ndate: " + todayStr() };
    state.blocks.unshift(nb);
    renderAll();
    var pre2 = nb._el.querySelector(".fm-body");
    if (pre2) window.axMd.setPlainOffset(pre2, 0);
    afterChange();
  }

  function editFrontmatterBlock(b) {
    srcEditDialog(t("dlg.frontmatter.title"), b.src, t("dlg.frontmatter.hint"), function (v) {
      b.src = v;
      rerenderBlock(b);
      afterChange();
    });
  }

  function todayStr() {
    var d = new Date();
    var mm = String(d.getMonth() + 1).padStart(2, "0");
    var dd = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + mm + "-" + dd;
  }

  function nextFootnoteNum() {
    var max = 0;
    state.blocks.forEach(function (b) {
      if (b.type === "footnotes") {
        window.axMd.parseFootnotes(b.src).forEach(function (d) {
          var m = /^(\d+)$/.exec(d.label);
          if (m && +m[1] > max) max = +m[1];
        });
      }
    });
    return max + 1;
  }

  // 脚注：光标处插入引用 [^n]，文档末尾（或既有脚注区）追加定义，光标落到定义上
  function cmdFootnote() {
    var n = nextFootnoteNum();
    var g = selectionGlobalRange();
    var src = currentSrc();
    pushHistory();
    var ref = "[^" + n + "]";
    var lines = (src.slice(0, g.start) + ref + src.slice(g.end)).split("\n");
    var lastDef = -1;
    for (var i = 0; i < lines.length; i++) {
      if (/^ {0,3}\[\^[^\]\s]+\]:/.test(lines[i])) lastDef = i;
    }
    var defLine = "[^" + n + "]: ";
    var defOffset;
    if (lastDef >= 0) {
      lines.splice(lastDef + 1, 0, defLine);
      defOffset = lines.slice(0, lastDef + 2).join("\n").length + defLine.length;
    } else {
      lines.push("", defLine);
      defOffset = lines.join("\n").length;
    }
    state.blocks = window.axMd.parse(lines.join("\n"));
    renderAll();
    setCaretGlobalSrc(defOffset);
    afterChange();
  }

  // 在上方 / 下方插入空段落
  function insertParagraph(where) {
    var blockEl = caretBlockEl();
    if (!blockEl) return;
    var b = blockByEl(blockEl);
    if (!b) return;
    // Front Matter 之前的段落无意义：强制插到它下方
    if (where === "above" && b.type === "frontmatter") where = "below";
    var idx = state.blocks.indexOf(b);
    pushHistory();
    var nb = { type: "p", src: "" };
    state.blocks.splice(where === "above" ? idx : idx + 1, 0, nb);
    var node = window.axMd.renderBlock(nb);
    if (b._el && b._el.parentNode) {
      if (where === "above") b._el.before(node); else b._el.after(node);
    } else {
      renderAll();
    }
    applyTableLabels();
    resolveImages();
    enhanceCharts();
    caretAtBlockStart(node);
    afterChange();
  }

  // 标题级别升降（段落视为 0 级：Ctrl+= 升 / Ctrl+- 降）
  function shiftHeading(delta) {
    var blockEl = caretBlockEl();
    if (!blockEl) return;
    var b = blockByEl(blockEl);
    if (!b) return;
    var cur = blockEl.dataset.type;
    if (cur === "table" || cur === "hr" || cur === "code" || cur === "math" ||
        cur === "chart" || cur === "frontmatter" || cur === "footnotes") {
      toast(t("toast.unsupportedSelection"));
      return;
    }
    var m = /^h([1-6])$/.exec(cur);
    var lvl = m ? +m[1] : 0;
    var nl = Math.max(0, Math.min(6, lvl + delta));
    var g = globalSrcOffsetOf(window.getSelection().anchorNode, window.getSelection().anchorOffset);
    pushHistory();
    if (isList(cur)) {
      var items = window.axMd.parseList(b.src);
      b.src = items.map(function (it) { return it.inline; }).join("\n");
    }
    b.type = nl ? "h" + nl : "p";
    rerenderBlock(b);
    setCaretGlobalSrc(g);
    afterChange();
  }

  /* ================= 行内格式命令（格式菜单） ================= */

  function cmdUnderline() { wrapSelection("<u>", "</u>"); }

  function cmdHighlight() { wrapSelection("=="); }

  // 内联公式：有选区包成 $...$；无选区先编辑内容，再插入完整的 $...$。
  function cmdInlineMath() {
    var sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount) { wrapSelection("$"); return; }
    // 空的 $$ 在行首会被块解析器识别为公式块，不能作为内联公式占位符。
    var range = selectionGlobalRange();
    srcEditDialog(t("dlg.math.title"), "", t("dlg.math.hint"), function (v) {
      if (v) insertSourceAtRange("$" + v + "$", range);
    });
  }

  function insertSourceAtRange(text, range) {
    if (!text) return;
    var src = currentSrc();
    pushHistory();
    state.blocks = window.axMd.parse(src.slice(0, range.start) + text + src.slice(range.end));
    renderAll();
    setCaretGlobalSrc(range.start + text.length);
    afterChange();
  }

  // 清除样式：剥离选区（折叠光标时为整个块）的行内格式标记
  function cmdClearFormat() {
    var sel = window.getSelection();
    var blockEl = caretBlockEl();
    if (!blockEl || !sel.rangeCount) return;
    var b = blockByEl(blockEl);
    if (!b) return;
    var bt = blockEl.dataset.type;
    if (bt === "code" || bt === "hr" || bt === "math" || bt === "chart" || bt === "frontmatter") return;
    var base = blockSrcBase(b);
    var ls = 0, le = b.src.length;
    if (!sel.isCollapsed) {
      var gr = selectionGlobalRange();
      var p1 = globalToBlockLocal(gr.start), p2 = globalToBlockLocal(gr.end);
      // 仅同一 p/h/quote 块内的选区做精确剥离；列表/表格/跨块按整块处理
      // （列表项内 data-a 是条目内相对偏移，与块 src 不同坐标系）
      if (p1 && p2 && p1.b === b && p2.b === b &&
          (bt === "p" || bt === "quote" || /^h[1-6]$/.test(bt))) {
        ls = Math.min(p1.local, p2.local);
        le = Math.max(p1.local, p2.local);
        // 扩张：吞没开/闭标记完全在选区外的行内格式 token。
        // 选中「粗体」二字时 ** 标记在选区两侧，不扩张就剥不到标记
        var spans = window.axMd.ownSpans(blockEl);
        for (var i = 0; i < spans.length; i++) {
          var a = +spans[i].getAttribute("data-a"), bb = +spans[i].getAttribute("data-b");
          if (a < ls && bb > le) { ls = a; le = bb; }
        }
      }
    }
    var mid = b.src.slice(ls, le);
    var stripped = window.axMd.stripInline(mid);
    if (stripped === mid) return; // 本就没有行内格式
    pushHistory();
    b.src = b.src.slice(0, ls) + stripped + b.src.slice(le);
    rerenderBlock(b);
    if (sel.isCollapsed) setCaretGlobalSrc(base + localToSerialized(b, stripped.length));
    else setSelectionGlobalSrc(base + localToSerialized(b, ls),
                               base + localToSerialized(b, ls + stripped.length));
    afterChange();
  }

  // 全局 src 偏移 -> { 块, 块内 src 偏移 }（locateGlobalSrc 的偏移版逆变换）
  function globalToBlockLocal(g) {
    var acc = 0;
    for (var i = 0; i < state.blocks.length; i++) {
      var b = state.blocks[i];
      var s = window.axMd.serializeBlock(b);
      if (g <= acc + s.length || i === state.blocks.length - 1) {
        var local = Math.max(0, Math.min(g - acc, s.length));
        if (b.type === "quote") {
          var nl = s.slice(0, local).split("\n").length - 1;
          local = local - 2 * (nl + 1);
        } else if (b.type === "code") {
          local = local - ("```" + (b.lang || "") + "\n").length;
        }
        return { b: b, local: local };
      }
      acc += s.length + 2;
    }
    return null;
  }

  // 图表块：mermaid 渲染（异步；语法失败退化为源码展示）
  var chartSeq = 0;  function enhanceCharts() {
    if (typeof window.mermaid === "undefined" || !window.mermaid.render) return;
    var bodies = document.querySelectorAll("#editor .chart-body");
    for (var i = 0; i < bodies.length; i++) {
      (function (n) {
        var src = n.getAttribute("data-src") || "";
        if (n.dataset.renderedSrc === src) return;
        n.dataset.renderedSrc = src;
        var id = "mmd-" + (++chartSeq);
        try {
          Promise.resolve(window.mermaid.render(id, src)).then(function (r) {
            var svg = typeof r === "string" ? r : (r && r.svg) || "";
            if (svg) n.innerHTML = svg;
          }).catch(function () {
            n.innerHTML = '<pre class="chart-src chart-err">' + window.axMd.esc(src) + "</pre>";
          });
        } catch (e) { /* mermaid 同步异常：保留源码展示 */ }
      })(bodies[i]);
    }
  }

  async function cmdLink() {
    var sel = window.getSelection();
    var selText = sel && !sel.isCollapsed && sel.rangeCount ? sel.toString() : "";
    var vals = await linkDialog(selText);
    if (!vals) return;
    if (!vals.url) { toast(t("toast.needName")); return; }
    insertSource("[" + (vals.text || vals.url) + "](" + vals.url + ")");
  }

  async function cmdImage() {
    var vals = await imageDialog();
    if (!vals) return;
    var src = vals.dataUrl || vals.url;
    if (!src) return;
    insertSource("![" + (vals.alt || "") + "](" + src + ")");
  }

  /* ================= 剪贴板 / 拖放 ================= */

  function onCopy(e) {
    var sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return;
    var g = selectionGlobalRange();
    var src = currentSrc();
    if (e.clipboardData) {
      e.clipboardData.setData("text/plain", src.slice(g.start, g.end));
      e.preventDefault();
    }
  }

  function onCut(e) {
    var sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return;
    e.preventDefault();
    var g = selectionGlobalRange();
    var src = currentSrc();
    if (e.clipboardData) e.clipboardData.setData("text/plain", src.slice(g.start, g.end));
    deleteSelection();
  }

  function onPaste(e) {
    e.preventDefault();
    var cd = e.clipboardData;
    if (!cd) return;
    var text = cd.getData("text/plain");
    if (!text) {
      var html = cd.getData("text/html");
      if (html) {
        var tmp = document.createElement("div");
        tmp.innerHTML = html;
        text = tmp.textContent || "";
      }
    }
    if (text) insertSource(text);
  }

  function onDrop(e) {
    e.preventDefault();
    var dt = e.dataTransfer;
    if (!dt) return;
    if (dt.files && dt.files.length) {
      var f = dt.files[0];
      if (/\.(md|markdown|txt)$/i.test(f.name)) {
        f.text().then(function (text) {
          loadDoc(text, null, 0);
          toast(basename(f.name));
        });
        return;
      }
      if (/^image\//.test(f.type)) {
        insertImageFile(f);
        return;
      }
    }
    var text = dt.getData("text/plain");
    if (text) {
      placeCaretAtPoint(e.clientX, e.clientY);
      insertSource(text);
    }
  }

  async function insertImageFile(f) {
    if (f.size > 2 * 1024 * 1024) {
      toast(t("toast.imageTooLarge"));
      return;
    }
    var dataUrl = await new Promise(function (resolve) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { resolve(null); };
      r.readAsDataURL(f);
    });
    if (!dataUrl) return;
    insertSource("![" + f.name + "](" + dataUrl + ")");
  }

  function placeCaretAtPoint(x, y) {
    if (!document.caretRangeFromPoint) return;
    var r = document.caretRangeFromPoint(x, y);
    if (r && els.editor.contains(r.startContainer)) {
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }

  /* ================= 编辑器点击 ================= */

  function onEditorClick(e) {
    var n = e.target;
    if (!n.closest) return;
    var cbx = n.closest(".cbx");
    if (cbx) { toggleTask(cbx); return; }
    var tblBtn = n.closest(".tbl-btn");
    if (tblBtn) { tableOp(tblBtn); return; }
    var copyBtn = n.closest(".code-copy");
    if (copyBtn) {
      var blockEl = copyBtn.closest("[data-type]");
      var code = blockEl ? blockEl.querySelector("code") : null;
      copyText(code ? code.textContent : "").then(function (ok) {
        if (ok) toast(t("code.copied"));
      });
      return;
    }
    var mathBtn = n.closest(".math-edit");
    if (mathBtn) {
      var mathEl = mathBtn.closest("[data-type]");
      var mb = mathEl ? blockByEl(mathEl) : null;
      if (mb) editMathBlock(mb);
      return;
    }
    var chartBtn = n.closest(".chart-edit");
    if (chartBtn) {
      var chartEl = chartBtn.closest("[data-type]");
      var cb = chartEl ? blockByEl(chartEl) : null;
      if (cb) editChartBlock(cb);
      return;
    }
    var fmBtn = n.closest(".fm-edit");
    if (fmBtn) {
      var fmEl = fmBtn.closest("[data-type]");
      var fb = fmEl ? blockByEl(fmEl) : null;
      if (fb) editFrontmatterBlock(fb);
      return;
    }
    var a = n.closest("a");
    if (a && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      copyText(a.getAttribute("href") || "").then(function (ok) {
        if (ok) toast(t("toast.linkCopied"));
      });
      return;
    }
    var img = n.closest("img");
    if (img && e.detail === 2) { cmdImage(); }
  }

  function toggleTask(cbx) {
    var blockEl = cbx.closest("[data-type]");
    var b = blockByEl(blockEl);
    if (!b) return;
    pushHistory();
    cbx.classList.toggle("on");
    b.src = window.axMd.serializeBlockEl(blockEl);
    afterChange();
  }

  /* ================= 选择变化 ================= */

  function onSelChange() {
    if (rafId) return;
    rafId = requestAnimationFrame(function () {
      rafId = 0;
      if (!els.overlay.classList.contains("hidden")) return;
      updateToolbarState();
      updateOutlineActive();
      if (state.typewriter) scrollTypewriter();
    });
  }

  function setTbActive(cmd, on) {
    var btn = document.querySelector('.tb-btn[data-cmd="' + cmd + '"]');
    if (btn) btn.classList.toggle("active", !!on);
  }

  function updateToolbarState() {
    var sel = window.getSelection();
    var blockEl = caretBlockEl();
    var type = blockEl ? blockEl.dataset.type : "";
    var anc = { bold: false, italic: false, strike: false, code: false, link: false };
    if (sel.rangeCount && sel.anchorNode && blockEl) {
      var n = sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentNode : sel.anchorNode;
      while (n && n !== blockEl && n !== els.editor) {
        var tag = n.tagName;
        if (tag === "STRONG" || tag === "B") anc.bold = true;
        if (tag === "EM" || tag === "I") anc.italic = true;
        if (tag === "S" || tag === "STRIKE" || tag === "DEL") anc.strike = true;
        if (tag === "CODE" && (!n.parentNode || n.parentNode.tagName !== "PRE")) anc.code = true;
        if (tag === "A") anc.link = true;
        n = n.parentNode;
      }
    }
    setTbActive("bold", anc.bold);
    setTbActive("italic", anc.italic);
    setTbActive("strike", anc.strike);
    setTbActive("code", anc.code);
    setTbActive("link", anc.link);
    var hv = "p";
    if (/^h[1-6]$/.test(type)) hv = type;
    if (els["sel-heading"].value !== hv) els["sel-heading"].value = hv;
    setTbActive("ul", type === "ul");
    setTbActive("ol", type === "ol");
    setTbActive("task", type === "task");
    setTbActive("quote", type === "quote");
  }

  function scrollTypewriter() {
    var sel = window.getSelection();
    if (!sel.rangeCount) return;
    var r = sel.getRangeAt(0).getBoundingClientRect();
    if (!r.height && !r.top) return;
    var wrap = els["editor-wrap"].getBoundingClientRect();
    var delta = (r.top + r.bottom) / 2 - (wrap.top + wrap.bottom) / 2;
    if (Math.abs(delta) > 24) els["editor-wrap"].scrollTop += delta;
  }

  /* ================= 侧栏：文件 / 大纲 ================= */

  function renderFiles() {
    var box = els["files-tree"];
    box.innerHTML = "";
    if (!state.dir) return;
    var entries = state.files || [];
    if (!entries.length) {
      box.appendChild(el("div", "ft-empty", t("files.emptyDir")));
      return;
    }
    var frag = document.createDocumentFragment();
    var rootLen = state.dir.length + 1;
    entries.forEach(function (en) {
      // 折叠的目录隐藏其子孙
      for (var d in state.collapsed) {
        if (state.collapsed[d] && en.path.indexOf(d + "\\") === 0) return;
      }
      var rel = en.path.slice(rootLen);
      var depth = rel.split(/[\\/]/).length - 1;
      var row = el("div", "ft-row " + (en.isDir ? "dir" : "file"));
      row.style.paddingLeft = (6 + depth * 14) + "px";
      var ic = el("span", "ft-icon");
      ic.innerHTML = window.axIcons.get(en.isDir ? "folder" : "file-text");
      row.appendChild(ic);
      row.appendChild(el("span", "ft-name", en.name));
      if (!en.isDir && en.path === state.path) row.classList.add("active");
      row.addEventListener("click", function () {
        if (en.isDir) {
          state.collapsed[en.path] = !state.collapsed[en.path];
          renderFiles();
        } else {
          openFile(en.path);
        }
      });
      frag.appendChild(row);
    });
    box.appendChild(frag);
    if (state.truncated) box.appendChild(el("div", "ft-truncated", t("files.truncated")));
  }

  function addRecent(path) {
    state.recent = state.recent.filter(function (r) { return r.path !== path; });
    state.recent.unshift({ path: path, name: basename(path), time: Date.now() });
    if (state.recent.length > 20) state.recent.length = 20;
    storageSet("recent", state.recent);
    renderRecent();
  }

  function renderRecent() {
    var box = els["recent-list"];
    box.innerHTML = "";
    if (!state.recent.length) {
      box.appendChild(el("div", "rc-empty", t("files.noRecent")));
      return;
    }
    state.recent.forEach(function (r, i) {
      var row = el("div", "rc-row");
      row.title = r.path;
      row.appendChild(el("span", "rc-name", r.name || basename(r.path)));
      var del = el("button", "rc-del", "×");
      del.addEventListener("click", function (e) {
        e.stopPropagation();
        state.recent.splice(i, 1);
        storageSet("recent", state.recent);
        renderRecent();
      });
      row.appendChild(del);
      row.addEventListener("click", function () { openFile(r.path); });
      box.appendChild(row);
    });
  }

  function updateOutline() {
    var box = els["outline-list"];
    box.innerHTML = "";
    var items = window.axMd.outline(state.blocks);
    if (!items.length) {
      box.appendChild(el("div", "ol-empty", t("outline.empty")));
      return;
    }
    var frag = document.createDocumentFragment();
    items.forEach(function (o) {
      var row = el("div", "ol-row");
      row.style.paddingLeft = (6 + (o.level - 1) * 12) + "px";
      row.dataset.idx = o.idx;
      var dot = el("span", "ol-dot");
      row.appendChild(dot);
      row.appendChild(el("span", "ol-text", o.text || " "));
      row.addEventListener("click", function () {
        var b = state.blocks[o.idx];
        if (b && b._el) {
          b._el.scrollIntoView({ block: "start" });
          b._el.classList.add("flash");
          setTimeout(function () { b._el.classList.remove("flash"); }, 900);
        }
      });
      frag.appendChild(row);
    });
    box.appendChild(frag);
    updateOutlineActive();
  }

  function updateOutlineActive() {
    var blockEl = caretBlockEl();
    var idx = blockEl ? blockIndexByEl(blockEl) : -1;
    var activeIdx = -1;
    var items = window.axMd.outline(state.blocks);
    for (var i = 0; i < items.length; i++) {
      if (items[i].idx <= idx) activeIdx = items[i].idx;
    }
    document.querySelectorAll(".ol-row").forEach(function (row) {
      row.classList.toggle("active", +row.dataset.idx === activeIdx);
    });
  }

  /* ================= 图片解析 ================= */

  async function resolveImages() {
    var imgs = els.editor.querySelectorAll("img[data-local]");
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      if (img.getAttribute("src")) continue;
      var raw = img.getAttribute("data-local") || "";
      if (!raw) continue;
      if (imageCache[raw]) { img.src = imageCache[raw]; continue; }
      var abs = /^([a-zA-Z]:|[\\/])/.test(raw) ? raw : (docDir() ? docDir() + "\\" + raw : raw);
      try {
        var res = await rpc("fs/readImage", { path: abs });
        imageCache[raw] = res.dataUrl;
        img.src = res.dataUrl;
        img.title = raw;
      } catch (e) {
        img.classList.add("img-broken");
        img.title = t("toast.imageMissing") + ": " + raw;
      }
    }
  }

  function docDir() {
    if (state.path) return dirname(state.path);
    return state.dir || "";
  }

  /* ================= 源码模式 ================= */

  function syncFromSource() {
    if (state.sourceMode) state.blocks = window.axMd.parse(els.source.value);
  }

  function toggleSourceMode() {
    if (!state.sourceMode) {
      els.source.value = currentSrc();
      els.editor.classList.add("hidden");
      els.source.classList.remove("hidden");
      state.sourceMode = true;
      state.sourceEntrySrc = els.source.value;
      state.sourceHistoryPushed = false;
      els["btn-source"].classList.add("active");
      els.source.focus();
    } else {
      syncFromSource();
      var sourceChanged = currentSrc() !== state.sourceEntrySrc;
      state.sourceMode = false;
      els.source.classList.add("hidden");
      els.editor.classList.remove("hidden");
      els["btn-source"].classList.remove("active");
      renderAll();
      if (sourceChanged) afterChange();
      updateCounts();
      updateOutline();
    }
    persistPrefs();
  }

  function onSourceKeyDown(e) {
    var mod = e.ctrlKey || e.metaKey;
    if (mod && key0(e) === "s" && !e.shiftKey) { e.preventDefault(); save(); }
    else if (mod && e.shiftKey && key0(e) === "s") { e.preventDefault(); saveAs(); }
    else if (mod && key0(e) === "o") { e.preventDefault(); openFileDialog(); }
    else if (mod && e.key === "/") { e.preventDefault(); toggleSourceMode(); }
    else if (e.key === "Tab") {
      e.preventDefault();
      var ta = els.source, s = ta.selectionStart, en = ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + "  " + ta.value.slice(en);
      ta.selectionStart = ta.selectionEnd = s + 2;
      markDirty();
    }
  }
  function key0(e) { return (e.key || "").toLowerCase(); }

  /* ================= 对话框 ================= */

  function dlgOpen(title, bodyNode, buttons) {
    return new Promise(function (resolve) {
      if (activeDialogCancel) activeDialogCancel();
      els.overlay.classList.remove("hidden");
      els["dlg-title"].textContent = title;
      els["dlg-body"].innerHTML = "";
      els["dlg-body"].appendChild(bodyNode);
      els["dlg-foot"].innerHTML = "";
      var done = false;
      var cancel = function () { finish(null); };
      function finish(v) {
        if (done) return;
        done = true;
        if (activeDialogCancel === cancel) activeDialogCancel = null;
        els.overlay.classList.add("hidden");
        document.removeEventListener("keydown", onKey, true);
        resolve(v);
      }
      activeDialogCancel = cancel;
      function onKey(ev) {
        if (ev.key === "Escape") { ev.preventDefault(); finish(null); }
        else if (ev.key === "Enter" && ev.target.tagName !== "TEXTAREA") {
          var primary = buttons.filter(function (b) { return b.primary; })[0];
          if (primary) { ev.preventDefault(); finish(primary.value); }
        }
      }
      document.addEventListener("keydown", onKey, true);
      buttons.forEach(function (b) {
        var btn = el("button", "btn " + (b.primary ? "btn-primary" : "btn-ghost"), b.label);
        btn.addEventListener("click", function () { finish(b.value); });
        els["dlg-foot"].appendChild(btn);
      });
      var inp = els["dlg-body"].querySelector("input");
      if (inp) inp.focus();
    });
  }

  function field(labelText, inputId, value, placeholder) {
    var wrap = el("div", "field");
    var lb = el("label", null, labelText);
    lb.setAttribute("for", inputId);
    var inp = document.createElement("input");
    inp.id = inputId;
    inp.type = "text";
    inp.value = value || "";
    inp.autocomplete = "off";
    if (placeholder) inp.placeholder = placeholder;
    wrap.appendChild(lb);
    wrap.appendChild(inp);
    return { wrap: wrap, input: inp };
  }

  async function linkDialog(selText) {
    var body = el("div");
    var f1 = field(t("dlg.link.text"), "ld-text", selText, t("dlg.link.textPlaceholder"));
    var f2 = field(t("dlg.link.url"), "ld-url", "", t("dlg.link.urlPlaceholder"));
    body.appendChild(f1.wrap);
    body.appendChild(f2.wrap);
    var v = await dlgOpen(t("dlg.link.title"), body, [
      { label: t("dlg.cancel"), value: null },
      { label: t("dlg.link.ok"), value: "ok", primary: true },
    ]);
    if (v !== "ok") return null;
    return { text: f1.input.value.trim(), url: f2.input.value.trim() };
  }

  async function imageDialog() {
    var body = el("div");
    var f1 = field(t("dlg.image.url"), "id-url", "", t("dlg.image.urlPlaceholder"));
    var f2 = field(t("dlg.image.alt"), "id-alt", "", "");
    body.appendChild(f1.wrap);
    body.appendChild(f2.wrap);
    var hint = el("span", "hint", t("dlg.image.hint"));
    body.appendChild(hint);
    var localBtn = el("button", "btn btn-ghost btn-sm", t("dlg.image.pick"));
    localBtn.style.marginTop = "10px";
    localBtn.addEventListener("click", async function () {
      try {
        var res = await rpc("fs/pickFile", { filter: "image" }, 300000);
        if (!res.cancelled && res.path) {
          var img = await rpc("fs/readImage", { path: res.path });
          f1.input.value = img.dataUrl;
        }
      } catch (e) {
        toast(t("toast.dialogUnavailable"));
      }
    });
    body.appendChild(localBtn);
    var v = await dlgOpen(t("dlg.image.title"), body, [
      { label: t("dlg.cancel"), value: null },
      { label: t("dlg.image.ok"), value: "ok", primary: true },
    ]);
    if (v !== "ok") return null;
    return { url: f1.input.value.trim(), alt: f2.input.value.trim(), dataUrl: "" };
  }

  async function confirmSaveDialog() {
    var body = el("p", null, t("dlg.confirmSaveMsg"));
    var v = await dlgOpen(t("dlg.confirmSaveTitle"), body, [
      { label: t("dlg.cancel"), value: "cancel" },
      { label: t("dlg.dontSave"), value: "dont" },
      { label: t("dlg.save"), value: "save", primary: true },
    ]);
    return v || "cancel";
  }

  async function helpDialog() {
    var body = el("div");
    var h3 = el("h3", null, t("dlg.help.shortcuts"));
    h3.style.margin = "0 0 8px";
    body.appendChild(h3);
    var rows = [
      ["Ctrl+B / Ctrl+I", t("toolbar.bold") + " / " + t("toolbar.italic")],
      ["Ctrl+U", t("menu.underline")],
      ["Ctrl+Shift+X / Alt+Shift+5", t("toolbar.strike")],
      ["Ctrl+Shift+H", t("menu.highlight")],
      ["Ctrl+`", t("toolbar.code")],
      ["Ctrl+K", t("toolbar.link")],
      ["Ctrl+Shift+I", t("toolbar.image")],
      ["Ctrl+\\", t("menu.clearFormat")],
      ["Ctrl+1..6 / Ctrl+0", t("toolbar.heading")],
      ["Ctrl+= / Ctrl+-", (state.lang === "en" ? "Promote / demote heading" : "提升 / 降低标题级别")],
      ["Ctrl+Shift+8 / 7 / 9", t("toolbar.ul") + " / " + t("toolbar.ol") + " / " + t("toolbar.task")],
      ["Ctrl+Shift+] / [", t("toolbar.ul") + " / " + t("toolbar.ol")],
      ["Ctrl+Shift+K / T / M / Q", (state.lang === "en" ? "Code block / table / math / quote" : "代码块 / 表格 / 公式块 / 引用")],
      ["Ctrl+Enter / Ctrl+Shift+Enter", (state.lang === "en" ? "Insert paragraph below / above" : "在下方 / 上方插入段落")],
      ["Ctrl+S / Ctrl+Shift+S / Ctrl+O", t("action.save") + " / " + t("action.saveAs") + " / " + t("action.open")],
      ["Ctrl+E", t("action.export")],
      ["Ctrl+/", t("action.source")],
      ["Ctrl+Z / Ctrl+Y", (state.lang === "en" ? "Undo / Redo" : "撤销 / 重做")],
      ["Tab / Shift+Tab", (state.lang === "en" ? "List indent / table cell" : "列表缩进 / 表格单元格")],
      ["Shift+Enter", (state.lang === "en" ? "Soft line break" : "软换行")],
    ];
    var table = el("table", "kbd-table");
    rows.forEach(function (r) {
      var tr = document.createElement("tr");
      var td1 = document.createElement("td");
      td1.appendChild(el("kbd", null, r[0]));
      tr.appendChild(td1);
      tr.appendChild(el("td", null, r[1]));
      table.appendChild(tr);
    });
    body.appendChild(table);
    var h3b = el("h3", null, t("dlg.help.features"));
    h3b.style.margin = "16px 0 8px";
    body.appendChild(h3b);
    var feats = state.lang === "en"
      ? ["WYSIWYG Markdown editing with live rendering", "Open/save local .md files via native dialogs",
         "Folder browsing, recent files, outline navigation", "Task lists, tables, code blocks, quotes",
         "Math blocks (KaTeX), Mermaid charts, footnotes, YAML front matter",
         "HTML export with print-ready stylesheet", "Typewriter mode, source mode, auto-save"]
      : ["所见即所得编辑，输入即渲染", "通过原生对话框打开/保存本地 .md 文件",
         "文件夹浏览、最近文件、大纲导航", "任务列表、表格、代码块、引用",
         "公式块（KaTeX）、Mermaid 图表、脚注、YAML Front Matter",
         "导出 HTML（含打印样式）", "打字机模式、源码模式、自动保存"];
    var ul = el("ul");
    ul.style.margin = "0";
    ul.style.paddingLeft = "1.2em";
    feats.forEach(function (f) { ul.appendChild(el("li", null, f)); });
    body.appendChild(ul);
    await dlgOpen(t("dlg.help.title"), body, [
      { label: t("dlg.help.close"), value: "ok", primary: true },
    ]);
  }

  /* ================= Toast ================= */

  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.classList.add("hidden"); }, 2600);
  }

  /* ================= 事件绑定 ================= */

  function bindStaticEvents() {
    // 顶栏
    els["btn-new"].addEventListener("click", newFile);
    els["btn-open"].addEventListener("click", openFileDialog);
    els["btn-save"].addEventListener("click", function () { save(); });
    els["btn-export"].addEventListener("click", exportHtml);
    els["btn-sidebar"].addEventListener("click", function () {
      state.sidebar = !state.sidebar;
      applyPrefsUI();
      persistPrefs();
    });
    els["btn-source"].addEventListener("click", toggleSourceMode);
    els["btn-typewriter"].addEventListener("click", function () {
      state.typewriter = !state.typewriter;
      applyPrefsUI();
      persistPrefs();
    });
    els["btn-help"].addEventListener("click", helpDialog);
    els["btn-autosave"].addEventListener("click", function () {
      state.autosave = !state.autosave;
      applyPrefsUI();
      persistPrefs();
      if (state.autosave && state.path && state.dirty) save(true);
    });

    // 工具条
    els.toolbar.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest(".tb-btn") : null;
      if (!btn) return;
      var cmd = btn.dataset.cmd;
      if (cmd === "bold") wrapSelection("**");
      else if (cmd === "italic") wrapSelection("*");
      else if (cmd === "strike") wrapSelection("~~");
      else if (cmd === "code") wrapSelection("`");
      else if (cmd === "ul") cmdList("ul");
      else if (cmd === "ol") cmdList("ol");
      else if (cmd === "task") cmdList("task");
      else if (cmd === "quote") cmdQuote();
      else if (cmd === "codeblock") cmdCodeBlock();
      else if (cmd === "table") cmdTable();
      else if (cmd === "hr") cmdHr();
      else if (cmd === "link") cmdLink();
      else if (cmd === "image") cmdImage();
    });
    els.toolbar.addEventListener("mousedown", function (e) {
      if (e.target.closest && !e.target.closest("select")) e.preventDefault();
    });
    els["sel-heading"].addEventListener("change", function () {
      var v = els["sel-heading"].value;
      cmdHeading(v === "p" ? 0 : +v.slice(1));
    });

    // 顶部下拉菜单（段落 / 格式 / 查看；子菜单用 CSS :hover 展开）
    function closeTbMenus() {
      document.querySelectorAll(".tb-menu.open").forEach(function (m) { m.classList.remove("open"); });
    }
    function initTbMenu(menuId, btnId, onCmd) {
      var menu = $(menuId), btn = $(btnId);
      if (!menu || !btn) return;
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var wasOpen = menu.classList.contains("open");
        closeTbMenus();
        if (!wasOpen) menu.classList.add("open");
      });
      menu.addEventListener("click", function (e) {
        var item = e.target.closest ? e.target.closest(".dd-item[data-cmd]") : null;
        if (!item) return;
        e.stopPropagation();
        closeTbMenus();
        onCmd(item.dataset.cmd, item);
      });
    }
    document.addEventListener("click", closeTbMenus);

    initTbMenu("tb-menu-paragraph", "btn-menu-paragraph", function (cmd, item) {
      if (cmd === "p") cmdHeading(0);
      else if (/^h[1-6]$/.test(cmd)) cmdHeading(+cmd.slice(1));
      else if (cmd === "promote") shiftHeading(1);
      else if (cmd === "demote") shiftHeading(-1);
      else if (cmd === "table") cmdTable();
      else if (cmd === "codeblock") cmdCodeBlock();
      else if (cmd === "math") cmdMath();
      else if (cmd === "quote") cmdQuote();
      else if (cmd === "ol") cmdList("ol");
      else if (cmd === "ul") cmdList("ul");
      else if (cmd === "task") cmdList("task");
      else if (cmd === "insertAbove") insertParagraph("above");
      else if (cmd === "insertBelow") insertParagraph("below");
      else if (cmd === "chart") cmdChart(item.dataset.preset || "flow");
      else if (cmd === "footnote") cmdFootnote();
      else if (cmd === "hr") cmdHr();
      else if (cmd === "frontmatter") cmdFrontmatter();
    });

    initTbMenu("tb-menu-format", "btn-menu-format", function (cmd) {
      if (cmd === "bold") wrapSelection("**");
      else if (cmd === "italic") wrapSelection("*");
      else if (cmd === "underline") cmdUnderline();
      else if (cmd === "code") wrapSelection("`");
      else if (cmd === "inlinemath") cmdInlineMath();
      else if (cmd === "strike") wrapSelection("~~");
      else if (cmd === "highlight") cmdHighlight();
      else if (cmd === "link") cmdLink();
      else if (cmd === "image") cmdImage();
      else if (cmd === "clear") cmdClearFormat();
    });

    initTbMenu("tb-menu-view", "btn-menu-view", function (cmd) {
      if (cmd === "source") toggleSourceMode();
      else if (cmd === "sidebar") {
        state.sidebar = !state.sidebar;
        applyPrefsUI();
        persistPrefs();
      }
      else if (cmd === "typewriter") {
        state.typewriter = !state.typewriter;
        applyPrefsUI();
        persistPrefs();
      }
      else if (cmd === "outline") {
        state.sidebar = true;
        applyPrefsUI();
        persistPrefs();
        var ot = document.querySelector('.side-tab[data-tab="outline"]');
        if (ot) ot.click();
      }
      else if (cmd === "export") exportHtml();
      else if (cmd === "help") helpDialog();
    });

    // 侧栏 tab
    document.querySelectorAll(".side-tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        showPane(tab.dataset.tab);
      });
    });

    // 文件面板
    els["btn-open-dir"].addEventListener("click", function () {
      pickWithFallback("dir", { resolve: function (p) { if (p) openFolder(p); } });
    });
    els["btn-dir-go"].addEventListener("click", function () {
      pickWithFallback("dir", { resolve: function (p) { if (p) openFolder(p); } });
    });
    els["inp-dir"].addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        var p = els["inp-dir"].value.trim();
        if (p) openFolder(p);
      }
    });

    // 内置选择器
    els["picker-up"].addEventListener("click", function () { pickerLoad(pickerParent(picker.path)); });
    els["picker-ok"].addEventListener("click", pickerConfirm);
    els["picker-cancel"].addEventListener("click", function () { pickerClose(null); });
    els["picker-name"].addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); pickerConfirm(); }
      if (e.key === "Escape") { e.preventDefault(); pickerClose(null); }
    });
    els["btn-clear-recent"].addEventListener("click", function () {
      state.recent = [];
      storageSet("recent", []);
      renderRecent();
    });

    // 编辑器
    els.editor.addEventListener("beforeinput", onBeforeInput);
    els.editor.addEventListener("input", onEditorInput);
    els.editor.addEventListener("keydown", onEditorKeyDown);
    els.editor.addEventListener("click", onEditorClick);
    els.editor.addEventListener("paste", onPaste);
    els.editor.addEventListener("cut", onCut);
    els.editor.addEventListener("copy", onCopy);
    els.editor.addEventListener("dragover", function (e) { e.preventDefault(); });
    els.editor.addEventListener("drop", onDrop);
    els.editor.addEventListener("compositionstart", function () {
      state.composing = true;
      if (state.compositionTimer) {
        clearTimeout(state.compositionTimer);
        state.compositionTimer = 0;
      }
    });
    els.editor.addEventListener("compositionend", onCompositionEnd);
    els.editor.addEventListener("change", function (e) {
      var sel = e.target;
      if (sel && sel.classList && sel.classList.contains("code-lang")) {
        var blockEl = sel.closest("[data-type]");
        var b = blockByEl(blockEl);
        if (b) {
          pushHistory();
          b.lang = sel.value;
          blockEl.dataset.lang = sel.value;
          afterChange();
        }
      }
    });

    // 源码模式
    els.source.addEventListener("keydown", onSourceKeyDown);
    els.source.addEventListener("input", function () {
      if (!state.sourceHistoryPushed) {
        pushHistory();
        state.sourceHistoryPushed = true;
      }
      markDirty();
    });

    // 对话框关闭
    els["dlg-close"].addEventListener("click", function () {
      if (activeDialogCancel) activeDialogCancel();
    });

    // 文档级：Ctrl+S/O/E（输入框内交给各自处理）
    document.addEventListener("keydown", function (e) {
      var mod = e.ctrlKey || e.metaKey;
      if (!mod && e.key === "Escape" && picker.resolve && !els["pane-picker"].classList.contains("hidden")) {
        e.preventDefault();
        pickerClose(null);
        return;
      }
      if (!mod) return;
      var k = (e.key || "").toLowerCase();
      var tag = e.target && e.target.tagName;
      if (k === "s" && !e.shiftKey && tag !== "TEXTAREA") { e.preventDefault(); save(); }
      else if (k === "s" && e.shiftKey && tag !== "TEXTAREA") { e.preventDefault(); saveAs(); }
      else if (k === "o" && tag !== "TEXTAREA") { e.preventDefault(); openFileDialog(); }
      else if (k === "e" && tag !== "TEXTAREA") { e.preventDefault(); exportHtml(); }
    });
  }

  boot();
})();
