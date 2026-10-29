// ui-check.js — UI 静态自检：JS 语法 + i18n 键对齐 + data-i18n 覆盖
// 运行：node tools/ui-check.js
"use strict";
var fs = require("fs");
var path = require("path");
var vm = require("vm");

var root = path.join(__dirname, "..");
var failed = 0;
function fail(msg) { failed++; console.error("FAIL: " + msg); }
function ok(msg) { console.log("ok: " + msg); }

// 1) 语法检查（node --check 等价：new vm.Script）
["ui/icons.js", "ui/i18n.js", "ui/md.js", "ui/main.js"].forEach(function (rel) {
  var src = fs.readFileSync(path.join(root, rel), "utf8");
  try {
    new vm.Script(src, { filename: rel });
    ok("syntax " + rel);
  } catch (e) {
    fail("syntax " + rel + ": " + e.message);
  }
});

// 2) i18n 键对齐
var i18nSrc = fs.readFileSync(path.join(root, "ui/i18n.js"), "utf8");
var sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(i18nSrc, sandbox);
var dict = sandbox.window.axI18n.dict;
var zhKeys = Object.keys(dict["zh-CN"]).sort();
var enKeys = Object.keys(dict.en).sort();
if (JSON.stringify(zhKeys) !== JSON.stringify(enKeys)) {
  fail("i18n keys mismatch\n  zh-only: " + zhKeys.filter(function (k) { return enKeys.indexOf(k) < 0; }) +
    "\n  en-only: " + enKeys.filter(function (k) { return zhKeys.indexOf(k) < 0; }));
} else {
  ok("i18n parity (" + zhKeys.length + " keys)");
}
// 空值检查
zhKeys.forEach(function (k) {
  if (!dict["zh-CN"][k]) fail("zh empty value: " + k);
  if (!dict.en[k]) fail("en empty value: " + k);
});

// 3) data-i18n / data-i18n-title / data-i18n-placeholder 覆盖
var html = fs.readFileSync(path.join(root, "ui/index.html"), "utf8");
var used = [];
var re = /data-i18n(?:-title|-placeholder)?="([^"]+)"/g;
var m;
while ((m = re.exec(html))) used.push(m[1]);
var missing = used.filter(function (k) { return zhKeys.indexOf(k) < 0; });
if (missing.length) fail("html uses unknown i18n keys: " + missing.join(", "));
else ok("html data-i18n coverage (" + used.length + " refs)");

// 4) main.js 中 t("...") 调用的键必须存在（用环视排除 el(...) 等误匹配）
var mainSrc = fs.readFileSync(path.join(root, "ui/main.js"), "utf8");
var tRe = /(?<![A-Za-z0-9_$])t\("([\w.]+)"\)/g;
var tKeys = [];
while ((m = tRe.exec(mainSrc))) tKeys.push(m[1]);
var tMissing = tKeys.filter(function (k, i) { return zhKeys.indexOf(k) < 0; });
if (tMissing.length) fail("main.js unknown i18n keys: " + tMissing.join(", "));
else ok("main.js i18n keys (" + tKeys.length + " refs)");

// 5) md.js 中 data-i18n 静态键（tbl.* 在 applyTableLabels 里动态映射，单独校验）
["tbl.addRow", "tbl.delRow", "tbl.addCol", "tbl.delCol", "tbl.deleteTable", "code.copy"].forEach(function (k) {
  if (zhKeys.indexOf(k) < 0) fail("md.js mapping missing key: " + k);
});
ok("md.js label keys");

// 6) 图标引用存在
var iconsSrc = fs.readFileSync(path.join(root, "ui/icons.js"), "utf8");
var iconNames = [];
var iRe = /iconBtn\("[^"]+", "([\w-]+)"\)/g;
while ((m = iRe.exec(mainSrc))) iconNames.push(m[1]);
var cRe = /cmds = \{([^}]+)\}/;
var cmdsMatch = cRe.exec(mainSrc);
if (cmdsMatch) {
  var cRe2 = /(\w+): "([\w-]+)"/g;
  while ((m = cRe2.exec(cmdsMatch[1]))) iconNames.push(m[2]);
}
["file-text", "folder", "copy"].forEach(function (n) { iconNames.push(n); });
iconNames.forEach(function (n) {
  if (iconsSrc.indexOf('"' + n + '":') < 0 && iconsSrc.indexOf(n + ":") < 0) fail("missing icon: " + n);
});
ok("icon refs (" + iconNames.length + ")");

