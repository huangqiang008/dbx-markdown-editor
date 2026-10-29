import EventEmitter from 'events';

type Listener<T> = (arg: T) => void;
const transport = new EventEmitter();

const stringResources: Record<string, string> = {
  FootnoteNotFound: '未找到脚注“{identifier}”',
  InputFootnoteDefine: '请输入脚注内容',
  InputYAMLFrontMatter: 'YAML 元数据',
  InputMathFormula: '数学公式',
  InputLanguageIdentifier: '语言',
  ClickToAddAnImage: '点击添加图片',
  LoadImageFail: '图片加载失败',
  Footnote: '脚注',
  Create: '创建',
  GoTo: '跳转',
  ResizeTable: '调整表格大小',
  AlignLeft: '左对齐',
  AlignCenter: '居中对齐',
  AlignRight: '右对齐',
  DeleteTable: '删除表格',
  CtrlAndClickOpenLink: '按住 Ctrl 并单击打开链接',
};

const getStringResources = (names: string[]) => names.reduce<Record<string, string>>((resources, name) => {
  const value = stringResources[name] ?? name;
  resources[name] = value;
  resources[name.charAt(0).toLowerCase() + name.slice(1)] = value;
  return resources;
}, {});

const basePathOf = (filePath: string) => {
  const lastSep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return lastSep > 0 ? filePath.slice(0, lastSep) : '';
};

const localPathFromFileUrl = (value: string) => {
  if (!/^file:\/\//i.test(value)) return value;
  let path = decodeURIComponent(value.replace(/^file:\/\//i, ''));
  if (/^\/[a-zA-Z]:[\\/]/.test(path)) path = path.slice(1);
  else if (/^\/\//.test(path)) path = `\\\\${path.slice(2)}`;
  return path.replace(/\//g, '\\');
};

const normalizeLocalPath = (value: string) => {
  let path = value.trim();
  try { path = decodeURIComponent(path); } catch { /* literal '%' is valid in a Windows path */ }
  // Recover from paths produced by older bundles, which resolved an absolute
  // Windows path under basePath and left a second drive prefix in the result.
  path = path.replace(/^.*[\\/](?=[a-zA-Z]:)/, '');
  if (/^[a-zA-Z]:/.test(path)) {
    path = path.replace(/\//g, '\\');
    if (path.length === 2 || !/[\\/]/.test(path[2])) path = path.slice(0, 2) + '\\' + path.slice(2);
  }
  return path;
};

const isAbsoluteLocalPath = (value: string) => /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(value);

export const invoke = <TResult>(method: string, args?: unknown, timeoutMs?: number) => {
  if (!window.dbxPlugin?.invoke) {
    return Promise.reject(new Error('DBX plugin bridge is unavailable'));
  }
  return window.dbxPlugin.invoke(method, args ?? {}, { timeoutMs: timeoutMs ?? 30000 }) as Promise<TResult>;
};

export const emit = <T>(eventName: string, arg: T) => transport.emit(eventName, arg);

const remoteFunction = <T, TResult>(name: string) => (args?: T): Promise<TResult> => {
  switch (name) {
    case 'GetCurrentTheme':
      return Promise.resolve({ theme: 'light', accentColor: { r: 50, g: 110, b: 190, a: 1 }, background: { R: 255, G: 255, B: 255, A: 1 } } as unknown as TResult);
    case 'ContentLoaded':
    case 'ResizeTable':
      return Promise.resolve((args ?? true) as unknown as TResult);
    case 'GetSettings':
      return (async () => {
        await window.dbxPlugin?.ready;
        const recent = await window.dbxPlugin?.storage?.get('recent');
        const prefs = await window.dbxPlugin?.storage?.get('prefs');
        const path = Array.isArray(recent) ? recent.find((item: any) => item?.path)?.path : undefined;
        const options = { ...defaultOptions, autosave: !!prefs?.autosave, typewriter: !!prefs?.typewriter };
        if (path) {
          try {
            const file = await invoke<{ content: string }>('fs/read', { path });
            window.basePath = basePathOf(path);
            return { ...options, markdown: file.content, basePath: window.basePath, path } as unknown as TResult;
          } catch { /* The most recent file may have been removed. */ }
        }
        return { ...options, markdown: '# 欢迎使用 Markdown 编辑器\n\n开始编写 Markdown 文档。', basePath: '', path: '' } as unknown as TResult;
      })();
    case 'GetStringResources':
      return Promise.resolve(getStringResources((args as any)?.names ?? []) as unknown as TResult);
    case 'SetClipboard':
      return (async () => {
        const value: any = args;
        await navigator.clipboard?.writeText(String(value?.data ?? ''));
        return true as unknown as TResult;
      })();
    case 'LoadImage':
      return (async () => {
        let url = (args as any)?.url as string;
        url = normalizeLocalPath(localPathFromFileUrl(url || ''));
        // 兜底：若 Muya 传入的是相对路径且前端未预解析，则用文档基准目录拼接为绝对路径。
        if (url && !isAbsoluteLocalPath(url) && !/^(?:https?:|data:|blob:)/i.test(url) && window.basePath) {
          url = window.basePath.replace(/[\\/]$/, '') + '/' + url;
        }
        const image = await invoke<{
          dataUrl: string;
          width?: number;
          height?: number;
          rgbaBase64?: string;
          svgText?: string;
          decodeError?: string;
        }>('fs/readImage', { path: url });
        return {
          url: image.dataUrl,
          width: image.width,
          height: image.height,
          rgbaBase64: image.rgbaBase64,
          svgText: image.svgText,
          decodeError: image.decodeError,
        } as unknown as TResult;
      })();
    case 'ExportCallback':
      return (async () => {
        const result = await invoke<{ cancelled: boolean; path?: string }>('fs/pickSaveFile', { name: 'export.html', filter: 'html' });
        if (result.cancelled || !result.path) return false as unknown as TResult;
        await invoke('fs/write', { path: result.path, content: (args as any)?.html ?? '' });
        return true as unknown as TResult;
      })();
    case 'PrintHTML':
      return Promise.resolve(false as unknown as TResult);
    default:
      return Promise.reject(new Error(`Unsupported Typedown host operation: ${name}`));
  }
};

const defaultOptions = {
  sourceCode: false,
  fontSize: '16px',
  lineHeight: '1.8',
  editorAreaWidth: '860px',
  focusMode: false,
  typewriter: false,
  autosave: false,
  searchIsCaseSensitive: false,
  searchIsWholeWord: false,
  searchIsRegexp: false,
};

const transportApi = {
  addListener: <T>(eventName: string, listener: Listener<T>) => {
    transport.addListener(eventName, listener);
    return () => { transport.removeListener(eventName, listener); };
  },
  removeListener: <T>(eventName: string, listener: Listener<T>) => transport.removeListener(eventName, listener),
  removeAllListener: (eventName: string) => transport.removeAllListeners(eventName),
  postMessageNoDiff: (name: string, args: unknown) => emit(name, args),
  postMessage: (name: string, args: unknown) => emit(name, args),
};

export default transportApi;
export { remoteFunction };
