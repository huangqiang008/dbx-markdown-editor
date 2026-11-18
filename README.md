# Markdown 编辑器（DBX 插件）

DBX 工作台内的所见即所得 Markdown 编辑器。编辑内核来自 **iml-editor-lite**（Tiptap 2 / CodeMirror 6 双模），文件 IO 由 Go Sidecar 经 stdio-jsonl 提供。

```
editor/（React 19 + Vite 7 + Tiptap 2 / CodeMirror 6）
  → 单文件构建 → ui/lite/index.html
          ↕ window.dbxPlugin.invoke
Go Sidecar（backend.exe）
  fs/*  ·  fs/pick*  ·  app/dataDir
```

## 架构

上游 `iml-editor-lite` 的界面只认一个 `window.api` 接口。本插件用 `editor/src/platform/dbxApi.ts` 把这个接口的 43 个方法映射到 DBX 桥与 Go Sidecar，编辑内核（`src/utils`、`src/shared`、`src/extensions`）保持与上游一致，可跟随上游 cherry-pick 修复。

`vite.config.ts` 里的 `dbxSingleFile` 插件把 JS、CSS、KaTeX 字体全部内联进单个 `index.html`——DBX 宿主把 `ui/` 资源内联进 iframe srcdoc，且只验证过单 bundle 加载。

## 功能

- 富文本 / 源码双模切换，源码模式左右实时预览与滚动同步
- **原样保存**：未编辑的块写回原文，表格对齐、CRLF、Setext 标题、列表符号都不改（上游 `fidelity.test.ts` 守着）
- Callout、`[TOC]`、`[[WikiLink]]`、行内公式、脚注、Front Matter、Mermaid、SVG、嵌套任务列表
- 查找替换、斜杠菜单（中文/拼音首字母）、选中气泡、整块移动、专注模式
- 亮 / 暗 / 护眼主题，正文字体、字号、行距、页宽
- 导出单文件 HTML、Word、长图 PNG、PDF
- 标签页、最近文件、文件夹树

## 开发

```bash
# 后端（Go）
cd backend && go build -o ../bin/windows-x64/backend.exe . && go test ./...

# 前端（产物直接写到 ui/lite/）
npm install --prefix editor
npm run build --prefix editor

# 浏览器冒烟（无宿主桥，走内存后端）
npm run dev:web --prefix editor

# 本地调试宿主
dbx-plugin dev --path . --port 5190

# 打包 .dbxp
dbx-plugin package .
```

`editor/` 里已移除 Tauri 壳（`src-tauri/`、`src/platform/tauriApi.ts`、图标与发版配置）。`npm run check --prefix editor` 跑类型检查、ESLint 与 Vitest。

## 已知限制（本次移植）

**功能未接通（上游逻辑依赖桌面壳，垫片目前给的是安全降级）**

- **重启恢复未保存内容**：上游 `appStore.ts` 的会话仍写浏览器本地 KV，沙箱 opaque origin 下不可用（代码有 try/catch，不会崩，但恢复失效）。设置已改走 `app/dataDir` 落盘，会话还没接。
- **外部改动跟随 / 冲突三选一**：`App.tsx` 订阅 `folder:changed`，垫片的 `folder.watch` 只返回 `true`、不发事件，也没有实现轮询。
- **拖入本地 .md 文件**：沙箱只给 `File` 对象，`app.droppedPaths` 返回空路径，拖入不会打开。
- **多选打开**：`dialog.open` 只映射了单个路径，`multiSelections` 失效。
- **长图导出的本地图片**：`exportImage.ts` 仍对 `dbx-asset:` 地址做 `fetch`，会取不到图。
- **PDF**：退化为 `window.print()`，没有静默存成 A4 的能力。
- **桌面外壳能力**：窗口控制、检查更新、在资源管理器显示、打开外部链接、系统剪贴板图文、粘贴网址取标题、网络图片内联、启动时按文件关联打开——均为空实现或返回失败。

**已接通但走的是浏览器能力**

- 本地图片显示：`hydrateDbxAssets()` 走 `fs/readImage` 的 RGBA 像素画到 canvas（沙箱无 `img-src` 权限）。
- 粘贴图片压缩：Chromium 的 canvas 直接编 WebP，`image.toWebp` 返回 `null` 走前端兜底。
- 剪贴板图文：`navigator.clipboard`，受宿主权限门控。

**其他**

- **单文件产物在宿主 srcdoc 中的加载**仍需在 DBX 里实测；本仓库无法验证宿主行为。
- 仅提供 Windows 后端；原生文件对话框依赖 PowerShell，失败时前端会降级。
- 离线：粘贴网址取标题、网络图片内联、检查更新已关闭。

## 许可证

本项目自有代码 MIT，见根目录 `LICENSE`。编辑内核来自 `imoling/iml-editor-lite`（MIT，Copyright (c) 2026 imoling）。

`assets/licenses/` 随 `.dbxp` 一起分发，含上游与本项目 MIT、DOMPurify Apache-2.0、lucide ISC、highlight.js/Mermaid D3 BSD、BSD-2-Clause 传递依赖、JSZip（本分发选择 MIT）、pako（MIT AND Zlib）、Go `x/image` BSD 风格许可、KaTeX 字体许可及 `THIRD-PARTY-NOTICES.txt`。编译后的 `ui/lite/index.html` 里另注入版权与许可声明（内联脚本头部的 `/*!` banner + `<head>` 里的 HTML 注释），由 `editor/scripts/finalize.mjs` 在写最终文件时加上——不要依赖 rollup 的 `output.banner`，它会被 esbuild 的 minify 压掉。**只使用 `iml-editor-lite` 的 lite-v26.4.6 及以上版本**：它是 lite 首个 MIT 版本（26.4.5 及以前为 CC BY-NC 4.0；完整版 `iml-markdown-editor` 26.9.0 之前也是 CC BY-NC 4.0，均禁商用）。勿从这些历史 tag 取码，证据链见 `THIRD-PARTY-NOTICES.txt`。
