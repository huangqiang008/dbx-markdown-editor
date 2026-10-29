// md.js — Markdown 编辑器核心：解析 / 渲染 / 序列化 / 光标映射
// 无依赖，挂载 window.axMd。纯函数部分（parse/serialize/tokenize/outline 等）
// 不触碰 DOM，可在 Node 下单测；DOM 部分供工作台 UI 调用。
// 设计要点：
//  - 块模型：{type, src, lang}，src 为该块的 Markdown 源文本（列表含标记符，引用不含 "> "）
//  - 行内渲染时每个 token 包裹带 data-a/data-b（源字符区间）的元素，支持 DOM 光标 <-> 源偏移互换
//  - DOM -> Markdown 序列化透明穿过渲染用的 span，保证"渲染-序列化"往返稳定
(function (global) {
  "use strict";

  /* ================= 工具 ================= */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function sanitizeUrl(u) {
    u = String(u == null ? "" : u).trim();
    if (/^(javascript|vbscript|file):/i.test(u)) return "#";
    return u;
  }
  function isLocalSrc(src) {
    return !/^(https?:|data:|mailto:|tel:|#|\/\/)/i.test(String(src || ""));
  }
  function repeat(n, ch) { return new Array(n + 1).join(ch); }

  /* ================= 行内解析 ================= */

  // 匹配 [text](url)，src[i] 必须是 '['；返回 {text, href, end} 或 null
  function matchLink(src, i) {
    var depth = 0, j = i, n = src.length;
    for (; j < n; j++) {
      var c = src[j];
      if (c === "\\") { j++; continue; }
      if (c === "[") depth++;
      else if (c === "]") { depth--; if (depth === 0) break; }
    }
    if (j >= n || src[j + 1] !== "(") return null;
    var k = src.indexOf(")", j + 2);
    if (k < 0) return null;
    var text = src.slice(i + 1, j);
    var href = src.slice(j + 2, k).trim();
    var tm = /^(\S+)\s+["'(].*$/.exec(href); // 去掉标题部分
    if (tm) href = tm[1];
    return { text: text, href: href, end: k + 1 };
  }

  // 行内 tokenize。token: {t:'text'|'space'|'br'|'code'|'strong'|'em'|'del'|'link'|'img', a, b, ...}
  // a/b 为在 src 中的字符区间（含标记符），供光标映射使用。
  function tokenizeInline(src, base) {
    base = base || 0;
    var toks = [], i = 0, n = src.length, textStart = 0;
    function flush(end) {
      if (end > textStart) toks.push({ t: "text", v: src.slice(textStart, end), a: base + textStart, b: base + end });
    }
    while (i < n) {
      var c = src[i];
      if (c === "`") {
        var j = src.indexOf("`", i + 1);
        if (j > i) {
          flush(i);
          toks.push({ t: "code", v: src.slice(i + 1, j), a: base + i, b: base + j + 1 });
          i = j + 1; textStart = i; continue;
        }
      }
      if (c === "*" || c === "_") {
        var run = 1;
        while (src[i + run] === c) run++;
        var marker = run >= 2 ? c + c : c;
        var close = src.indexOf(marker, i + run);
        if (close >= i + run) {
          if (run === 1 && src[close + 1] === c) { i++; continue; } // ** 视为加粗，不吃掉单 *
          flush(i);
          var kids = tokenizeInline(src.slice(i + run, close), base + i + run);
          toks.push({ t: run >= 2 ? "strong" : "em", kids: kids, a: base + i, b: base + close + marker.length });
          i = close + marker.length; textStart = i; continue;
        }
      }
      if (c === "~" && src[i + 1] === "~") {
        var cl = src.indexOf("~~", i + 2);
        if (cl > i + 1) {
          flush(i);
          var k2 = tokenizeInline(src.slice(i + 2, cl), base + i + 2);
          toks.push({ t: "del", kids: k2, a: base + i, b: base + cl + 2 });
          i = cl + 2; textStart = i; continue;
        }
      }
      // 高亮 ==text==
      if (c === "=" && src[i + 1] === "=") {
        var hl = src.indexOf("==", i + 2);
        if (hl > i + 1) {
          flush(i);
          var kh = tokenizeInline(src.slice(i + 2, hl), base + i + 2);
          toks.push({ t: "highlight", kids: kh, a: base + i, b: base + hl + 2 });
          i = hl + 2; textStart = i; continue;
        }
      }
      // 下划线 <u>text</u>（HTML 行内标签，Typora/CommonMark 扩展）
      if (c === "<" && src.slice(i, i + 3).toLowerCase() === "<u>") {
        var closeU = src.toLowerCase().indexOf("</u>", i + 3);
        if (closeU > i + 2) {
          flush(i);
          var ku = tokenizeInline(src.slice(i + 3, closeU), base + i + 3);
          toks.push({ t: "u", kids: ku, a: base + i, b: base + closeU + 4 });
          i = closeU + 4; textStart = i; continue;
        }
      }
      // 行内公式 $...$（防误判：开 $ 后非空白、闭 $ 前非空白、闭 $ 后非数字）
      if (c === "$" && src[i + 1] != null && !/\s/.test(src[i + 1]) && src[i + 1] !== "$") {
        var me = -1;
        for (var j2 = i + 2; j2 < n; j2++) {
          if (src[j2] !== "$") continue;
          if (/\s/.test(src[j2 - 1])) continue;              // 闭 $ 前不能是空白
          var nx = src[j2 + 1];
          if (nx != null && /[0-9$]/.test(nx)) continue;      // 闭 $ 后不能跟数字或 $
          me = j2; break;
        }
        if (me > i + 1) {
          flush(i);
          toks.push({ t: "math", v: src.slice(i + 1, me), a: base + i, b: base + me + 1 });
          i = me + 1; textStart = i; continue;
        }
      }
      // 脚注引用 [^label]
      if (c === "[" && src[i + 1] === "^") {
        var fe = src.indexOf("]", i + 2);
        if (fe > i + 2 && /^[^\]\s\^]+$/.test(src.slice(i + 2, fe))) {
          flush(i);
          toks.push({ t: "fn", v: src.slice(i + 2, fe), a: base + i, b: base + fe + 1 });
          i = fe + 1; textStart = i; continue;
        }
      }
      if (c === "!" && src[i + 1] === "[") {
        var mi = matchLink(src, i + 1);
        if (mi) {
          flush(i);
          toks.push({ t: "img", alt: mi.text, src: mi.href, a: base + i, b: base + mi.end });
          i = mi.end; textStart = i; continue;
        }
      }
      if (c === "[") {
        var ml = matchLink(src, i);
        if (ml) {
          flush(i);
          var k3 = tokenizeInline(ml.text, base + i + 1);
          toks.push({ t: "link", kids: k3, href: ml.href, a: base + i, b: base + ml.end });
          i = ml.end; textStart = i; continue;
        }
      }
      if (c === "\\" && i + 1 < n && /[\\`*_{}\[\]()#+\-.!~>|]/.test(src[i + 1])) {
        flush(i);
        toks.push({ t: "text", v: src[i + 1], a: base + i, b: base + i + 2 });
        i += 2; textStart = i; continue;
      }
      if (c === "\n") {
        var seg = src.slice(textStart, i);
        var sp = / +$/.exec(seg);
        var cut = sp ? i - sp[0].length : i;
        var hard = !!sp && sp[0].length >= 2;
        flush(cut);
        toks.push({ t: hard ? "br" : "space", a: base + cut, b: base + i + 1 });
        i++; textStart = i; continue;
      }
      i++;
    }
    flush(n);
    return toks;
  }

  function renderToks(toks, bare) {
    var h = "";
    for (var k = 0; k < toks.length; k++) {
      var tk = toks[k];
      var at = bare ? "" : ' data-a="' + tk.a + '" data-b="' + tk.b + '"';
      if (tk.t === "text") h += bare ? esc(tk.v) : "<span" + at + ">" + esc(tk.v) + "</span>";
      else if (tk.t === "space") h += bare ? " " : "<span" + at + "> </span>";
      else if (tk.t === "br") h += "<br" + at + ">";
      else if (tk.t === "code") h += "<code" + at + ">" + esc(tk.v) + "</code>";
      else if (tk.t === "math") {
        // 占位 span：浏览器端由 KaTeX 渲染；导出 HTML 由 renderMathHtml 处理。
        // contenteditable=false：公式视为原子元素，光标不进入其内部结构
        h += bare
          ? renderMathHtml(tk.v, false)
          : '<span class="md-math-inline" contenteditable="false"' + at + ' data-math="' + esc(tk.v) + '">' + renderMathHtml(tk.v, false) + "</span>";
      }
      else if (tk.t === "fn") {
        h += bare
          ? '<sup class="md-fn-ref" id="fnref-' + esc(tk.v) + '"><a href="#fn-' + esc(tk.v) + '">[' + esc(tk.v) + "]</a></sup>"
          : '<sup class="md-fn-ref" contenteditable="false" data-fn="' + esc(tk.v) + '"' + at + ">[" + esc(tk.v) + "]</sup>";
      }
      else if (tk.t === "strong") h += "<strong" + at + ">" + renderToks(tk.kids, bare) + "</strong>";
      else if (tk.t === "em") h += "<em" + at + ">" + renderToks(tk.kids, bare) + "</em>";
      else if (tk.t === "del") h += "<s" + at + ">" + renderToks(tk.kids, bare) + "</s>";
      else if (tk.t === "highlight") h += "<mark" + at + ">" + renderToks(tk.kids, bare) + "</mark>";
      else if (tk.t === "u") h += "<u" + at + ">" + renderToks(tk.kids, bare) + "</u>";
      else if (tk.t === "link") {
        h += "<a" + at + ' href="' + esc(sanitizeUrl(tk.href)) + '" target="_blank" rel="noopener noreferrer">' + renderToks(tk.kids, bare) + "</a>";
      } else if (tk.t === "img") {
        var local = isLocalSrc(tk.src);
        var srcAttr = local ? "" : ' src="' + esc(tk.src) + '"';
        var localAttr = local ? ' data-local="' + esc(tk.src) + '"' : "";
        h += '<span class="md-img"' + at + '><img alt="' + esc(tk.alt) + '" draggable="false"' + srcAttr + localAttr + "></span>";
      }
    }
    return h;
  }

  // 行内源码 -> 纯文本（大纲标题、统计用）
  function inlinePlain(src) {
    var toks = tokenizeInline(src), out = "";
    function walk(list) {
      for (var i = 0; i < list.length; i++) {
        var tk = list[i];
        if (tk.t === "text" || tk.t === "space") out += tk.v;
        else if (tk.t === "br") out += " ";
        else if (tk.t === "code") out += tk.v;
        else if (tk.t === "img") out += tk.alt || "";
        else if (tk.t === "math") out += tk.v;
        else if (tk.t === "fn") out += "[" + tk.v + "]";
        else if (tk.kids) walk(tk.kids);
      }
    }
    walk(toks);
    return out;
  }

  // 公式 HTML：浏览器有 KaTeX 时 renderToString，否则退化为源码文本（Node 单测/无库环境）
  function renderMathHtml(tex, display) {
    tex = String(tex == null ? "" : tex);
    if (typeof globalThis.katex !== "undefined" && globalThis.katex && globalThis.katex.renderToString) {
      try {
        return globalThis.katex.renderToString(tex, { displayMode: !!display, throwOnError: false, output: "html" });
      } catch (e) { /* 退化 */ }
    }
    return '<span class="math-fallback">' + esc(tex) + "</span>";
  }

  // 清除行内样式：剥离格式标记，保留纯文本（图片/公式/脚注保留语法，软换行保留）
  function stripInline(src) {
    var toks = tokenizeInline(src), out = "";
    function walk(list) {
      for (var i = 0; i < list.length; i++) {
        var tk = list[i];
        if (tk.t === "text" || tk.t === "space") out += tk.v;
        else if (tk.t === "br") out += "\n";
        else if (tk.t === "code") out += tk.v;
        else if (tk.t === "math") out += "$" + tk.v + "$";
        else if (tk.t === "fn") out += "[^" + tk.v + "]";
        else if (tk.t === "img") out += "![" + (tk.alt || "") + "](" + (tk.src || "") + ")";
        else if (tk.kids) walk(tk.kids); // strong/em/del/highlight/u/link：只取内容
      }
    }
    walk(toks);
    return out;
  }

  /* ================= 块解析 ================= */

  var LIST_UL_RE = /^ {0,3}([-*+])\s+/;
  var LIST_OL_RE = /^ {0,3}\d+[.)]\s+/;

  function isTableSep(line) {
    return /^[\s|:-]+$/.test(line) && line.indexOf("-") >= 0 && line.indexOf("|") >= 0;
  }

  function parse(src) {
    var text = String(src == null ? "" : src).replace(/\r\n?/g, "\n");
    var lines = text.split("\n");
    var blocks = [];
    var i = 0, n = lines.length;
    function push(b) { b.id = blocks.length; blocks.push(b); }

    while (i < n) {
      var line = lines[i];
      if (!line.trim()) { i++; continue; }
      var m;

      // YAML Front Matter（仅文档开头，必须有闭合标记）。
      // 未闭合的首行 --- 应继续按普通分割线处理，不能吞掉后续正文。
      if (i === 0 && /^---\s*$/.test(line)) {
        var fmEnd = i + 1;
        while (fmEnd < n && !/^(---|\.\.\.)\s*$/.test(lines[fmEnd])) fmEnd++;
        if (fmEnd < n) {
          push({ type: "frontmatter", src: lines.slice(i + 1, fmEnd).join("\n") });
          i = fmEnd + 1;
          continue;
        }
      }
      // 代码块（mermaid 围栏归为 chart 块）
      if ((m = /^ {0,3}(`{3,}|~{3,})\s*(\S*)/.exec(line))) {
        var fence = m[1].charAt(0), lang = m[2] || "";
        var closeRe = new RegExp("^ {0,3}" + fence + "{3,}\\s*$");
        var buf = [];
        i++;
        while (i < n && !closeRe.test(lines[i])) { buf.push(lines[i]); i++; }
        if (i < n) i++;
        if (/^mermaid$/i.test(lang)) push({ type: "chart", lang: "mermaid", src: buf.join("\n") });
        else push({ type: "code", lang: lang, src: buf.join("\n") });
        continue;
      }
      // 公式块：$$\n...\n$$ 或单行 $$...$$
      if (/^ {0,3}\$\$/.test(line)) {
        var oneLine = /^ {0,3}\$\$(.+?)\$\$\s*$/.exec(line);
        if (oneLine) { push({ type: "math", src: oneLine[1] }); i++; continue; }
        var mb = [];
        i++;
        while (i < n && !/^ {0,3}\$\$\s*$/.test(lines[i])) { mb.push(lines[i]); i++; }
        if (i < n) i++;
        push({ type: "math", src: mb.join("\n") });
        continue;
      }
      // 标题
      if ((m = /^ {0,3}(#{1,6})\s+(.*)$/.exec(line))) {
        push({ type: "h" + m[1].length, src: m[2].replace(/\s+#+\s*$/, "") });
        i++; continue;
      }
      // 列表
      if (LIST_UL_RE.test(line) || LIST_OL_RE.test(line)) {
        var items = [];
        while (i < n && (LIST_UL_RE.test(lines[i]) || LIST_OL_RE.test(lines[i]))) {
          items.push(lines[i]); i++;
        }
        var isTask = items.some(function (l) { return /^\s*[-*+]\s+\[[ xX]\]/.test(l); });
        var isOrdered = !isTask && items.every(function (l) { return LIST_OL_RE.test(l); });
        push({ type: isTask ? "task" : (isOrdered ? "ol" : "ul"), src: items.join("\n") });
        continue;
      }
      // 引用
      if ((m = /^ {0,3}>\s?(.*)$/.exec(line))) {
        var qb = [];
        while (i < n && (m = /^ {0,3}>\s?(.*)$/.exec(lines[i]))) { qb.push(m[1]); i++; }
        push({ type: "quote", src: qb.join("\n") });
        continue;
      }
      // 脚注定义（连续行聚合成一个脚注区）
      if (/^ {0,3}\[\^[^\]\s]+\]:/.test(line)) {
        var fdefs = [];
        while (i < n && /^ {0,3}\[\^[^\]\s]+\]:/.test(lines[i])) { fdefs.push(lines[i]); i++; }
        push({ type: "footnotes", src: fdefs.join("\n") });
        continue;
      }
      // 表格（当前行 + 下一行分隔行）
      if (/^\s*\|/.test(line) && i + 1 < n && isTableSep(lines[i + 1])) {
        var rows = [];
        while (i < n && /\|/.test(lines[i]) && lines[i].trim()) { rows.push(lines[i]); i++; }
        push({ type: "table", src: serializeTableCols(parseTableCols(rows.join("\n"))) });
        continue;
      }
      // 分割线
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
        push({ type: "hr", src: "" });
        i++; continue;
      }
      // 段落
      var pb = [];
      while (i < n && lines[i].trim() && !isBlockStart(lines[i], lines[i + 1])) { pb.push(lines[i]); i++; }
      if (pb.length === 0) { pb.push(lines[i]); i++; }
      push({ type: "p", src: pb.join("\n") });
    }
    if (blocks.length === 0) push({ type: "p", src: "" });
    return blocks;
  }

  function isBlockStart(line, next) {
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) return true;
    if (/^ {0,3}#{1,6}\s/.test(line)) return true;
    if (/^ {0,3}>/.test(line)) return true;
    if (LIST_UL_RE.test(line) || LIST_OL_RE.test(line)) return true;
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) return true;
    if (/^\s*\|/.test(line) && next != null && isTableSep(next)) return true;
    if (/^ {0,3}\$\$/.test(line)) return true;
    if (/^ {0,3}\[\^[^\]\s]+\]:/.test(line)) return true;
    return false;
  }

  /* ---------- 列表 ---------- */

  function parseList(src) {
    var out = [];
    String(src).split("\n").forEach(function (line) {
      var m = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
      if (!m) {
        if (out.length) out[out.length - 1].inline += "\n" + line; // 续行
        return;
      }
      var indent = m[1].replace(/\t/g, "  ").length;
      var inline = m[4], type = "ul", num = 0, checked = false;
      if (m[3]) { type = "ol"; num = parseInt(m[3], 10); }
      var tm = /^\[([ xX])\]\s+(.*)$/.exec(inline);
      if (tm && m[2]) { type = "task"; checked = tm[1] !== " "; inline = tm[2]; }
      out.push({ indent: indent, type: type, num: num, checked: checked, inline: inline });
    });
    return out;
  }

  function listMarker(it) {
    if (it.type === "task") return it.checked ? "- [x] " : "- [ ] ";
    if (it.type === "ol") return it.num + ". ";
    return "- ";
  }

  function listSrc(items) {
    return items.map(function (it) {
      return repeat(it.indent, " ") + listMarker(it) + it.inline;
    }).join("\n");
  }

  function listTree(items) {
    var root = { indent: -1, children: [] };
    var stack = [root];
    items.forEach(function (it) {
      while (stack.length > 1 && stack[stack.length - 1].indent >= it.indent) stack.pop();
      var node = { indent: it.indent, item: it, children: [] };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    });
    return root.children;
  }

  /* ---------- 表格 ---------- */

  function parseTableCols(src) {
    var lines = String(src).split("\n").filter(function (l) { return l.trim() !== ""; });
    var rows = [];
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i].trim();
      if (isTableSep(l)) continue;
      var cells = l.replace(/^\|/, "").replace(/\|$/, "").split("|").map(function (s) { return s.trim(); });
      rows.push(cells);
    }
    if (rows.length === 0) rows = [[""]];
    var cols = rows[0].length || 1;
    for (var r = 0; r < rows.length; r++) {
      while (rows[r].length < cols) rows[r].push("");
    }
    return { cols: cols, rows: rows };
  }

  function serializeTableCols(tb) {
    var lines = [];
    lines.push("| " + tb.rows[0].join(" | ") + " |");
    var sep = [];
    for (var i = 0; i < tb.cols; i++) sep.push("---");
    lines.push("| " + sep.join(" | ") + " |");
    for (var r = 1; r < tb.rows.length; r++) {
      var row = tb.rows[r].slice(0, tb.cols);
      while (row.length < tb.cols) row.push("");
      lines.push("| " + row.join(" | ") + " |");
    }
    return lines.join("\n");
  }

  /* ================= 序列化：块模型 -> 完整 Markdown ================= */

  function serializeBlock(b) {
    switch (b.type) {
      case "hr": return "---";
      case "math": return "$$\n" + (b.src || "") + "\n$$";
      case "chart": return "```" + (b.lang || "mermaid") + "\n" + (b.src || "") + "\n```";
      case "frontmatter": return "---\n" + (b.src || "") + "\n---";
      case "code": return "```" + (b.lang || "") + "\n" + b.src + "\n```";
      case "quote": return b.src.split("\n").map(function (l) { return "> " + l; }).join("\n");
      default:
        var m = /^h([1-6])$/.exec(b.type);
        if (m) return repeat(+m[1], "#") + " " + b.src;
        return b.src; // p/ul/ol/task/table/footnotes（src 即规范形式）
    }
  }

  function serialize(blocks) {
    return blocks.map(serializeBlock).join("\n\n");
  }

  /* ================= 大纲 / 统计 ================= */

  function outline(blocks) {
    var out = [];
    blocks.forEach(function (b, idx) {
      var m = /^h([1-6])$/.exec(b.type);
      if (m) out.push({ level: +m[1], text: inlinePlain(b.src), idx: idx });
    });
    return out;
  }

  function blockPlain(b) {
    switch (b.type) {
      case "code": return b.src;
      case "chart": return b.src;
      case "math": return b.src;
      case "frontmatter": return "";
      case "ul": case "ol": case "task":
        return parseList(b.src).map(function (it) { return it.inline; }).join("\n");
      case "table":
        return parseTableCols(b.src).rows.map(function (r) { return r.join(" "); }).join("\n");
      case "footnotes":
        return parseFootnotes(b.src).map(function (d) { return d.label + " " + d.text; }).join("\n");
      case "hr": return "";
      default: return b.src; // p/h/quote：\n 即软换行
    }
  }

  function plainText(blocks) {
    return blocks.map(blockPlain).join("\n\n");
  }

  /* ================= DOM 渲染 ================= */

  var LANGS = ["", "text", "js", "ts", "jsx", "tsx", "json", "go", "python", "html", "css", "scss",
    "bash", "sh", "sql", "yaml", "yml", "java", "c", "cpp", "cs", "rust", "php", "ruby", "swift",
    "kotlin", "markdown", "diff", "ini", "toml", "xml", "dockerfile", "makefile"];

  function elFromHtml(html) {
    var t = document.createElement("template");
    t.innerHTML = html;
    return t.content.firstChild;
  }

  function renderListNodes(nodes) {
    var html = "";
    for (var i = 0; i < nodes.length; i++) {
      var nd = nodes[i], it = nd.item;
      var cls = it.type === "task" ? ' class="task-item"' : "";
      var numAttr = it.type === "ol" ? ' data-num="' + it.num + '"' : "";
      var cbx = it.type === "task"
        ? '<span class="cbx' + (it.checked ? " on" : "") + '" role="checkbox" contenteditable="false"></span>'
        : "";
      var kids = nd.children.length ? renderListNodes(nd.children) : "";
      html += "<li" + cls + numAttr + ">" + cbx + renderToks(tokenizeInline(it.inline)) + kids + "</li>";
    }
    return "<ul>" + html + "</ul>";
  }

  function renderTableHtml(src) {
    var tb = parseTableCols(src);
    var html = '<div class="tbl-bar" contenteditable="false">' +
      '<button type="button" class="tbl-btn" data-op="addRow" data-i18n="tbl.addRow"></button>' +
      '<button type="button" class="tbl-btn" data-op="delRow" data-i18n="tbl.delRow"></button>' +
      '<button type="button" class="tbl-btn" data-op="addCol" data-i18n="tbl.addCol"></button>' +
      '<button type="button" class="tbl-btn" data-op="delCol" data-i18n="tbl.delCol"></button>' +
      '<button type="button" class="tbl-btn" data-op="deleteTable" data-i18n="tbl.deleteTable"></button>' +
      "</div><table><thead><tr>";
    for (var c = 0; c < tb.cols; c++) {
      html += "<th>" + renderToks(tokenizeInline(tb.rows[0][c] || "")) + "</th>";
    }
    html += "</tr></thead><tbody>";
    for (var r = 1; r < tb.rows.length; r++) {
      html += "<tr>";
      for (var c2 = 0; c2 < tb.cols; c2++) {
        html += "<td>" + renderToks(tokenizeInline(tb.rows[r][c2] || "")) + "</td>";
      }
      html += "</tr>";
    }
    html += "</tbody></table>";
    return html;
  }

  function langOptions(sel) {
    var html = "";
    for (var i = 0; i < LANGS.length; i++) {
      var v = LANGS[i];
      html += '<option value="' + esc(v) + '"' + (v === sel ? " selected" : "") + ">" + esc(v || "text") + "</option>";
    }
    return html;
  }

  // 脚注定义解析：src -> [{label, text}]
  function parseFootnotes(src) {
    var out = [];
    String(src || "").split("\n").forEach(function (line) {
      var m = /^ {0,3}\[\^([^\]\s]+)\]:\s*(.*)$/.exec(line);
      if (m) out.push({ label: m[1], text: m[2] });
    });
    return out;
  }

  function renderFootnotesHtml(src) {
    var defs = parseFootnotes(src);
    var h = '<ol class="fn-list">';
    for (var i = 0; i < defs.length; i++) {
      h += '<li class="fn-item" data-fn="' + esc(defs[i].label) + '">' +
        renderToks(tokenizeInline(defs[i].text)) +
        '<a class="fn-back" href="#" contenteditable="false" data-ser-skip title="back">&#8617;</a></li>';
    }
    return h + "</ol>";
  }

  function renderBlock(b) {
    var el, t = b.type;
    if (t === "hr") {
      el = elFromHtml('<div class="b-hr" data-type="hr" contenteditable="false"><hr></div>');
    } else if (t === "math") {
      el = elFromHtml('<div class="b-math" data-type="math">' +
        '<div class="math-bar" contenteditable="false">' +
        '<span class="math-tag" data-i18n="math.tag"></span>' +
        '<button type="button" class="math-edit" data-i18n-title="math.edit"></button>' +
        "</div>" +
        '<div class="math-body" contenteditable="false" data-math="' + esc(b.src) + '">' + renderMathHtml(b.src, true) + "</div></div>");
    } else if (t === "chart") {
      el = elFromHtml('<div class="b-chart" data-type="chart" data-lang="' + esc(b.lang || "mermaid") + '">' +
        '<div class="chart-bar" contenteditable="false">' +
        '<span class="chart-tag" data-i18n="chart.tag"></span>' +
        '<button type="button" class="chart-edit" data-i18n-title="chart.edit"></button>' +
        "</div>" +
        '<div class="chart-body" contenteditable="false" data-src="' + esc(b.src) + '"><pre class="chart-src">' + esc(b.src) + "</pre></div></div>");
    } else if (t === "frontmatter") {
      el = elFromHtml('<div class="b-frontmatter" data-type="frontmatter">' +
        '<div class="fm-bar" contenteditable="false">' +
        '<span class="fm-tag" data-i18n="frontmatter.tag"></span>' +
        '<button type="button" class="fm-edit" data-i18n-title="frontmatter.edit"></button>' +
        "</div>" +
        '<pre class="fm-body">' + esc(b.src) + "</pre></div>");
    } else if (t === "footnotes") {
      el = elFromHtml('<div class="b-footnotes" data-type="footnotes">' +
        '<div class="fn-bar" contenteditable="false"><span class="fn-tag" data-i18n="footnotes.title"></span></div>' +
        renderFootnotesHtml(b.src) + "</div>");
    } else if (t === "code") {
      el = elFromHtml('<div class="b-code" data-type="code" data-lang="' + esc(b.lang || "") + '">' +
        '<div class="code-bar" contenteditable="false">' +
        '<select class="code-lang" title="language">' + langOptions(b.lang || "") + "</select>" +
        '<button type="button" class="code-copy" data-i18n-title="code.copy" title="copy"></button>' +
        "</div><pre><code>" + esc(b.src) + "</code></pre></div>");
    } else if (t === "quote") {
      el = elFromHtml('<blockquote class="b-quote" data-type="quote">' + renderToks(tokenizeInline(b.src)) + "</blockquote>");
    } else if (t === "ul" || t === "ol" || t === "task") {
      el = elFromHtml('<div class="b-list" data-type="' + t + '">' + renderListNodes(listTree(parseList(b.src))) + "</div>");
    } else if (t === "table") {
      el = elFromHtml('<div class="b-table" data-type="table">' + renderTableHtml(b.src) + "</div>");
    } else if (t === "p") {
      el = elFromHtml('<p class="b-p" data-type="p">' + renderToks(tokenizeInline(b.src)) + "</p>");
    } else {
      var lvl = +t.slice(1);
      el = elFromHtml("<h" + lvl + ' class="b-h' + lvl + '" data-type="' + t + '">' + renderToks(tokenizeInline(b.src)) + "</h" + lvl + ">");
    }
    b._el = el;
    return el;
  }

  /* ================= DOM -> 块模型 ================= */

  function serInlineNode(node) {
    if (node.nodeType === 3) return node.nodeValue;
    if (node.nodeType !== 1) return "";
    var tag = node.tagName;
    if (tag === "BR") return "\n";
    // 行内公式 / 脚注引用：DOM 结构（KaTeX 输出 / 上标）对序列化不透明，按属性还原源码
    if (node.hasAttribute("data-math")) return node.getAttribute("data-math");
    if (node.hasAttribute("data-fn")) return "[^" + node.getAttribute("data-fn") + "]";
    if (node.hasAttribute("data-ser-skip")) return ""; // 装饰性节点（如脚注回链）
    var kids = serInlineChildren(node);
    if (tag === "STRONG" || tag === "B") return "**" + kids + "**";
    if (tag === "EM" || tag === "I") return "*" + kids + "*";
    if (tag === "S" || tag === "STRIKE" || tag === "DEL") return "~~" + kids + "~~";
    if (tag === "MARK") return "==" + kids + "==";
    if (tag === "U" || tag === "INS") return "<u>" + kids + "</u>";
    if (tag === "CODE") return "`" + node.textContent + "`";
    if (tag === "A") return "[" + kids + "](" + (node.getAttribute("href") || "") + ")";
    if (tag === "IMG") {
      var src = node.getAttribute("data-local") || node.getAttribute("src") || "";
      return "![" + (node.getAttribute("alt") || "") + "](" + src + ")";
    }
    return kids; // SPAN 等透明容器
  }
  function serInlineChildren(el) {
    var out = "";
    for (var i = 0; i < el.childNodes.length; i++) out += serInlineNode(el.childNodes[i]);
    return out;
  }

  function codeText(blockEl) {
    var pre = blockEl.querySelector("pre");
    if (!pre) return "";
    var out = "", w = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: function (n) {
        if (n.nodeType === 3) return NodeFilter.FILTER_ACCEPT;
        if (n.nodeType === 1 && n.tagName === "BR") return NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_SKIP;
      }
    });
    var n;
    while ((n = w.nextNode())) out += n.nodeType === 3 ? n.nodeValue : "\n";
    return out;
  }

  function serializeListEl(rootEl) {
    var lines = [];
    function walkUl(ul, indent) {
      Array.prototype.forEach.call(ul.children, function (li) {
        if (li.tagName !== "LI") return;
        var parts = [];
        Array.prototype.forEach.call(li.childNodes, function (ch) {
          if (ch.nodeType === 1 && ch.tagName === "UL") return;
          parts.push(serInlineNode(ch));
        });
        var inline = parts.join("");
        var cbx = li.querySelector(".cbx");
        var marker;
        if (cbx) marker = cbx.classList.contains("on") ? "- [x] " : "- [ ] ";
        else if (li.getAttribute("data-num")) marker = li.getAttribute("data-num") + ". ";
        else marker = "- ";
        lines.push(repeat(indent * 2, " ") + marker + inline);
        Array.prototype.forEach.call(li.children, function (ch) {
          if (ch.nodeType === 1 && ch.tagName === "UL") walkUl(ch, indent + 1);
        });
      });
    }
    Array.prototype.forEach.call(rootEl.children, function (ch) {
      if (ch.nodeType === 1 && ch.tagName === "UL") walkUl(ch, 0);
    });
    return lines.join("\n");
  }

  function serializeTableEl(el) {
    var table = el.querySelector("table");
    var rows = [];
    if (table) {
      var trs = table.querySelectorAll("tr");
      for (var i = 0; i < trs.length; i++) {
        var cells = [], tds = trs[i].querySelectorAll("th,td");
        for (var j = 0; j < tds.length; j++) cells.push(serInlineChildren(tds[j]));
        rows.push(cells);
      }
    }
    if (rows.length === 0) return "|  |\n| --- |";
    return serializeTableCols({ cols: rows[0].length || 1, rows: rows });
  }

  // 脚注区 DOM -> src（[^label]: text 多行）
  function serializeFootnotesEl(el) {
    var lines = [];
    var items = el.querySelectorAll(".fn-item");
    for (var i = 0; i < items.length; i++) {
      var li = items[i];
      var label = li.getAttribute("data-fn") || "";
      lines.push("[^" + label + "]: " + serInlineChildren(li));
    }
    return lines.join("\n");
  }

  // 单个块元素 -> 模型 src
  function serializeBlockEl(el) {
    var type = el.dataset.type;
    if (type === "hr") return "";
    if (type === "code") return codeText(el);
    if (type === "math") {
      var body = el.querySelector(".math-body");
      return body ? body.getAttribute("data-math") || "" : "";
    }
    if (type === "chart") {
      var cb = el.querySelector(".chart-body");
      return cb ? cb.getAttribute("data-src") || "" : "";
    }
    if (type === "frontmatter") {
      var fm = el.querySelector(".fm-body");
      return fm ? fm.textContent.replace(/\n+$/, "") : "";
    }
    if (type === "quote") return serInlineChildren(el).replace(/\n+$/, "");
    if (type === "table") return serializeTableEl(el);
    if (type === "footnotes") return serializeFootnotesEl(el);
    if (type === "ul" || type === "ol" || type === "task") return serializeListEl(el);
    return serInlineChildren(el); // p / h1..h6
  }

  // 块元素 -> 块对象数组。
  // 类型粘滞：p/h/quote/ul/ol/task 的元素类型即模型类型（标记符由类型隐含、
  // 不在 src 中），避免输入后 h1 被重新解析回 p、quote 内容被解析成标题等。
  function blockFromEl(el) {
    var type = el.dataset.type;
    var src = serializeBlockEl(el);
    if (type === "hr") return [{ type: "hr", src: "" }];
    if (type === "code") return [{ type: "code", lang: el.dataset.lang || "", src: src }];
    if (type === "chart") return [{ type: "chart", lang: el.dataset.lang || "mermaid", src: src }];
    if (type === "math") return [{ type: "math", src: src }];
    if (type === "frontmatter") return [{ type: "frontmatter", src: src }];
    if (type === "quote") return [{ type: "quote", src: src }];
    if (type === "table") return [{ type: "table", src: src }];
    if (type === "footnotes") return [{ type: "footnotes", src: src }];
    return [{ type: type, src: src }]; // p / h1..h6 / ul / ol / task
  }

  /* ================= 光标映射 ================= */

  // 元素自身的行内 span（不进入嵌套列表/表格，避免坐标系混淆）
  function ownSpans(root) {
    var out = [];
    (function walk(n) {
      for (var i = 0; i < n.childNodes.length; i++) {
        var ch = n.childNodes[i];
        if (ch.nodeType !== 1) continue;
        var tag = ch.tagName;
        if (tag === "UL" || tag === "OL" || tag === "TABLE") continue;
        if (ch.hasAttribute("data-a")) out.push(ch);
        walk(ch);
      }
    })(root);
    return out;
  }

  function textWalker(root) {
    return document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: function (n) {
        if (n.nodeType === 3) return NodeFilter.FILTER_ACCEPT;
        if (n.nodeType === 1 && n.tagName === "BR") return NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_SKIP;
      }
    });
  }

  // 行内元素开标记的序列化长度（用于走查时定位"内容起点"）
  function inlineOpenLen(el) {
    var tag = el.tagName;
    if (tag === "STRONG" || tag === "B") return 2; // **
    if (tag === "EM" || tag === "I") return 1;     // *
    if (tag === "S" || tag === "STRIKE" || tag === "DEL") return 2; // ~~
    if (tag === "U") return 3;                     // <u>
    if (tag === "MARK") return 2;                  // ==
    if (tag === "CODE") return 1;                  // `
    if (tag === "A") return 1;                     // [
    return 0; // SPAN 等透明容器（含 .md-img / .cbx）
  }

  // DOM 位置 -> 块内源偏移
  // 通用算法：按文档序走查块内节点，累计序列化长度直至光标节点。
  // 不能用 data-a 快路径——IME 合成期间浏览器会插入无 data-a 的裸文本节点，
  // 此时 span 内可能存在多个子节点，a + offset 会漏算前驱兄弟的序列化长度，
  // 导致光标跳到错误位置（拼音输入后光标前移的直接根因）。
  // 走查对带 data-a/data-b 的已渲染 token 用权威锚点，与 tokenizer 保持一致。
  function srcOffsetIn(blockEl, node, offset) {
    if (blockEl.dataset.type === "code") {
      var code = blockEl.querySelector("code") || blockEl;
      var w = textWalker(code), acc = 0, n;
      while ((n = w.nextNode())) {
        if (n === node) return acc + offset;
        acc += n.nodeType === 3 ? n.nodeValue.length : 1;
      }
      return acc;
    }
    // 光标就在块元素上：按子节点边界计算
    if (node === blockEl) {
      if (offset <= 0) return 0;
      if (offset >= blockEl.childNodes.length) return serInlineChildren(blockEl).length;
      var s0 = 0;
      for (var i0 = 0; i0 < offset; i0++) s0 += serInlineNode(blockEl.childNodes[i0]).length;
      return s0;
    }
    var result = -1;
    (function walk(cur, acc) {
      if (result >= 0) return;
      for (var i = 0; i < cur.childNodes.length; i++) {
        var ch = cur.childNodes[i];
        if (result >= 0) return;
        if (ch === node) {
          if (node.nodeType === 3) { result = acc + Math.min(offset, node.nodeValue.length); return; }
          // 元素节点上的光标：offset=0 在首个子元素之前 = 元素内部内容起点
          //（开标记之后）；offset=len 在末尾子元素之后 = 元素之后（闭标记之后）；
          // 中间 = 开标记之后 + 前驱兄弟序列化长度。
          // 空元素（如刚插入的 <u></u>）只有 offset=0 一个位置，必须落在内部。
          if (offset <= 0) { result = acc + inlineOpenLen(node); return; }
          if (offset >= node.childNodes.length) { result = acc + serInlineNode(node).length; return; }
          var s = 0;
          for (var j = 0; j < offset; j++) s += serInlineNode(node.childNodes[j]).length;
          result = acc + inlineOpenLen(node) + s;
          return;
        }
        if (ch.nodeType === 1 && ch.contains(node)) {
          // 下降：带 data-a 的用权威锚点（token 起点 + 开标记长度 = 内容起点），
          // 裸容器（如 IME 分裂产生的中间层）按开标记长度推
          var next = ch.hasAttribute("data-a")
            ? +ch.getAttribute("data-a") + inlineOpenLen(ch)
            : acc + inlineOpenLen(ch);
          walk(ch, next);
          return;
        }
        // 前驱兄弟：带 data-b 的用权威锚点（消除转义 token 的累计偏差），
        // 裸文本节点（IME 合成插入）按序列化长度累加
        acc = (ch.nodeType === 1 && ch.hasAttribute("data-b"))
          ? +ch.getAttribute("data-b")
          : acc + serInlineNode(ch).length;
      }
    })(blockEl, 0);
    if (result >= 0) return result;
    // 光标节点不在块内（异常路径）：退回整块长度语义
    return offset === 0 ? 0 : serInlineChildren(blockEl).length;
  }

  // 块内源偏移 -> DOM 光标
  function setSrcOffset(blockEl, off) {
    var range = document.createRange();
    if (blockEl.dataset.type === "code") {
      var code = blockEl.querySelector("code");
      if (!code) { range.selectNodeContents(blockEl); range.collapse(false); }
      else {
        var w = textWalker(code), acc = 0, n, placed = false;
        while ((n = w.nextNode())) {
          var len = n.nodeType === 3 ? n.nodeValue.length : 1;
          if (acc + len >= off) {
            if (n.nodeType === 3) range.setStart(n, off - acc);
            else range.setStartAfter(n);
            placed = true;
            break;
          }
          acc += len;
        }
        if (!placed) { range.selectNodeContents(code); range.collapse(false); }
      }
    } else {
      var spans = ownSpans(blockEl);
      var target = null;
      for (var i = 0; i < spans.length; i++) {
        var s = spans[i];
        var a = +s.getAttribute("data-a"), b = +s.getAttribute("data-b");
        if (a <= off && off <= b) target = s; // 后出现的范围更窄（嵌套），取最后一个
      }
      if (!target) {
        range.selectNodeContents(blockEl);
        range.collapse(false);
      } else if (target.tagName === "BR" || target.tagName === "IMG" || !target.firstChild) {
        if (off >= +target.getAttribute("data-b")) range.setStartAfter(target);
        else range.setStartBefore(target);
      } else {
        var rel = off - (+target.getAttribute("data-a"));
        var w2 = document.createTreeWalker(target, NodeFilter.SHOW_TEXT, null);
        var node, acc2 = 0, ok = false;
        while ((node = w2.nextNode())) {
          var l2 = node.nodeValue.length;
          if (acc2 + l2 >= rel) { range.setStart(node, rel - acc2); ok = true; break; }
          acc2 += l2;
        }
        if (!ok) { range.selectNodeContents(target); range.collapse(false); }
      }
    }
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // 元素纯文本长度（BR 计 1，IMG 计 0）
  function plainLenOf(el) {
    var w = textWalker(el), len = 0, n;
    while ((n = w.nextNode())) len += n.nodeType === 3 ? n.nodeValue.length : 1;
    return len;
  }

  // 当前光标在块内的纯文本偏移
  function plainOffsetIn(blockEl) {
    var sel = window.getSelection();
    if (!sel.rangeCount || !blockEl) return 0;
    var w = textWalker(blockEl), acc = 0, n;
    var node = sel.anchorNode, offset = sel.anchorOffset;
    while ((n = w.nextNode())) {
      if (n === node) return acc + offset;
      acc += n.nodeType === 3 ? n.nodeValue.length : 1;
    }
    return acc;
  }

  // 块内纯文本偏移 -> 光标
  function setPlainOffset(blockEl, pt) {
    var w = textWalker(blockEl), acc = 0, n;
    var range = document.createRange();
    while ((n = w.nextNode())) {
      var len = n.nodeType === 3 ? n.nodeValue.length : 1;
      if (acc + len >= pt) {
        if (n.nodeType === 3) range.setStart(n, Math.min(pt - acc, len));
        else range.setStartAfter(n);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      acc += len;
    }
    range.selectNodeContents(blockEl);
    range.collapse(false);
    var sel2 = window.getSelection();
    sel2.removeAllRanges();
    sel2.addRange(range);
  }

  /* ================= 列表/表格：块 src 偏移 <-> DOM 光标 ================= */

  // 列表块：DOM 中的 li 按文档顺序（与 parseList 的平铺顺序一致）
  function listLiEls(rootEl) {
    var out = [];
    function walkUl(ul) {
      Array.prototype.forEach.call(ul.children, function (li) {
        if (li.tagName !== "LI") return;
        out.push(li);
        Array.prototype.forEach.call(li.children, function (ch) {
          if (ch.nodeType === 1 && (ch.tagName === "UL" || ch.tagName === "OL")) walkUl(ch);
        });
      });
    }
    Array.prototype.forEach.call(rootEl.children, function (ch) {
      if (ch.nodeType === 1 && (ch.tagName === "UL" || ch.tagName === "OL")) walkUl(ch);
    });
    return out;
  }

  // 列表块 src 偏移 -> {liIndex, itemLocal}（itemLocal 相对条目行内文本）
  function listPosFromSrc(src, local) {
    var items = parseList(src);
    var acc = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var lineLen = it.indent + listMarker(it).length + it.inline.length;
      var contentStart = acc + it.indent + listMarker(it).length;
      if (local <= acc + lineLen) {
        return { liIndex: i, itemLocal: Math.max(0, Math.min(local - contentStart, it.inline.length)) };
      }
      acc += lineLen + 1; // "\n"
    }
    var lastIdx = items.length - 1;
    if (lastIdx < 0) return { liIndex: 0, itemLocal: 0 };
    return { liIndex: lastIdx, itemLocal: items[lastIdx].inline.length };
  }

  // 列表块：DOM 光标 -> 块 src 偏移
  function listSrcOffsetOf(src, blockEl, node, offset) {
    var el = node && (node.nodeType === 3 ? node.parentNode : node);
    var li = el && el.closest ? el.closest("li") : null;
    if (!li || !blockEl.contains(li)) return 0;
    var items = parseList(src);
    var lis = listLiEls(blockEl);
    var idx = Array.prototype.indexOf.call(lis, li);
    if (idx < 0 || idx >= items.length) return 0;
    var it = items[idx];
    var lineStart = 0;
    for (var i = 0; i < idx; i++) {
      lineStart += items[i].indent + listMarker(items[i]).length + items[i].inline.length + 1;
    }
    var itemLocal = srcOffsetIn(li, node, offset);
    return lineStart + it.indent + listMarker(it).length + Math.max(0, Math.min(itemLocal, it.inline.length));
  }

  /* ---------- 脚注区 ---------- */

  function fnLiEls(rootEl) {
    return rootEl.querySelectorAll(".fn-item");
  }

  function fnMarkerOf(label) { return "[^" + label + "]: "; }

  // 脚注区：块 src 偏移 -> {liIndex, itemLocal}
  function fnPosFromSrc(src, local) {
    var defs = parseFootnotes(src);
    var acc = 0;
    for (var i = 0; i < defs.length; i++) {
      var d = defs[i];
      var lineLen = fnMarkerOf(d.label).length + d.text.length;
      if (local <= acc + lineLen) {
        return { liIndex: i, itemLocal: Math.max(0, Math.min(local - acc - fnMarkerOf(d.label).length, d.text.length)) };
      }
      acc += lineLen + 1;
    }
    var lastIdx = defs.length - 1;
    if (lastIdx < 0) return { liIndex: 0, itemLocal: 0 };
    return { liIndex: lastIdx, itemLocal: defs[lastIdx].text.length };
  }

  // 脚注区：DOM 光标 -> 块 src 偏移
  function fnSrcOffsetOf(src, blockEl, node, offset) {
    var el = node && (node.nodeType === 3 ? node.parentNode : node);
    var li = el && el.closest ? el.closest(".fn-item") : null;
    if (!li || !blockEl.contains(li)) return 0;
    var defs = parseFootnotes(src);
    var lis = fnLiEls(blockEl);
    var idx = Array.prototype.indexOf.call(lis, li);
    if (idx < 0 || idx >= defs.length) return 0;
    var lineStart = 0;
    for (var i = 0; i < idx; i++) {
      lineStart += (fnMarkerOf(defs[i].label) + defs[i].text).length + 1;
    }
    var itemLocal = srcOffsetIn(li, node, offset);
    return lineStart + fnMarkerOf(defs[idx].label).length +
      Math.max(0, Math.min(itemLocal, defs[idx].text.length));
  }

  // 表格：(行,列,格内偏移) -> 块 src 偏移（r=0 为表头行）
  function tableSrcOffset(src, r, c, cellOff) {
    var lines = String(src).split("\n");
    var lineIdx = r === 0 ? 0 : r + 1; // 0=表头, 1=分隔行, 2..=数据行
    var base = 0;
    for (var i = 0; i < lineIdx && i < lines.length; i++) base += lines[i].length + 1;
    var line = lines[lineIdx] || "";
    var cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map(function (s) { return s.trim(); });
    var start = 2;
    for (var j = 0; j < c && j < cells.length; j++) start += cells[j].length + 3;
    return base + start + Math.max(0, Math.min(cellOff, (cells[c] || "").length));
  }

  // 表格：块 src 偏移 -> {r, c, cellOff}
  function tablePosFromSrc(src, local) {
    var lines = String(src).split("\n");
    var acc = 0;
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      if (local <= acc + line.length || li === lines.length - 1) {
        var r = li - 1;
        var cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map(function (s) { return s.trim(); });
        var within = Math.max(0, Math.min(local - acc - 2, Math.max(0, line.length - 2)));
        var pos = 2;
        for (var j = 0; j < cells.length; j++) {
          var cellEnd = pos + cells[j].length;
          if (within <= cellEnd || j === cells.length - 1) {
            return { r: Math.max(0, r), c: j, cellOff: Math.max(0, Math.min(within - pos, cells[j].length)) };
          }
          pos = cellEnd + 3;
        }
        return { r: Math.max(0, r), c: 0, cellOff: 0 };
      }
      acc += line.length + 1;
    }
    return { r: 0, c: 0, cellOff: 0 };
  }

  // 块 src 偏移 -> DOM 位置 {node, offset}（找不到返回 null）
  function locateBlockSrcPos(b, local) {
    var el = b._el;
    if (!el) return null;
    var t = b.type;
    if (t === "ul" || t === "ol" || t === "task") {
      var pos = listPosFromSrc(b.src, local);
      var lis = listLiEls(el);
      var li = lis[pos.liIndex];
      return li ? locateSrcPos(li, pos.itemLocal) : null;
    }
    if (t === "table") {
      var tp = tablePosFromSrc(b.src, local);
      var trs = el.querySelectorAll("tr");
      var tr = trs[tp.r];
      var td = tr ? tr.children[tp.c] : null;
      return td ? locateSrcPos(td, tp.cellOff) : null;
    }
    if (t === "footnotes") {
      var fp = fnPosFromSrc(b.src, local);
      var flis = fnLiEls(el);
      var fli = flis[fp.liIndex];
      return fli ? locateSrcPos(fli, fp.itemLocal) : null;
    }
    return locateSrcPos(el, local); // p / h1..h6 / quote / code
  }

  // 元素内 src 偏移 -> DOM 位置（setSrcOffset 的定位版）
  function locateSrcPos(blockEl, off) {
    if (blockEl.dataset && blockEl.dataset.type === "code") {
      var code = blockEl.querySelector("code");
      if (!code) return { node: blockEl, offset: 0 };
      var w = textWalker(code), acc = 0, n;
      while ((n = w.nextNode())) {
        var len = n.nodeType === 3 ? n.nodeValue.length : 1;
        if (acc + len >= off) {
          if (n.nodeType === 3) return { node: n, offset: Math.min(off - acc, len) };
          return { node: n.parentNode, offset: Array.prototype.indexOf.call(n.parentNode.childNodes, n) + 1 };
        }
        acc += len;
      }
      return { node: code, offset: code.childNodes.length };
    }
    var spans = ownSpans(blockEl);
    var target = null;
    for (var i = 0; i < spans.length; i++) {
      var s = spans[i];
      var a = +s.getAttribute("data-a"), bb = +s.getAttribute("data-b");
      if (a <= off && off <= bb) target = s; // 后出现的范围更窄（嵌套），取最后一个
    }
    if (!target) return { node: blockEl, offset: blockEl.childNodes.length };
    // 原子元素（BR/IMG/公式/脚注）：光标只能落在前后边界
    if (target.tagName === "BR" || target.tagName === "IMG" || !target.firstChild ||
        target.hasAttribute("data-math") || target.hasAttribute("data-fn")) {
      var idx = Array.prototype.indexOf.call(target.parentNode.childNodes, target);
      // 空行内格式元素（<u></u> / <strong></strong> / == 等）：内部唯一位置 = 开标记之后。
      // 折叠光标插入格式对后 selStart 正是该位置，必须放进行内，否则输入落在标记外
      var oaLen = inlineOpenLen(target);
      if (!target.firstChild && oaLen > 0 &&
          off > +target.getAttribute("data-a") && off < +target.getAttribute("data-b")) {
        return { node: target, offset: 0 };
      }
      return off >= +target.getAttribute("data-b")
        ? { node: target.parentNode, offset: idx + 1 }
        : { node: target.parentNode, offset: idx };
    }
    var rel = off - (+target.getAttribute("data-a"));
    var w2 = document.createTreeWalker(target, NodeFilter.SHOW_TEXT, null);
    var node, acc2 = 0;
    while ((node = w2.nextNode())) {
      var l2 = node.nodeValue.length;
      if (acc2 + l2 >= rel) return { node: node, offset: rel - acc2 };
      acc2 += l2;
    }
    return { node: target, offset: target.childNodes.length };
  }

  // 块 src 偏移 -> DOM 光标（覆盖 p/h/quote/code/list/table）
  function setBlockSrcOffset(b, local) {
    var pos = locateBlockSrcPos(b, local);
    if (!pos) return;
    var range = document.createRange();
    range.setStart(pos.node, pos.offset);
    range.collapse(true);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // DOM 光标 -> 块 src 偏移（list/footnotes 需块对象；p/h/quote/code 直接 srcOffsetIn）
  function blockSrcOffsetOf(b, node, offset) {
    var el = b._el;
    if (!el) return 0;
    if (b.type === "ul" || b.type === "ol" || b.type === "task") {
      return listSrcOffsetOf(b.src, el, node, offset);
    }
    if (b.type === "footnotes") {
      return fnSrcOffsetOf(b.src, el, node, offset);
    }
    return srcOffsetIn(el, node, offset);
  }

  /* ================= 导出 ================= */

  function renderBlockHtml(b) {
    switch (b.type) {
      case "hr": return "<hr>";
      case "math": return '<div class="math-block">' + renderMathHtml(b.src, true) + "</div>";
      case "chart":
        // 导出 HTML 中 mermaid 图由 CDN 脚本渲染（离线时退化为源码文本）
        return '<div class="mermaid">' + esc(b.src) + "</div>";
      case "frontmatter": return ""; // front matter 不属于正文内容
      case "footnotes": {
        var defs = parseFootnotes(b.src);
        var fh = '<div class="footnotes"><hr><ol>';
        defs.forEach(function (d) {
          fh += '<li id="fn-' + esc(d.label) + '">' + renderToks(tokenizeInline(d.text), true) +
            ' <a href="#fnref-' + esc(d.label) + '" class="fn-back">&#8617;</a></li>';
        });
        return fh + "</ol></div>";
      }
      case "code":
        return "<pre><code>" + esc(b.src) + "</code></pre>";
      case "quote":
        return "<blockquote>" + renderToks(tokenizeInline(b.src), true).replace(/<br>/g, "<br>") + "</blockquote>";
      case "ul": case "ol": case "task": {
        var tag = b.type === "ol" ? "ol" : "ul";
        var items = parseList(b.src);
        function renderTree(nodes) {
          var h = "<" + tag + ">";
          nodes.forEach(function (nd) {
            var it = nd.item;
            var box = it.type === "task" ? (it.checked ? "☑ " : "☐ ") : "";
            h += "<li>" + box + renderToks(tokenizeInline(it.inline), true) +
              (nd.children.length ? renderTree(nd.children) : "") + "</li>";
          });
          return h + "</" + tag + ">";
        }
        return renderTree(listTree(items));
      }
      case "table": {
        var tb = parseTableCols(b.src);
        var h2 = "<table><thead><tr>";
        tb.rows[0].forEach(function (c) { h2 += "<th>" + renderToks(tokenizeInline(c), true) + "</th>"; });
        h2 += "</tr></thead><tbody>";
        for (var r = 1; r < tb.rows.length; r++) {
          h2 += "<tr>";
          tb.rows[r].forEach(function (c) { h2 += "<td>" + renderToks(tokenizeInline(c), true) + "</td>"; });
          h2 += "</tr>";
        }
        return h2 + "</tbody></table>";
      }
      default: {
        var m = /^h([1-6])$/.exec(b.type);
        var tag2 = m ? "h" + m[1] : "p";
        return "<" + tag2 + ">" + renderToks(tokenizeInline(b.src), true) + "</" + tag2 + ">";
      }
    }
  }

  function toStandaloneHtml(blocks, title, lang) {
    var body = blocks.map(renderBlockHtml).join("\n");
    var dir = lang === "en" ? "ltr" : "ltr";
    // 关键约束：本文件会被宿主内联进沙箱 HTML。若源码里出现裸的 script 闭合
    // 序列，HTML 解析器会在字符串常量中间提前闭合脚本元素，导致整个 md.js
    // SyntaxError、window.axMd 永不挂载（真实宿主实测不做转义）。因此导出
    // 模板中的 script/style 开闭标签一律拼接生成，输出字节不变。
    var scrO = "<scr" + "ipt>", scrC = "</scr" + "ipt>";
    var styO = "<sty" + "le>", styC = "</sty" + "le>";
    // 含图表块时引入 mermaid CDN 渲染（离线打开时退化为源码文本）
    var hasChart = blocks.some(function (b) { return b.type === "chart"; });
    var mermaidScript = hasChart
      ? scrO + " src=\"https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js\">" + scrC + "\n" +
        scrO + "window.addEventListener(\"DOMContentLoaded\",function(){if(window.mermaid){mermaid.initialize({startOnLoad:true,theme:\"default\"});}});" + scrC + "\n"
      : "";
    return "<!DOCTYPE html>\n<html lang=\"" + esc(lang || "zh-CN") + "\" dir=\"" + dir + "\">\n<head>\n<meta charset=\"utf-8\">\n" +
      "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>" + esc(title || "Markdown") + "</title>\n" +
      styO + "\n" + EXPORT_CSS + "\n" + styC + "</head>\n<body>\n<article class=\"markdown-body\">\n" + body +
      "\n</article>\n" + mermaidScript + "</body>\n</html>";
  }

  var EXPORT_CSS = [
    ":root{color-scheme:light}",
    "body{margin:0;background:#fff;color:#1f2328;font:16px/1.75 -apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif}",
    ".markdown-body{max-width:820px;margin:0 auto;padding:48px 24px 96px}",
    "h1,h2,h3,h4,h5,h6{line-height:1.3;margin:1.6em 0 .6em;font-weight:600}",
    "h1{font-size:1.9em}h2{font-size:1.5em;border-bottom:1px solid #d8dee4;padding-bottom:.3em}h3{font-size:1.25em}",
    "p{margin:.8em 0}",
    "code{background:rgba(175,184,193,.2);border-radius:6px;padding:.15em .4em;font:.85em/1.4 Consolas,'Cascadia Code',monospace}",
    "pre{background:#f6f8fa;border-radius:8px;padding:14px 16px;overflow:auto}",
    "pre code{background:none;padding:0}",
    "blockquote{margin:.8em 0;padding:.2em 1em;border-left:4px solid #d0d7de;color:#57606a;background:#f6f8fa;border-radius:0 8px 8px 0}",
    "table{border-collapse:collapse;margin:1em 0;width:100%}",
    "th,td{border:1px solid #d0d7de;padding:6px 12px}",
    "th{background:#f6f8fa}",
    "img{max-width:100%;border-radius:6px}",
    "hr{border:none;border-top:2px solid #d8dee4;margin:2em 0}",
    "a{color:#0969da;text-decoration:none}",
    "ul,ol{padding-left:1.6em}",
    ".md-fn-ref,.footnotes .fn-back{font-size:.85em;vertical-align:super;line-height:0}",
    ".footnotes{margin-top:3em;font-size:.9em;color:#57606a}",
    ".footnotes li{margin:.3em 0}",
    ".math-block{margin:1em 0;overflow-x:auto}",
    ".math-fallback{font-family:Consolas,'Cascadia Code',monospace;background:#f6f8fa;padding:.1em .4em;border-radius:4px}",
    ".mermaid{margin:1em 0;text-align:center}",
    "mark{background:rgba(250,204,21,.45);color:inherit;border-radius:2px;padding:0 .1em}",
    "u{text-decoration:underline}",
    "@media print{body{font-size:12pt}.markdown-body{padding:0}}",
  ].join("\n");

  /* ================= 导出 API ================= */

  var api = {
    esc: esc, sanitizeUrl: sanitizeUrl, isLocalSrc: isLocalSrc, repeat: repeat,
    tokenizeInline: tokenizeInline, renderToks: renderToks, inlinePlain: inlinePlain, stripInline: stripInline,
    parse: parse, serialize: serialize, serializeBlock: serializeBlock,
    parseList: parseList, listTree: listTree, listSrc: listSrc, listMarker: listMarker,
    parseTableCols: parseTableCols, serializeTableCols: serializeTableCols,
    parseFootnotes: parseFootnotes, renderFootnotesHtml: renderFootnotesHtml, renderMathHtml: renderMathHtml,
    outline: outline, plainText: plainText, blockPlain: blockPlain,
    elFromHtml: elFromHtml, renderBlock: renderBlock,
    serializeBlockEl: serializeBlockEl, blockFromEl: blockFromEl,
    srcOffsetIn: srcOffsetIn, setSrcOffset: setSrcOffset, ownSpans: ownSpans, inlineOpenLen: inlineOpenLen,
    listLiEls: listLiEls, listPosFromSrc: listPosFromSrc, listSrcOffsetOf: listSrcOffsetOf,
    fnLiEls: fnLiEls, fnPosFromSrc: fnPosFromSrc, fnSrcOffsetOf: fnSrcOffsetOf,
    tableSrcOffset: tableSrcOffset, tablePosFromSrc: tablePosFromSrc,
    setBlockSrcOffset: setBlockSrcOffset, locateBlockSrcPos: locateBlockSrcPos,
    blockSrcOffsetOf: blockSrcOffsetOf,
    plainLenOf: plainLenOf, plainOffsetIn: plainOffsetIn, setPlainOffset: setPlainOffset,
    toStandaloneHtml: toStandaloneHtml,
    LANGS: LANGS,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.axMd = api;
})(typeof window !== "undefined" ? window : globalThis);
