/**
 * DBX 插件适配层：把 Go Sidecar 的 stdio-jsonl RPC 包成上游界面代码认识的 `window.api`。
 *
 * 形状与 iml-editor-lite 的 Tauri 适配层完全一致（见 src/types/window.d.ts），
 * 所以上游编辑内核、组件和扩展一行都不用改。
 *
 * 没有 window.dbxPlugin 时（npm run dev:web）退化为内存实现，方便在普通浏览器里冒烟验证。
 */
import { assetFileName } from '../shared/assetNames';
import { exportDocument } from '../shared/exportDoc';
import { numberedPath } from '../shared/imageTiles';

declare const __APP_VERSION__: string;

type Listener = (...args: any[]) => void;
type WindowApi = Window['api'];

const DOC_EXT_RE = /\.(md|markdown|mdown|mkd|txt)$/i;
const dirOf = (p: string) => p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')));
const baseOf = (p: string) => p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const hasBridge = () => typeof window !== 'undefined' && !!(window as any).dbxPlugin?.invoke;

/** 统一的 RPC 出口；宿主桥不可用时走内存后端 */
async function rpc<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<T> {
  if (hasBridge()) {
    return await (window as any).dbxPlugin.invoke(method, params, { timeoutMs }) as T;
  }
  return await memoryRpc<T>(method, params);
}

// ── 浏览器冒烟用的内存后端（不落盘，仅用于验证界面能起来）──
const memFiles = new Map<string, string>();
const memDirs = new Set<string>();
let memSettings: Record<string, unknown> = {};

async function memoryRpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const path = String(params.path ?? '');
  switch (method) {
    case 'fs/read':
      if (!memFiles.has(path)) throw new Error('ENOENT');
      return { content: memFiles.get(path) } as T;
    case 'fs/write': memFiles.set(path, String(params.content ?? '')); return { mtime: Date.now() } as T;
    case 'fs/stat': return { exists: memFiles.has(path) || memDirs.has(path), isDir: memDirs.has(path) } as T;
    case 'fs/readDir': {
      const prefix = path.endsWith('/') || path.endsWith('\\') ? path : path + '/';
      const names = new Set<string>();
      const files: { name: string; path: string; isDirectory: boolean }[] = [];
      for (const p of [...memFiles.keys(), ...memDirs]) {
        if (!p.startsWith(prefix)) continue;
        const name = p.slice(prefix.length).split(/[\\/]/)[0];
        if (!name || names.has(name)) continue;
        names.add(name);
        files.push({ name, path: prefix + name, isDirectory: memDirs.has(prefix + name) });
      }
      return { success: true, files, path } as T;
    }
    case 'fs/mkdir': memDirs.add(path); return { success: true } as T;
    case 'fs/rename': {
      const to = String(params.newPath ?? '');
      if (memFiles.has(path)) { memFiles.set(to, memFiles.get(path)!); memFiles.delete(path); }
      return { success: true } as T;
    }
    case 'fs/copy': memFiles.set(String(params.targetPath ?? ''), memFiles.get(String(params.sourcePath ?? '')) ?? ''); return { success: true } as T;
    case 'fs/delete': memFiles.delete(path); memDirs.delete(path); return { success: true } as T;
    case 'fs/writeBytes': memFiles.set(path, '[binary]'); return { success: true } as T;
    case 'app/dataDir': return '/memory' as T;
    case 'app/settingsGet': return memSettings as T;
    case 'app/settingsSave': memSettings = (params.settings as Record<string, unknown>) ?? {}; return { success: true } as T;
    default: throw new Error('no in-memory backend for ' + method);
  }
}

