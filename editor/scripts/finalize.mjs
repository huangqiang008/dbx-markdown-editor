/**
 * 把 Vite 产物合成 DBX 宿主能加载的单个 index.html。
 *
 * DBX 把 ui/ 下的 JS/CSS 内联进 iframe srcdoc：外链资源取不到，源码里的裸 </script
 * 会让 HTML 解析器提前闭合脚本元素。这里统一处理这两件事。
 *
 * 版权与许可声明也在这里注入：Vite/rollup 的 output.banner 会被 esbuild 的 minify
 * 一并压掉（实测 `/*!` 也保不住），只有最终写文件这一步是安全的注入点。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const editorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(editorRoot, '../ui/lite');
const assetsDir = path.join(outDir, 'assets');
const htmlPath = path.join(outDir, 'index.html');

// 版本号以 manifest.json 为准（插件版本，不是编辑内核的上游版本）
let pluginVersion = '';
try {
  pluginVersion = JSON.parse(fs.readFileSync(path.resolve(editorRoot, '../manifest.json'), 'utf8')).version ?? '';
} catch {
  // 读不到就只写不带版本号的声明，不影响产物
}
const versionLabel = pluginVersion ? ` v${pluginVersion}` : '';

/**
 * 产物内的版权与许可声明。
 *
 * MIT / ISC / Apache-2.0 / OFL 都要求「随副本保留版权声明与许可声明」，而 Vite 生产构建
 * 默认丢弃 legal comments —— 单文件产物里会一个声明都不剩。这里注入一份到内联脚本头部，
 * 与 assets/licenses/ 下的许可全文互为兜底。
 */
const LEGAL_BANNER = `/*!
 * Markdown 编辑器 — DBX 插件${versionLabel}
 * Copyright (c) 2026 huangqiang — MIT License
 * 本插件许可全文：assets/licenses/PROJECT-MIT.txt
 *
 * 本产物内嵌以下第三方开源组件，完整许可全文随插件分发于 assets/licenses/：
  *   iml-editor-lite lite-v26.4.6 — MIT — Copyright (c) 2026 imoling
  *   Tiptap / ProseMirror、CodeMirror 6、React、marked、turndown、
  *   lowlight、mermaid、KaTeX、docx、zustand — MIT
  *   highlight.js、Mermaid 的 D3 依赖 — BSD-3-Clause
  *   entities、@mixmark-io/domino — BSD-2-Clause
  *   JSZip — 本分发选择 MIT；pako — MIT AND Zlib
  *   lucide-react — ISC
  *   DOMPurify — Apache-2.0
  *   KaTeX 字体 — Apache-2.0 / SIL OFL 1.1
  *   Go Authors golang.org/x/image — BSD 风格
  *     （各许可全文见 assets/licenses/）
 */`;

const legalNote = `<!--
  Markdown 编辑器 — DBX 插件${versionLabel} · MIT License · Copyright (c) 2026 huangqiang
  本插件许可全文：assets/licenses/PROJECT-MIT.txt
  本文件内嵌 iml-editor-lite lite-v26.4.6（MIT，Copyright (c) 2026 imoling）、
  Tiptap / ProseMirror、CodeMirror 6、React、KaTeX、DOMPurify、lucide-react、highlight.js、Mermaid/D3、JSZip、pako 等第三方开源组件。
  Go 后端使用 golang.org/x/image（Go Authors BSD 风格许可）。
  完整许可全文随插件分发于 assets/licenses/。
-->`;

let html = fs.readFileSync(htmlPath, 'utf8');
const files = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];

const fonts = new Map();
for (const name of files) {
  if (name.endsWith('.woff2')) {
    fonts.set(name, `data:font/woff2;base64,${fs.readFileSync(path.join(assetsDir, name)).toString('base64')}`);
  }
}

const inlineFonts = (css) => css
  // 只保留 woff2：woff / ttf 既没有随包分发（vite 的 drop-legacy-katex-fonts 已删），
  // 又会被宿主的 CSP `font-src data: blob:` 拦掉，每次渲染刷几十条控制台错误。
  // 先整项删掉（连同前面的逗号），再把 woff2 换成 data:，剩下的 src 仍然合法。
  .replace(/,\s*url\((['"]?)[^)'"]+\.(?:woff|ttf)\1\)\s*format\((['"])[^'"]*\2\)/gi, '')
  .replace(
    /url\((['"]?)([^)'"]+\.woff2)\1\)/g,
    (whole, _quote, ref) => {
      const name = path.basename(ref);
      return fonts.get(name) ? `url("${fonts.get(name)}")` : whole;
    },
  );

// CSS：<link rel=stylesheet> → <style>，字体地址换成 data:
html = html.replace(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi, (tag) => {
  const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
  if (!href) return '';
  const file = path.join(assetsDir, path.basename(href));
  if (!fs.existsSync(file)) return '';
  const css = inlineFonts(fs.readFileSync(file, 'utf8')).replace(/<\/style/gi, '<\\/style');
  return `<style>${css}</style>`;
});

// JS：<script src> → 内联，转义会截断宿主的闭合序列
html = html.replace(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*><\/script>/gi, (tag, src) => {
  const file = path.join(assetsDir, path.basename(src));
  if (!fs.existsSync(file)) return tag;
  const js = fs.readFileSync(file, 'utf8')
    .replace(/<\/script/gi, '<\\/script')
    // `<!--` → `<\u0021--`：防止宿主 HTML 解析器把内联脚本切进「script data escaped」状态。
    // 不能写 `<\!--`——`\!` 在 u 标志正则（xml 等语言的语法）里是非法转义，会把 highlight.js
    // 的语法编译炸掉（症状：代码块按钮点了没反应）。`\u0021` 在字符串 / 正则 / 模板串里
    // 都是同一个字符，语义不变且 HTML 解析器认不出来。
    .replace(/<!--/g, '<\\u0021--');
  return `<script type="module">${LEGAL_BANNER}\n${js}</script>`;
});

// 兜底：任何没被上面两步吃掉的 stylesheet 引用都去掉
html = html.replace(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi, '');

// 第二道保险：HTML 注释版声明。即使脚本一侧的 banner 被后续工具改动，产物里仍有出处。
html = html.includes('<head>')
  ? html.replace(/<head>/i, `<head>\n${legalNote}`)
  : `${legalNote}\n${html}`;

fs.writeFileSync(htmlPath, html);
fs.rmSync(assetsDir, { recursive: true, force: true });

const external = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)=["'](?!data:)[^"']+["']/gi)]
  .map((m) => m[0]).slice(0, 5);
const rawClose = (html.match(/<\/script/gi) || []).length;
console.log(`[finalize] index.html ${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MB, 内联字体 ${fonts.size} 个`);
console.log(`[finalize] 外链资源 ${external.length} 个，裸 </script ${rawClose} 处（应为 1：内联脚本自身的结束标签）`);
console.log(`[finalize] 版权声明 ${LEGAL_BANNER.length + legalNote.length} 字节${versionLabel ? `，版本${versionLabel}` : ''}`);
if (external.length) console.log('[finalize] 残留外链:', external);
