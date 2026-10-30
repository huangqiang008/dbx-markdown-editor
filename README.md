# Markdown 编辑器（DBX 插件）

DBX 工作台内的**所见即所得** Markdown 编辑器，使用 Typedown/Muya 作为编辑内核，支持源码切换、富文本 Markdown 编辑和本地文件读写。文件 IO 由 Go Sidecar 经 stdio-jsonl 完成，前端通过 DBX 插件桥接访问文件与设置。

```
typedown-frontend（React 外壳 + Muya 编辑内核）
  文件导航 / 大纲 / 最近文件 / 设置 / Markdown 编辑
          ↕ DBX 插件桥
Go Sidecar（backend.exe）
  fs/read write list readImage / pickFile pickSaveFile pickDir
```

## 它解决什么问题

在 DBX 里查看和编辑本地 Markdown 不需要再切换到外部编辑器：打开文件夹浏览笔记、实时预览渲染结果、用任务列表跟踪待办、导出 HTML 分享。文件始终以标准 Markdown 存盘，随时可以用别的工具打开。

## 功能

**编辑体验**
- Muya 所见即所得编辑，支持常用 Markdown 块、行内格式、链接、图片和任务列表
- 快捷插入面板可插入标题、表格、公式、代码块、引用、列表和图表
- 表格工具栏支持调整、对齐和删除表格
- 支持脚注、YAML Front Matter、数学公式与图表块
- 源码模式与所见即所得模式可切换

**文件与导航**
- 打开与保存 Markdown 文件，导出 HTML
- 文件夹浏览、最近文件
- 未保存状态提示，可启用自动保存和打字机模式
- 大纲面板：标题导航，点击跳转

**其他**
- HTML 导出：生成独立 HTML 文件
- Muya 编辑能力包含撤销/重做和搜索
- 插件导航与文件操作界面提供中文文案

## 编辑器架构

React 外壳负责文件导航、偏好设置、导入导出与 DBX 插件桥接；Muya 负责 Markdown 解析、可视化编辑和内容序列化。Go Sidecar 提供文件系统操作，文件内容以 Markdown 文本保存。

## 开发

```bash
# 后端（Go）
cd backend && go build -o ../bin/windows-x64/backend.exe . && go test ./...

# 构建 Muya 前端
npm run build --prefix typedown-frontend

# UI 入口、资源路径和 CSP 字体检查
node tools/ui-check.js

# 本地调试宿主
dbx-plugin dev --path . --port 5190

# 打包 .dbxp
dbx-plugin package .
```

## 权限与安全

- 仅申请 `host.workbench`（面板）与 `host.storage`（偏好持久化）；文件读写全部走 Sidecar 的显式 RPC，前端不直接触达文件系统
- 写盘原子化（同目录临时文件 + rename）；路径校验拒绝空字符并规范化为绝对路径
- 对话框文件名经过滤后才注入 PowerShell 脚本（防注入）

## 已知限制

- 仅提供 Windows 后端（`bin/windows-x64/backend.exe`）；文件对话框使用 Windows 原生 API
- UI 入口为 `ui/typedown/index.html`，资源根目录为 `ui/typedown`；`tools/ui-check.js` 检查入口资源及 CSP 字体兼容性
- 图片以 dataURL 内联显示（上限 2MiB），不做缩放/粘贴上传
- 任务列表暂不支持拖拽排序；表格不支持合并单元格
- 导出的 HTML 中 Mermaid 图依赖 CDN 脚本渲染（离线打开时退化为源码文本）；公式为 KaTeX 服务端渲染的 HTML，符号字体走 CDN
- 脚注定义暂支持单行文本（多段脚注请写在行内）

## 许可证

本项目自有代码按 MIT 许可证发布，见仓库根目录的 `LICENSE`。Typedown/Muya、Go 的 `golang.org/x/image` 与其他第三方代码、字体和资源各自适用其原许可证；打包插件中的 `ui/typedown/PROJECT-LICENSE.txt` 是本项目许可证副本，`ui/typedown/THIRD-PARTY-NOTICES.txt` 和 `ui/typedown/licenses/` 附有第三方声明与许可证文本。