/** 把本地图片/音频地址解析成宿主能给的地址；相对路径按笔记目录补全 */
function absolutePathOf(src: string, noteDir: string | null): string | null {
  if (!src || /^(https?:|data:|blob:)/i.test(src)) return null;
  let rel = src.replace(/&amp;/g, '&').split(/[?#]/)[0];
  try { rel = decodeURI(rel); } catch { /* 保持原样 */ }
  if (/^file:\/\//i.test(rel)) { rel = rel.replace(/^file:\/\//i, ''); if (/^\/[A-Za-z]:\//.test(rel)) rel = rel.slice(1); }
  if (rel.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rel)) return rel;
  if (/^[a-z][a-z0-9+.-]*:/i.test(rel) || !noteDir) return null;
  const sep = noteDir.includes('\\') ? '\\' : '/';
  const parts = noteDir.split(/[\\/]/);
  for (const seg of rel.split(/[\\/]/)) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (parts.length > 1) parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join(sep);
}

/** 导出用的单文件 HTML：把本地图片换成后端读出来的 data URL */
async function inlineLocalImages(htmlContent: string, filePath: string): Promise<string> {
  const box = document.createElement('div');
  box.innerHTML = htmlContent;
  const noteDir = filePath.startsWith('new-') ? null : dirOf(filePath);
  for (const img of Array.from(box.querySelectorAll<HTMLImageElement>('img[src]'))) {
    const abs = absolutePathOf(img.getAttribute('src') || '', noteDir);
    if (!abs) continue;
    try {
      const res = await rpc<{ dataUrl?: string }>('fs/readImage', { path: abs });
      if (res?.dataUrl) img.setAttribute('src', res.dataUrl);
    } catch { /* 读不到就保留原地址 */ }
  }
  return box.innerHTML;
}

export function createDbxApi(): WindowApi {
  // DBX 宿主里没有原生菜单/窗口控制，平台固定为 win32（后端也只有 Windows 实现）
  const platform = 'win32';
  const listeners = new Map<string, Set<Listener>>();
  const emitLocal = (channel: string, ...args: any[]) =>
    listeners.get(channel)?.forEach((cb) => { try { cb(...args); } catch (e) { console.error(`[event:${channel}]`, e); } });

  let dataDirPromise: Promise<string> | null = null;
  const dataDir = () => (dataDirPromise ??= rpc<{ dir?: string } | string>('app/dataDir')
    .then((r) => typeof r === 'string' ? r : (r?.dir || ''))
    .catch(() => ''));
  const configPath = async (name: string) => {
    const dir = await dataDir();
    return dir ? `${dir.replace(/[\\/]$/, '')}/${name}` : '';
  };

  const api: WindowApi = {
    appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0',
    // 本地图片不走自定义协议：resolveAssetUrl 会产生 dbx-asset: 前缀，
    // 由渲染层的 hydrateAssets 异步换成后端字节（见 README 的已知限制）
    assetBase: 'dbx-asset:',

    dialog: {
      open: async (options?: any) => {
        const props: string[] = options?.properties || ['openFile', 'multiSelections'];
        try {
          if (props.includes('openDirectory')) {
            const r = await rpc<{ cancelled?: boolean; path?: string }>('fs/pickDir', {});
            return r?.cancelled || !r?.path ? null : [r.path];
          }
          const r = await rpc<{ cancelled?: boolean; path?: string }>('fs/pickFile', {});
          return r?.cancelled || !r?.path ? null : [r.path];
        } catch { return null; }
      },
      save: async (options?: any) => {
        try {
          const defaultPath = String(options?.defaultPath || '');
          // 按扩展名挑过滤器：导出 HTML / PDF / PNG 时对话框类型才不会停在 Markdown
          const ext = (defaultPath.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
          const filterMap: Record<string, string> = {
            html: 'html', htm: 'html',
            pdf: 'pdf', docx: 'docx',
            png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', bmp: 'image',
            md: 'markdown', markdown: 'markdown', txt: 'markdown',
          };
          const filter = filterMap[ext] || 'any';
          // 注意键名必须是 name：后端 pickParams 的 JSON 标签是 name（filter 同理）
          const r = await rpc<{ cancelled?: boolean; path?: string }>('fs/pickSaveFile', { name: defaultPath, filter });
          return r?.cancelled || !r?.path ? null : r.path;
        } catch { return null; }
      },
    },

    fs: {
      readFile: async (filePath) => {
        try { const r = await rpc<{ content: string }>('fs/read', { path: filePath }); return { success: true, content: r.content, filePath }; }
        catch (e) { return { success: false, error: message(e) }; }
      },
      writeFile: async (filePath, content) => {
        try { await rpc('fs/write', { path: filePath, content }); return { success: true, filePath }; }
        catch (e) { return { success: false, error: message(e) }; }
      },
      readDir: async (dirPath) => {
        try { const r = await rpc<{ files: any[] }>('fs/readDir', { path: dirPath }); return { success: true, files: r.files, path: dirPath }; }
        catch (e) { return { success: false, error: message(e) }; }
      },
      saveImage: async (activeFilePath, fileName, buffer) => {
        try {
          const dir = dirOf(activeFilePath);
          const name = assetFileName(fileName);
          const target = `${dir}/${name}`;
          const bytes = new Uint8Array(buffer instanceof ArrayBuffer ? buffer : buffer as ArrayBuffer);
          let binary = '';
          for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          await rpc('fs/writeBytes', { path: target, base64: btoa(binary) });
          return { success: true, path: target, bytes: bytes.length };
        } catch (e) { return { success: false, error: message(e) }; }
      },
      rename: async (oldPath, newPath) => {
        try { await rpc('fs/rename', { path: oldPath, newPath }); return { success: true, oldPath, newPath }; }
        catch (e) { return { success: false, error: message(e) }; }
      },
      copy: async (sourcePath, targetPath) => {
        try { await rpc('fs/copy', { sourcePath, targetPath }); return { success: true }; }
        catch (e) { return { success: false, error: message(e) }; }
      },
      delete: async (path) => {
        try { await rpc('fs/delete', { path }); return { success: true, path }; }
        catch (e) { return { success: false, error: message(e) }; }
      },
      exists: async (path) => {
        try { const r = await rpc<{ exists?: boolean }>('fs/stat', { path }); return !!r?.exists; } catch { return false; }
      },
      mkdir: async (dirPath) => {
        try { await rpc('fs/mkdir', { path: dirPath }); return { success: true, path: dirPath }; }
        catch (e) { return { success: false, error: message(e) }; }
      },
    },

    export: {
      // PDF：先 askPath 问好存哪，再把 HTML 交给后端用 Edge 无头模式渲染成真 PDF。
      // 沙箱 iframe 里 window.print() 是静默 no-op（没有打印权限），不能走打印面板降级
      pdfTo: async (htmlContent, target, filePath) => {
        try {
          const html = await inlineLocalImages(htmlContent, filePath);
          const r = await rpc<{ success: boolean; path?: string }>('export/pdf', { target, html }, 120000);
          return r?.success ? { success: true, path: r.path || target } : { success: false, error: 'PDF 生成失败' };
        } catch (e) { return { success: false, error: message(e) }; }
      },
      // 沙箱里没有系统打印面板，退化成浏览器打印（用户可在面板里选「另存为 PDF」）
      pdf: async (htmlContent, _defaultPath, filePath) => {
        try {
          const html = await inlineLocalImages(htmlContent, filePath);
          const host = document.createElement('div');
          host.id = 'dbx-print-root';
          host.innerHTML = html;
          const style = document.createElement('style');
          style.textContent = '@media screen{#dbx-print-root{display:none}}@media print{body>*:not(#dbx-print-root){display:none!important}#dbx-print-root{display:block}}';
          document.head.appendChild(style);
          document.body.appendChild(host);
          window.print();
          return { success: true, printed: true } as any;
        } catch (e) { return { success: false, error: message(e) }; }
      },
      html: async (htmlContent, defaultPath, filePath) => {
        try {
          const target = await api.dialog.save({ defaultPath: `${defaultPath.replace(DOC_EXT_RE, '')}.html` });
          if (!target) return { success: false, canceled: true };
          const html = await inlineLocalImages(htmlContent, filePath);
          await rpc('fs/write', { path: target, content: exportDocument(html, baseOf(target).replace(/\.html?$/i, '')) });
          return { success: true, path: target };
        } catch (e) { return { success: false, error: message(e) }; }
      },
      saveFile: async (defaultName, bytes, _filterName, extension) => {
        try {
          const ext = String(extension || '').replace(/[^a-z0-9]/gi, '');
          const target = await api.dialog.save({ defaultPath: `${String(defaultName || '未命名').replace(DOC_EXT_RE, '')}.${ext}` });
          if (!target) return { success: false, canceled: true };
          await writeBytes(target, bytes);
          return { success: true, path: target };
        } catch (e) { return { success: false, error: message(e) }; }
      },
      askPath: async (defaultName, _filterName, extension) => {
        const ext = String(extension || '').replace(/[^a-z0-9]/gi, '');
        return api.dialog.save({ defaultPath: `${String(defaultName || '未命名').replace(DOC_EXT_RE, '')}.${ext}` });
      },
      writeFiles: async (target, parts) => {
        try {
          const paths: string[] = [];
          for (let i = 0; i < parts.length; i++) {
            const out = numberedPath(target, i, parts.length);
            await writeBytes(out, parts[i]);
            paths.push(out);
          }
          return { success: true, paths };
        } catch (e) { return { success: false, error: message(e) }; }
      },
      open: async () => false,
      reveal: async () => false,
    },

    shell: {
      openExternal: async (url) => { try { window.open(url, '_blank', 'noopener'); } catch { /* 沙箱可能拦 */ } },
      showItemInFolder: async () => { /* DBX 无对应能力 */ },
    },

    // 文件夹监听改为前端轮询：返回 true 让调用方认为订阅成功
    folder: { watch: async () => true, watchOpenFiles: async () => true },

    // 离线插件不联网；取网页标题/网络图直接放弃，调用方会保留原链接
    web: { fetchTitle: async () => null, fetchImage: async () => null },

    // Chromium 的 canvas 能直接编 WebP，不需要 Rust 兜底
    image: { toWebp: async () => null },

    clipboard: {
      readImage: async () => {
        // DBX 的 iframe 是不透明源，navigator.clipboard.read() 基本拿不到权限；先走后端读系统剪贴板
        try {
          const r = await rpc<{ ok?: boolean; base64?: string }>('clipboard/readImage', {});
          if (r?.ok && r.base64) {
            const bin = atob(r.base64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            return bytes.buffer;
          }
        } catch { /* 宿主没这个方法，退回浏览器 API */ }
        try {
          const items = await navigator.clipboard.read();
          for (const item of items) {
            const type = item.types.find((t) => t.startsWith('image/'));
            if (type) return await (await item.getType(type)).arrayBuffer();
          }
        } catch { /* 权限不足 */ }
        return null;
      },
      writeImage: async (png) => {
        try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]); } catch { /* 忽略 */ }
      },
      writeHtml: async (html, text) => {
        try { await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]); } catch { /* 忽略 */ }
      },
    },

    events: {
      on: (channel, callback) => {
        if (!listeners.has(channel)) listeners.set(channel, new Set());
        listeners.get(channel)!.add(callback);
      },
      send: (channel, ...args) => emitLocal(channel, ...args),
    },

    app: {
      platform,
      // 检查和下载更新属于桌面安装包能力，插件内不提供
      checkUpdates: async () => ({ success: false, error: '插件内不检查更新' }),
      minimize: () => {}, maximize: () => {}, close: () => {},
      getSettings: async () => {
        const p = await configPath('settings.json');
        if (!p) return memSettings;
        try { const r = await rpc<{ content: string }>('fs/read', { path: p }); return JSON.parse(r.content); }
        catch { return {}; }
      },
      saveSettings: async (settings) => {
        try {
          const p = await configPath('settings.json');
          if (p) await rpc('fs/write', { path: p, content: JSON.stringify(settings) });
          else memSettings = settings;
          emitLocal('settings:changed', settings);
          return { success: true };
        } catch (e) { return { success: false, error: message(e) }; }
      },
      // 会话持久化：session.json（后端数据目录）是持久层；localStorage 只做兼容回退——
      // 沙箱 iframe（opaque origin）里它要么抛 SecurityError，要么每次都是空的独立存储，不可靠
      getSession: async () => {
        const p = await configPath('session.json');
        if (p) {
          try { const r = await rpc<{ content: string }>('fs/read', { path: p }); if (r.content) return r.content; } catch { /* 没有就往下找 */ }
        }
        try { return localStorage.getItem('iml_session'); } catch { /* 沙箱 */ }
        return null;
      },
      setSession: async (data) => {
        const p = await configPath('session.json');
        if (p) { try { await rpc('fs/write', { path: p, content: data }); } catch { /* 写不进就算了 */ } }
        try { localStorage.setItem('iml_session', data); } catch { /* 沙箱 */ }
      },
      clearSession: async () => {
        try { localStorage.removeItem('iml_session'); } catch { /* 沙箱 */ }
        const p = await configPath('session.json');
        if (p) { try { await rpc('fs/delete', { path: p }); } catch { /* 忽略 */ } }
        emitLocal('session:clear');
      },
      openSettings: () => emitLocal('dialog:open', 'settings'),
      consumePendingOpenFiles: async () => [],
      droppedPaths: async () => [],
      previewSettings: (settings) => emitLocal('settings:preview', settings),
      revertSettings: () => emitLocal('settings:revert'),
    },
  };
  return api;
}