// 7) 沙箱内联安全：宿主会把 ui/*.js / ui/*.css 内联进沙箱 HTML（iframe srcdoc）。
//    若源码含裸 script/style 开闭序列，HTML 解析器会提前闭合元素，导致整个脚本
//    SyntaxError —— md.js 曾因导出模板里的 </script> 在真实宿主中整体挂掉。
//    规则：.js 不得含 <script / </script；.css 不得含 <style / </style（均大小写不敏感）。
function walkFiles(dir, out) {
  fs.readdirSync(dir).forEach(function (n) {
    var p = path.join(dir, n);
    if (fs.statSync(p).isDirectory()) walkFiles(p, out);
    else out.push(p);
  });
  return out;
}
var uiFiles = walkFiles(path.join(root, "ui"), []);
var jsFiles = uiFiles.filter(function (p) {
  // Built React bundles are external resources; tag-shaped strings inside
  // their parser/runtime code cannot terminate an inline script block.
  var generatedTypedown = p.replace(/\\/g, "/").indexOf("ui/typedown/static/js/") >= 0;
  return /\.js$/i.test(p) && !generatedTypedown;
});
var cssFiles = uiFiles.filter(function (p) { return /\.css$/i.test(p); });
var danger = [];
jsFiles.forEach(function (p) {
  var content = fs.readFileSync(p, "utf8");
  var m = /<\/?script/i.exec(content);
  if (m) danger.push(path.relative(root, p).replace(/\\/g, "/") + " @" + m.index);
});
cssFiles.forEach(function (p) {
  var content = fs.readFileSync(p, "utf8");
  var m = /<\/?style/i.exec(content);
  if (m) danger.push(path.relative(root, p).replace(/\\/g, "/") + " @" + m.index);
});
if (danger.length) fail("sandbox inline danger (script/style tag sequences):\n  " + danger.join("\n  "));
else ok("sandbox inline safety (" + jsFiles.length + " js, " + cssFiles.length + " css)");

// 8) index.html script 标签配平（内联脚本里若混入闭合序列会表现为数量不齐）
var scriptOpen = (html.match(/<script\b/gi) || []).length;
var scriptClose = (html.match(/<\/script/gi) || []).length;
if (scriptOpen !== scriptClose) fail("index.html script tags unbalanced: " + scriptOpen + " open vs " + scriptClose + " close");
else ok("index.html script tags balanced (" + scriptOpen + ")");

// 9) UI assets are resolved from the manifest UI root, not the entry HTML folder.
var manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
var uiRoot = path.resolve(root, manifest.entrypoints.ui.root);
var uiEntry = path.resolve(root, manifest.entrypoints.ui.entry);
var typedownHtml = fs.readFileSync(uiEntry, "utf8");
var assetRe = /(?:src|href)="([^\"]+)"/g;
var assetPaths = [];
while ((m = assetRe.exec(typedownHtml))) {
  if (!/^(?:[a-z]+:|\/\/|#)/i.test(m[1])) assetPaths.push(m[1]);
}
var missingAssets = assetPaths.filter(function (asset) {
  return !fs.existsSync(path.resolve(uiRoot, asset));
});
if (missingAssets.length) fail("Plugin UI entry references missing assets from UI root: " + missingAssets.join(", "));
else ok("Plugin UI entry assets resolve from UI root (" + assetPaths.length + ")");

var rootMarker = typedownHtml.indexOf('id="root"');
if (rootMarker < 0) rootMarker = typedownHtml.indexOf('id="app"');
var externalScriptMatch = /<script\b[^>]*\bsrc\s*=\s*["'][^"']+["'][^>]*>/i.exec(typedownHtml);
var scriptMarker = externalScriptMatch ? externalScriptMatch.index : -1;
var bodyEndMarker = typedownHtml.indexOf("</body>");
if (rootMarker < 0 || scriptMarker < rootMarker || bodyEndMarker < scriptMarker) {
  fail("Plugin UI bootstrap script must follow the root element inside body");
} else {
  ok("Plugin UI bootstrap runs after body is parsed");
}

var stylesheetPath = assetPaths.find(function (asset) { return /\.css(?:[?#]|$)/i.test(asset); });
if (!stylesheetPath) {
  fail("Plugin UI entry has no stylesheet");
} else {
  var stylesheet = fs.readFileSync(path.resolve(uiRoot, stylesheetPath), "utf8");
  var fontUrlRe = /url\(([^)]*)\)/gi;
  var externalFonts = [];
  while ((m = fontUrlRe.exec(stylesheet))) {
    var fontUrl = m[1].replace(/^['"]|['"]$/g, "").trim();
    if (/\.(?:woff2?|ttf|otf|eot)(?:[?#][^)]*)?$/i.test(fontUrl) && !/^(?:data:|blob:)/i.test(fontUrl)) {
      externalFonts.push(fontUrl);
    }
  }
  if (externalFonts.length) fail("Plugin stylesheet contains non-inline font URLs: " + externalFonts.slice(0, 5).join(", "));
  else ok("Plugin font resources are CSP-compatible");
}

console.log(failed ? "\n" + failed + " checks FAILED" : "\nall UI checks passed");
process.exit(failed ? 1 : 0);
