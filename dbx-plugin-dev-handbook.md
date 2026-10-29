# DBX 插件开发手册

> 基于官方文档《开发和提交 DBX 插件》(<https://dbxio.com/cn/docs/plugin-development>) 整理。  
> 适用对象：希望为 DBX 开发、打包并提交官方商店插件的开发者。  
> 文档版本参照：Manifest v1 / Host API v1 / Sidecar Protocol v1。

---

## 目录

1. [概述](#1-概述)
2. [应该提交到哪个仓库](#2-应该提交到哪个仓库)
3. [插件由哪些部分组成](#3-插件由哪些部分组成)
4. [Manifest 完整说明](#4-manifest-完整说明)
   - 4.1 [最小前端字段](#41-最小前端字段)
   - 4.2 [engines、权限和入口](#42-engines权限和入口)
   - 4.3 [Connection Provider](#43-connection-provider)
   - 4.4 [其他 Contributions](#44-其他-contributions)
   - 4.5 [文件系统协议](#45-文件系统协议)
   - 4.6 [国际化](#46-国际化)
5. [Workbench 上下文契约](#5-workbench-上下文契约)
6. [前端 Host API](#6-前端-host-api)
   - 6.1 [估算执行计划](#61-估算执行计划)
   - 6.2 [Table Schema Metadata](#62-table-schema-metadata)
   - 6.3 [只读数据查询](#63-只读数据查询)
   - 6.4 [系统剪贴板](#64-系统剪贴板)
   - 6.5 [文件传输与系统拖放](#65-文件传输与系统拖放)
   - 6.6 [持久化 UI 状态](#66-持久化-ui-状态)
   - 6.7 [在 DBX AI 中分析插件数据](#67-在-dbx-ai-中分析插件数据)
   - 6.8 [主题、布局和静态资源](#68-主题布局和静态资源)
7. [原生 Sidecar 和 RPC](#7-原生-sidecar-和-rpc)
8. [为 DBX AI 助手提供工具](#8-为-dbx-ai-助手提供工具)
9. [创建插件](#9-创建插件)
10. [构建候选包](#10-构建候选包)
11. [本地调试和验证](#11-本地调试和验证)

- 11.1 [本地验收清单](#111-本地验收清单)

1. [提交官方商店的完整流程](#12-提交官方商店的完整流程)
2. [更新已有插件](#13-更新已有插件)
3. [签名和发布者身份](#14-签名和发布者身份)
4. [相关资料](#15-相关资料)

---

## 1. 概述

DBX 插件是独立安装的 `.dbxp` 包，可为 DBX 提供以下能力：

- **连接类型（Connection Provider）**：新增自定义数据源连接。
- **工作台（Workbench）**：在沙箱前端中渲染自定义 UI 面板。
- **文件系统（Filesystem）**：将外部存储暴露为可浏览的文件系统。
- **原生 Sidecar**：以 Rust / Go 编写的后端进程，通过 JSON-RPC 与宿主通信。

**推荐开发路径**：

```
dbx-plugin create   →   自有仓库开发并发布未签名候选包   →   dbx-store 自动创建/更新候选 PR   →   维护者审核签名   →   进入官方目录
```

**仓库边界原则**：插件功能代码始终在开发者**自有仓库**；只有上架/更新/商店元数据才通过 PR 提交到 `t8y2/dbx-store`。修改 Host、SDK、CLI、协议或官方文档才进入 `t8y2/dbx`。

---

## 2. 应该提交到哪个仓库

| 修改内容                                      | 提交位置                                                           | 是否向官方提 PR |
| ----------------------------------------- | -------------------------------------------------------------- | :-------: |
| 插件前端 / 后端 / 测试 / 发布脚本                     | 插件**自己**的源码仓库                                                  |     否     |
| 新插件上架、版本更新、商店图标/介绍                        | [`t8y2/dbx-store`](https://github.com/t8y2/dbx-store) (`main`) |     是     |
| DBX Host、Manifest Schema、SDK、CLI、Packager | [`t8y2/dbx`](https://github.com/t8y2/dbx) (`main`)             |     是     |
| 官方示例或开发文档                                 | `t8y2/dbx`                                                     |     是     |
| 第三方插件 Bug                                 | 该插件的源码仓库                                                       |     否     |

> 规则要点：能自己仓库解决的，绝不动官方仓库；只有"让插件出现在商店"这一动作才需要 PR。

---

## 3. 插件由哪些部分组成

```
my-plugin/
├── manifest.json          # 声明身份、版本、权限、入口
├── dbx-plugin.toml        # 打包配置
├── assets/                # 静态资源（图标、空状态图等）
├── ui/                    # 沙箱工作台前端
├── backend/               # 可选：原生 Sidecar（Rust / Go）
├── .github/workflows/     # 发布脚本
└── dist/                  # 构建输出，不提交 Git
```

- `manifest.json` 是唯一强制文件，定义插件的一切对外契约。
- 纯前端插件可不含 `backend/`。
- `dist/` 由构建阶段生成，应在 `.gitignore` 中忽略。

---

## 4. Manifest 完整说明

### 4.1 最小前端字段

`Manifest v1` **不接受未声明字段**；路径不能含 `/` 开头、`..`、反斜杠。

| 字段                 | 要求                                                     |
| ------------------ | ------------------------------------------------------ |
| `$schema`          | 指向 manifest schema 的 URL                               |
| `manifest_version` | 固定为 `1`                                                |
| `id`               | 小写字母/数字/`.`/`_`/`-`，全局唯一（建议反向域名，如 `com.example.files`） |
| `name`             | 展示名                                                    |
| `version`          | 语义化版本                                                  |
| `publisher`        | 发布者标识                                                  |
| `engines.host_api` | Host API 版本，如 `"1"`                                    |
| `entrypoints.ui`   | 前端根目录与入口                                               |
| `contributions`    | 声明插件向 DBX 贡献的能力                                        |

最小纯前端 Manifest 示例：

```json
{
  "$schema": "https://raw.githubusercontent.com/t8y2/dbx/main/plugins/manifest.schema.json",
  "manifest_version": 1,
  "id": "com.example.files",
  "name": "Example Files",
  "version": "0.1.0",
  "publisher": "example",
  "description": "Browse files from an example service.",
  "icon": "assets/plugin.svg",
  "source": "https://github.com/example/dbx-plugin-files",
  "homepage": "https://github.com/example/dbx-plugin-files",
  "engines": { "host_api": "1" },
  "permissions": [],
  "entrypoints": { "ui": { "root": "ui", "entry": "ui/index.html" } },
  "contributions": [
    { "type": "workbench", "id": "com.example.files.main", "label": "Files", "icon": "assets/plugin.svg" }
  ]
}
```

### 4.2 engines、权限和入口

`engines` 可同时声明宿主版本与 API 版本：

```json
{
  "engines": { "dbx": ">=0.6.0", "host_api": "1" }
}
```

**权限（permissions）最小化原则**——按需声明，不申请用不到的权限：

| 权限                                 | 含义                          |
| ---------------------------------- | --------------------------- |
| `host.workbench`                   | 注册工作台面板                     |
| `host.events`                      | 监听/发送事件                     |
| `host.filesystem`                  | 暴露文件系统协议                    |
| `host.binary`                      | 调用宿主二进制能力                   |
| `host.plans:read`                  | 只读估算执行计划（**不**授予 SQL 执行）    |
| `host.schema:read`                 | 读取已打开连接的窄化 table schema     |
| `host.data:read`                   | 在用户授权连接上执行一条只读 SQL          |
| `host.clipboard:read`              | 读取系统剪贴板（需门控）                |
| `host.storage`                     | 插件独享键值存储                    |
| `host.ai`                          | 接入全局 AI 面板                  |
| `host.network:https://host[:port]` | CSP `connect-src` 声明，最多 8 个 |

带完整权限与双入口的示例：

```json
{
  "engines": { "dbx": ">=0.6.0", "host_api": "1" },
  "permissions": [
    "host.workbench", "host.events", "host.filesystem", "host.binary",
    "host.plans:read", "host.schema:read", "host.storage",
    "host.clipboard:read", "host.data:read",
    "host.network:https://s3.example.com:443"
  ],
  "entrypoints": {
    "ui": { "root": "ui", "entry": "ui/index.html" },
    "backend": {
      "protocol_versions": [1],
      "transport": "stdio-jsonl",
      "executable": "bin/linux-x64/backend"
    }
  }
}
```

### 4.3 Connection Provider

用于新增数据源连接。字段语义由 `binding` 决定：

| binding                                                         | 语义                         |
| --------------------------------------------------------------- | -------------------------- |
| `config`                                                        | 外部配置项                      |
| `secret`                                                        | 存入 Secret Store（不出现在明文配置里） |
| `name` / `host` / `port` / `username` / `password` / `database` | 标准连接字段                     |

- **条件显隐**：`visible_when` / `required_when` 支持级联判定，最多 8 层。
- **文件选择**：`picker` 在桌面端为本机路径选择，网页端自动变为上传。
- **生命周期**：宿主固定调用 `connection/test`、`connection/connect`、`connection/disconnect`。

示例：

```json
{
  "type": "connection-provider",
  "id": "com.example.files.connection",
  "label": "Example Service",
  "icon": "assets/connection.svg",
  "database_type": "example-files",
  "fields": [
    { "key": "display_name", "label": "Name", "type": "text", "binding": "name", "required": true },
    { "key": "token", "label": "Access token", "type": "password", "binding": "secret", "required": true }
  ],
  "workbench": "com.example.files.main",
  "capabilities": ["test", "connect", "disconnect"],
  "actions": [
    { "id": "refresh", "label": "Refresh metadata", "variant": "outline", "when": "edit", "requires_valid_form": true, "timeout_ms": 30000 }
  ]
}
```

条件显隐与文件选择器：

```json
// 条件显隐：sudo_source == custom 且 read_only == false 时才显示 sudo_command
{ "key": "sudo_command", "label": "Sudo command", "type": "text",
  "visible_when": { "all_of": [
    { "field": "sudo_source", "one_of": ["custom"] },
    { "field": "read_only", "one_of": [false] }
  ] } }

// 文件选择：选择 .pem/.key，并将内容写入 content_field
{ "key": "private_key_path", "label": "Private key path", "type": "text", "binding": "config",
  "picker": { "kind": "file", "accept": [".pem", ".key"], "content_field": "private_key" } }
```

### 4.4 其他 Contributions

除 `workbench`、`connection-provider` 外，Manifest 还可声明文件系统协议等贡献点（详见 4.5）。每个 contribution 必须有全局唯一 `id`，并在权限齐备时才生效。

### 4.5 文件系统协议

插件可将外部存储实现为 DBX 可浏览的文件系统，需声明 `host.filesystem` 权限并暴露对应的 RPC 方法（如 `objects/list`、`objects/read`）。路径、大小、MIME 等元数据按协议约定返回。

### 4.6 国际化

通过 `localizations` 覆盖名称、contribution 标签与字段标签：

```json
{
  "localizations": {
    "zh-CN": {
      "name": "示例文件",
      "contributions": {
        "com.example.files.connection": {
          "label": "示例服务",
          "fields": { "token": { "label": "访问令牌" } }
        }
      }
    }
  }
}
```

---

## 5. Workbench 上下文契约

Workbench 是宿主向插件前端注入的运行上下文。前端通过 `window.dbxPlugin.context` 读取，并通过 `onContext` 订阅变更：

```js
await window.dbxPlugin.ready;
const context = window.dbxPlugin.context;
const off = window.dbxPlugin.onContext((nextContext) => render(nextContext));
```

宿主阻塞对话框（如验证码输入）通过 JSON-RPC 请求：

```json
{
  "jsonrpc": "2.0",
  "id": "prompt-1",
  "method": "host/requestUserInput",
  "params": {
    "prompt": "Verification code (6 digits)",
    "title": "JumpServer login",
    "echo": false,
    "timeoutSecs": 300
  }
}
```

> 上下文安全边界：所有计划/元数据/查询 API **只接受已打开的连接**，宿主不替插件建连/重连、不含凭据。

---

## 6. 前端 Host API

宿主在沙箱 opaque origin 中加载 `ui/index.html`，通过全局 `window.dbxPlugin` 暴露桥接 API。

### 6.1 估算执行计划

```js
if (window.dbxPlugin.capabilities.planApi) {
  const capabilities = await window.dbxPlugin.getPlanCapabilities(connectionId);
  if (capabilities.supports.estimatedPlan) {
    const plan = await window.dbxPlugin.explainPlan({
      connectionId, database, sql, mode: "estimated", timeoutMs: 15000
    });
    render(plan.rawPlan, plan.format);
  }
}
```

### 6.2 Table Schema Metadata

```js
if (window.dbxPlugin.capabilities.schemaMetadataApi) {
  const metadata = await window.dbxPlugin.getTableMetadata({
    connectionId, database, schema, table: "users"
  });
}
```

### 6.3 只读数据查询

```js
if (window.dbxPlugin.capabilities.dataApi) {
  const result = await window.dbxPlugin.queryData({
    connectionId, database,
    sql: "SELECT status, count(*) FROM orders GROUP BY status",
    maxRows: 200
  });
}
```

约束：

- 按连接征求用户同意；
- 仅执行**一条**只读语句；
- 默认上限 500 行，最高 5000 行；
- 返回体上限 8 MiB。

### 6.4 系统剪贴板

```js
const canRead = !!window.dbxPlugin.capabilities.clipboardRead;
try { const text = await window.dbxPlugin.clipboard.readText(); } catch { /* 降级 */ }
```

- 读剪贴板需 `host.clipboard:read` 权限并被门控；
- 写剪贴板无需权限；
- 沙箱内 `navigator.clipboard` 不可用，必须走 `dbxPlugin.clipboard`。

### 6.5 文件传输与系统拖放

插件可声明对拖放/文件传输的支持，宿主按贡献点将系统文件事件路由到插件 RPC 或前端回调。具体方法名与参数以协议约定为准。

### 6.6 持久化 UI 状态

```js
if (window.dbxPlugin.capabilities.storage) {
  await window.dbxPlugin.storage.set("layout", { sidebar: "collapsed" });
  const layout = await window.dbxPlugin.storage.get("layout");
}
```

- `storage` 替代 `localStorage`（沙箱 opaque origin 下 `localStorage` 会抛错）；
- 整库上限 **1 MiB**；
- 仅插件自身可见，跨版本保留。

### 6.7 在 DBX AI 中分析插件数据

**声明默认推荐问题（Manifest）**：

```json
"ai": {
  "recommendations": [
    { "id": "health", "label": "检查 {{resource.name}} 健康状态",
      "prompt": "分析 {{resource.kind}}/{{resource.name}} 的健康状态", "order": 10 }
  ]
}
```

**运行时更新推荐问题**：

```js
await dbxPlugin.ai.setRecommendations({
  context: { resource },
  items: [ { id: "health", label: `检查 ${resource.name}`, prompt: "..." } ]
});
```

**直接打开 Ask / Agent 对话**：

```js
await dbxPlugin.ai.openConversation({
  title: "Watchlist", prompt: "Compare...",
  context: { connectionId }, mode: "agent", send: true
});
```

### 6.8 主题、布局和静态资源

**主题负载携带**：宿主向 `dbxPlugin.context` 注入主题变量；前端用 CSS 变量跟随明暗与品牌色。

**主题 CSS 变量**：

```css
body { background: var(--color-background, #fff); color: var(--color-foreground, #18181b); }
button { background: var(--color-primary, #2563eb); color: var(--color-primary-foreground, #fff); }
```


**懒加载与代码分割**：`ui/` 应以代码分割成块，避免首屏臃肿；静态资源用 `readAssetUrl` 取沙箱内 URL：

```js
const assetUrl = await window.dbxPlugin.readAssetUrl("assets/empty-state.svg");
```

---

## 7. 原生 Sidecar 和 RPC

- 实现 **Sidecar Protocol v1**（JSON-RPC 2.0 over stdio-jsonl）。
- Rust / Go SDK 可用，推荐直接基于 SDK 实现。
- **stdout 只输出协议消息**；日志一律写 **stderr**。
- 环境变量 `DBX_PLUGIN_DATA_DIR` 指向持久化目录（版本升级/卸载保留）。
- 初始化响应中的 `id`/`version` 必须与 `manifest.json` 一致，否则报 `Sidecar identity or protocol does not match manifest`。

Rust 示例：

```rust
use dbx_plugin_sdk::{PluginEmitter, PluginError, PluginHandler, PluginMetadata, PluginServer, RequestContext};
use serde_json::{json, Value};

struct Plugin;

impl PluginHandler for Plugin {
    fn handle(
        &self,
        _ctx: RequestContext,
        method: &str,
        _params: Value,
        _emitter: &PluginEmitter,
    ) -> Result<Value, PluginError> {
        match method {
            "example/ping" => Ok(json!({ "ok": true })),
            _ => Err(PluginError::method_not_found(method)),
        }
    }
}

fn main() -> std::io::Result<()> {
    let metadata = PluginMetadata::new("com.example.files", env!("CARGO_PKG_VERSION"));
    PluginServer::new(metadata, Plugin).serve()
}
```

Sidecar 消息示例：

```json
{"jsonrpc":"2.0","id":1,"method":"plugin/initialize","params":{"host":{"protocolVersions":[1]}}}
{"jsonrpc":"2.0","id":2,"method":"objects/list","params":{"prefix":"docs/"}}
```

前端调用 Sidecar 方法（经宿主桥接）：

```js
const result = await window.dbxPlugin.invoke("objects/list", { prefix: "docs/" }, { timeoutMs: 30000 });
await window.dbxPlugin.notify("objects/changed", { count: result.items.length });
```

---

## 8. 为 DBX AI 助手提供工具

插件可将其能力暴露为 AI 工具（tool），使 DBX AI 能在对话中调用。结合第 6.7 节的 `ai.recommendations` 与 `openConversation`，插件既可"推荐问题"也可"提供可执行工具"。具体工具注册方式（manifest `ai` 字段或 RPC 声明）以协议约定为准——核心是保证：工具具有明确输入输出 schema、能被 AI 安全调用、且受用户授权与权限边界约束。

---

## 9. 创建插件

安装 CLI 并脚手架：

```bash
npm install --global @dbx-app/plugin-cli
dbx-plugin create my-ui-plugin --template frontend
```

可选模板：

- `frontend`：纯前端工作台插件；
- 含后端模板：同时生成 `backend/` 与 Sidecar 入口。

---

## 10. 构建候选包

```bash
dbx-plugin package .
```

产物：

- 未签名的 `.dbxp` 包（构建输出在 `dist/`，不提交 Git）；
- 包元数据 `.artifact.json`；
- 候选清单 `release-candidates.json`（供商店自动建 PR 使用）。

发布配置（`dbx-plugin.toml`）：

```toml
[dev]
ui_build = ["npm", "run", "build"]
ui_watch = ["npm", "run", "build:watch"]
```

商店元数据（`.dbx-store.json`）：

```json
{
  "name": "Example Files",
  "tags": ["files", "storage"],
  "license": "Apache-2.0",
  "releaseNotes": "Initial release."
}
```

候选结构（`candidates/<id>.json`）：

```json
{
  "schemaVersion": 1,
  "id": "com.example.files",
  "publisher": "example",
  "version": "0.1.0",
  "targets": [
    {
      "target": "universal",
      "url": "https://github.com/.../com.example.files-0.1.0-universal.dbxp",
      "sha256": "<64hex>",
      "size": 123456
    }
  ]
}
```

---

## 11. 本地调试和验证

```bash
dbx-plugin dev --path . --port 5190
```

该命令启动本地调试宿主，加载当前插件并暴露调试端口。

### 11.1 本地验收清单

- [ ] `manifest.json` 通过 schema 校验，无未知字段；
- [ ] 权限按最小化原则声明，无冗余；
- [ ] UI 在沙箱 opaque origin 下正常加载，`localStorage` 已替换为 `storage`；
- [ ] 所有 Host API 调用前均检查 `capabilities` 门控；
- [ ] 只读查询仅执行单条语句，且未超行数/体积上限；
- [ ] 剪贴板读受 `host.clipboard:read` 约束，写路径不报错；
- [ ] 如有 Sidecar：stdout 仅协议消息，stderr 输出日志，`DBX_PLUGIN_DATA_DIR` 持久化生效；
- [ ] 主题 CSS 变量跟随宿主明暗切换；
- [ ] AI 推荐问题与对话入口可用；
- [ ] 构建产物不含源码、密钥与未提交资源。

---

## 12. 提交官方商店的完整流程

**第一步：发布源码和候选 Release**

- 打 Git Tag；
- 上传未签名 `.dbxp`、`.artifact.json`、`release-candidates.json`。

**第二步：让 dbx-store 自动创建候选 PR**

- `dbx-store` 同步 Workflow 读取 `release-candidates.json`；
- 自动创建 `candidates/<id>.json` 的 PR（目标 `t8y2/dbx-store@main`）。

**第三步：DBX Store 审核并签名**

- 维护者使用仓库 Ed25519 密钥签名；
- **开发者不接触私钥**。

**第四步：合并候选 PR**

- 签名 Workflow 回写 `plugins/<id>.json` 与 `catalog/index.json`；
- PR 合并后插件进入官方目录。

---

## 13. 更新已有插件

- 提升 `manifest.json` 中 `version`；
- 重新构建候选包并发布 Release；
- `dbx-store` 复用既有候选流程，自动更新 `candidates/<id>.json` 并提交 PR；
- 审核签名后回写 `plugins/<id>.json`。

> 注意：任何上架/版本变更都走 `t8y2/dbx-store` 的候选 PR，而非直接改官方目录。

---

## 14. 签名和发布者身份

- 官方使用**单一仓库签名**，`signingKeyId` 表示仓库密钥。
- **开发者不要**运行 `keygen` 或填写 `signingKeyId`——那是官方/私有仓库运营方才用 CLI 高级签名工具做的事。
- 私有仓库运营方如需自签名，使用高级签名工具并妥善保管 Ed25519 私钥。

```bash
# 仅官方/私有仓库运营方使用，普通插件开发者无需执行
dbx-plugin keygen company.plugins.release
source .dbx-repository-signing-key.env
```

---

## 15. 相关资料

- 官方文档：<https://dbxio.com/cn/docs/plugin-development>
- 插件仓库（上架/更新）：<https://github.com/t8y2/dbx-store>
- 核心仓库（Host/SDK/CLI/协议/文档）：<https://github.com/t8y2/dbx>
- Manifest Schema：`https://raw.githubusercontent.com/t8y2/dbx/main/plugins/manifest.schema.json`
- CLI 包：`@dbx-app/plugin-cli`

---

*本手册由官方文档整理而成，作为开发参考。如官方文档更新，请以官方文档为准。*