async function writeBytes(path: string, bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  await rpc('fs/writeBytes', { path, base64: btoa(binary) });
}

/**
 * 图片显示兜底：DBX 沙箱的 img-src 会拦掉自定义协议（宿主环境里 data: 也可能被拦）。
 * - 本地图片：img[src^="dbx-asset:"] → 后端 fs/readImage 返回 RGBA 像素 → canvas
 * - 内联图片：正文里的 data:image/* → 直接解 base64 交给 createImageBitmap → canvas
 * 用 MutationObserver 覆盖富文本编辑时不断新建的 img 节点。
 */
export function hydrateDbxAssets() {
  const seen = new WeakSet<HTMLImageElement>();
  const replaceWithCanvas = (img: HTMLImageElement, width: number, height: number, paint: (ctx: CanvasRenderingContext2D) => void, tag: string) => {
    if (!img.isConnected) return;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.className = img.className;
    canvas.style.cssText = img.style.cssText;
    canvas.setAttribute('data-dbx-asset', tag);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    paint(ctx);
    img.replaceWith(canvas);
  };

  const paintInline = async (img: HTMLImageElement) => {
    const src = img.getAttribute('src') || '';
    // 我们写进文档的都是 base64 data URL；非 base64 的留给浏览器自己处理
    const m = /^data:image\/([a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(src);
    if (!m) return;
    try {
      const bin = atob(m[2]);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const bitmap = await createImageBitmap(new Blob([bytes], { type: `image/${m[1]}` }));
      if (!img.isConnected) { bitmap.close?.(); return; }
      replaceWithCanvas(img, bitmap.width, bitmap.height, (ctx) => ctx.drawImage(bitmap, 0, 0), 'inline');
      bitmap.close?.();
    } catch { /* 解不出来就留着原 img，不阻断编辑 */ }
  };

  const scan = () => {
    document.querySelectorAll<HTMLImageElement>('.note-image img[src^="data:image/"], img[src^="dbx-asset:"]').forEach((img) => {
      if (seen.has(img)) return;
      seen.add(img);
      const src = img.getAttribute('src') || '';
      if (src.startsWith('data:image/')) { void paintInline(img); return; }
      let abs = '';
      try { abs = decodeURIComponent(src.slice('dbx-asset:'.length)); } catch { return; }
      void (async () => {
        try {
          const r = await rpc<{ dataUrl?: string; rgbaBase64?: string; width?: number; height?: number }>('fs/readImage', { path: abs });
          if (!r) return;
          const rgba = r.rgbaBase64, w = r.width, h = r.height;
          if (rgba && w && h) {
            const bin = atob(rgba);
            const pixels = new Uint8ClampedArray(bin.length);
            for (let i = 0; i < bin.length; i++) pixels[i] = bin.charCodeAt(i);
            replaceWithCanvas(img, w, h, (ctx) => ctx.putImageData(new ImageData(pixels, w, h), 0, 0), abs);
          } else if (r.dataUrl && img.isConnected) {
            img.src = r.dataUrl;
          }
        } catch { /* 读不到就留空，不阻断编辑 */ }
      })();
    });
  };
  scan();
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
}
