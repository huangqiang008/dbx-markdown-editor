import CodeMirror from "components/CodeMirror";
import MuyaEditor from "components/Muya";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { remote } from "services/remote";
import transport from "services/transport";
import ImageEditLayer from "components/ImageEditLayer";
import './index.scss'
import ExportHtml from "services/exportHtml";
import { htmlToMarkdown } from "services/importHtml";
import { DEFAULT_TURNDOWN_CONFIG } from "components/Muya/lib/config";
import { getHtmlToc, getTOC } from "services/common";
import { invoke } from "services/transport";

interface FileEntry {
    path: string;
    name: string;
    isDir: boolean;
}

type PickerMode = 'open' | 'save' | 'folder' | 'export';

interface OutlineEntry {
    content: string;
    lvl: number;
    slug: string;
}

const paragraphCommands: Array<[string, string]> = [
    ['正文', 'paragraph'],
    ['标题 1', 'heading 1'], ['标题 2', 'heading 2'], ['标题 3', 'heading 3'],
    ['标题 4', 'heading 4'], ['标题 5', 'heading 5'], ['标题 6', 'heading 6'],
    ['提升标题级别', 'upgrade heading'], ['降低标题级别', 'degrade heading'],
    ['表格', 'table'], ['代码块', 'pre'], ['公式块', 'mathblock'], ['引用', 'blockquote'],
    ['有序列表', 'ol-order'], ['无序列表', 'ul-bullet'], ['任务列表', 'ul-task'],
    ['脚注', 'footnote'], ['分割线', 'hr'], ['YAML 元数据', 'front-matter'],
    ['HTML 块', 'html'], ['Mermaid 图表', 'mermaid'], ['流程图', 'flowchart'],
    ['时序图', 'sequence'], ['PlantUML 图表', 'plantuml'], ['Vega 图表', 'vega-lite'],
];

const formatCommands: Array<[string, string]> = [
    ['加粗', 'strong'], ['斜体', 'em'], ['下划线', 'u'], ['删除线', 'del'],
    ['行内代码', 'inline_code'], ['行内公式', 'inline_math'], ['高亮', 'mark'],
    ['超链接', 'link'], ['图片', 'image'], ['清除格式', 'clear'],
];

const Editor: React.FC = () => {
    const [markdown, setMarkdown] = useState<string>();
    const [activePath, setActivePath] = useState('');
    const [notice, setNotice] = useState('');
    const [sidebarOpen, setSidebarOpen] = useState(true);
    const [sidebarTab, setSidebarTab] = useState<'files' | 'outline'>('files');
    const [folderPath, setFolderPath] = useState('');
    const [fileEntries, setFileEntries] = useState<FileEntry[]>([]);
    const [outline, setOutline] = useState<OutlineEntry[]>([]);
    const [currentHeading, setCurrentHeading] = useState<string>();
    const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
    const [pickerMode, setPickerMode] = useState<PickerMode | null>(null);
    const [pickerPath, setPickerPath] = useState('');
    const [pickerEntries, setPickerEntries] = useState<FileEntry[]>([]);
    const [pickerChildren, setPickerChildren] = useState<Record<string, FileEntry[]>>({});
    const [pickerExpanded, setPickerExpanded] = useState<Set<string>>(new Set());
    const [pickerDrives, setPickerDrives] = useState(false);
    const [pickerSelection, setPickerSelection] = useState<FileEntry | null>(null);
    const [pickerName, setPickerName] = useState('untitled.md');
    const [pickerError, setPickerError] = useState('');
    const [pickerBusy, setPickerBusy] = useState(false);
    const [pickerJump, setPickerJump] = useState('');
    const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
    const toastTimerRef = useRef(0);
    const markdownRef = useRef<string>();
    const savedMarkdownRef = useRef<string>();
    const [cursor, setCursor] = useState<any>();
    const [options, setOptions] = useState<any>();
    const optionsRef = useRef<any>();
    const [searchOpen, setSearchOpen] = useState(0);
    const [searchArg, setSearchArg] = useState<{ value: string, opt: any }>();
    const [openMenu, setOpenMenu] = useState<string | null>(null);
    const menuBarRef = useRef<HTMLElement>(null);
    const muyaScrollTopRef = useRef(0);
    const codeMirrorScrollRef = useRef(0);

    const showToast = useCallback((text: string, kind: 'ok' | 'err' = 'ok') => {
        setToast({ text, kind });
        window.clearTimeout(toastTimerRef.current);
        toastTimerRef.current = window.setTimeout(() => setToast(null), kind === 'ok' ? 4000 : 6000);
    }, []);

    const loadPickerPath = useCallback(async (path: string) => {
        setPickerError('');
        try {
            const result = await invoke<{ drives: boolean; path: string; entries: FileEntry[] }>('fs/browse', { dir: path });
            setPickerPath(result.path || '');
            setPickerEntries(result.entries || []);
            setPickerChildren({});
            setPickerExpanded(path ? new Set([path]) : new Set());
            setPickerDrives(!!result.drives);
            setPickerSelection(null);
            if (result.drives && !(result.entries || []).length) {
                setPickerError('未能枚举到磁盘，可直接在下方输入完整路径。');
            }
        } catch (error) {
            setPickerEntries([]);
            setPickerDrives(false);
            const message = error instanceof Error ? error.message : '无法读取目录';
            setPickerError(`${message}；可直接在下方输入完整路径。`);
        }
    }, []);

    const openPicker = useCallback((mode: PickerMode, path = '', name = 'untitled.md') => {
        setPickerMode(mode);
        setPickerName(name);
        setPickerError('');
        setPickerBusy(false);
        setPickerJump(path || '');
        void loadPickerPath(path);
    }, [loadPickerPath]);

    const closePicker = useCallback(() => {
        setPickerMode(null);
        setPickerSelection(null);
    }, []);

    const togglePickerDirectory = useCallback(async (entry: FileEntry) => {
        if (!entry.isDir) return;
        if (pickerExpanded.has(entry.path)) {
            setPickerExpanded(current => {
                const next = new Set(current);
                next.delete(entry.path);
                return next;
            });
            return;
        }
        let children = pickerChildren[entry.path];
        if (!children) {
            try {
                const result = await invoke<{ entries: FileEntry[] }>('fs/browse', { dir: entry.path });
                children = result.entries || [];
                setPickerChildren(current => ({ ...current, [entry.path]: result.entries || [] }));
            } catch (error) {
                setPickerError(error instanceof Error ? error.message : '无法读取目录');
                return;
            }
        }
        setPickerExpanded(current => new Set(current).add(entry.path));
    }, [pickerChildren, pickerExpanded]);

    const showFiles = pickerMode === 'open';
    const renderPickerTree = (entries: FileEntry[], depth = 0): React.ReactNode => entries
        .filter(entry => showFiles || entry.isDir)
        .map(entry => {
            const expanded = pickerExpanded.has(entry.path);
            const selected = pickerSelection?.path === entry.path;
            const children = pickerChildren[entry.path] || [];
            const navigateInto = entry.isDir && pickerMode !== 'open' && pickerMode !== 'folder';
            return <React.Fragment key={entry.path}>
                <div className={`picker-tree-row${selected ? ' selected' : ''}`} role="option" aria-selected={selected} style={{ paddingLeft: 8 + depth * 18 }}>
                    {entry.isDir
                        ? <button type="button" className="picker-tree-toggle" aria-label={expanded ? '折叠文件夹' : '展开文件夹'} onClick={() => void togglePickerDirectory(entry)}>{expanded ? '▾' : '▸'}</button>
                        : <span className="picker-tree-spacer" />}
                    <button type="button" className="picker-tree-label" onClick={() => {
                        setPickerSelection(entry);
                        if (pickerMode === 'save' && !entry.isDir) setPickerName(entry.name);
                        if (navigateInto) void loadPickerPath(entry.path);
                        else if (entry.isDir && !pickerExpanded.has(entry.path)) void togglePickerDirectory(entry);
                    }} onDoubleClick={() => {
                        if (entry.isDir) void togglePickerDirectory(entry);
                        else if (pickerMode === 'open') {
                            closePicker();
                            void openPath(entry.path);
                        }
                    }}>
                        <span className={entry.isDir ? 'picker-folder-icon' : 'picker-file-icon'} aria-hidden="true">{entry.isDir ? '▰' : '·'}</span>
                        <span className="picker-tree-name">{entry.name}</span>
                    </button>
                </div>
                {expanded && children.length > 0 && renderPickerTree(children, depth + 1)}
                {expanded && children.length === 0 && <div className="picker-tree-empty" style={{ paddingLeft: 34 + depth * 18 }}>空文件夹</div>}
            </React.Fragment>;
        });

    const OnFileLoaded = useCallback(() => setTimeout(() => transport.postMessage('FileLoaded', { text: markdownRef.current }), 100), [])

    useEffect(() => {
        remote.getSettings().then(({ markdown, basePath, path, ...opt }: any) => {
            window.basePath = basePath
            setActivePath(path || basePath || '');
            setOptions(opt)
            setMarkdown(markdown)
            markdownRef.current = markdown
            savedMarkdownRef.current = markdown
            OnFileLoaded();
        })
    }, [OnFileLoaded]);

    useEffect(() => {
        window.dbxPlugin?.storage?.get('prefs').then((prefs: any) => {
            if (prefs?.sidebar === false) setSidebarOpen(false);
            if (prefs?.autosave !== undefined) setOptions((old: any) => old && ({ ...old, autosave: !!prefs.autosave }));
            if (prefs?.typewriter !== undefined) setOptions((old: any) => old && ({ ...old, typewriter: !!prefs.typewriter }));
        }).catch(() => undefined);
    }, []);

    useEffect(() => transport.addListener<{ state: { toc?: OutlineEntry[]; cur?: OutlineEntry } }>('StateChange', ({ state }) => {
        setOutline(state.toc ?? []);
        setCurrentHeading(state.cur?.slug);
    }), []);

    useEffect(() => {
        optionsRef.current = options
    }, [options])

    useEffect(() => {
        if (markdown != undefined && markdownRef.current != markdown) {
            transport.postMessage('MarkdownChange', { text: markdown });
            markdownRef.current = markdown
        }
    }, [markdown])

    useEffect(() => {
        transport.postMessage('CursorChange', { cursor })
    }, [cursor])

    useEffect(() => {
        if (!openMenu) return;
        const closeOnOutsideClick = (event: MouseEvent) => {
            if (!menuBarRef.current?.contains(event.target as Node)) setOpenMenu(null);
        };
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setOpenMenu(null);
        };
        document.addEventListener('mousedown', closeOnOutsideClick);
        document.addEventListener('keydown', closeOnEscape);
        return () => {
            document.removeEventListener('mousedown', closeOnOutsideClick);
            document.removeEventListener('keydown', closeOnEscape);
        };
    }, [openMenu]);

    useEffect(() => transport.addListener<IExportArgs>('Export', async ({ type, context, basePath, title, options }) => {
        const generateOption = { printOptimization: false, title, toc: getHtmlToc(getTOC(markdownRef.current ?? '').toc), ...options }
        const baseUrl = basePath ? `file:///${basePath.replaceAll('\\', '/')}/` : undefined
        const html = await new ExportHtml(markdownRef.current, { ...optionsRef.current, baseUrl }).generate(generateOption)
        if (type == 'print') {
            remote.printHTML({ html, context })
        } else {
            remote.exportCallback({ html, context })
        }
    }), []);

    const openPath = useCallback(async (path: string) => {
        try {
            if (markdownRef.current !== savedMarkdownRef.current && !window.confirm('未保存的更改将丢失。仍要打开其他文件吗？')) return;
            const file = await invoke<{ content: string }>('fs/read', { path });
            setActivePath(path);
            window.basePath = path.replace(/[\\/][^\\/]*$/, '');
            markdownRef.current = file.content;
            savedMarkdownRef.current = file.content;
            setMarkdown(file.content);
            setNotice('');
        } catch (error) {
            setNotice(error instanceof Error ? error.message : '无法打开文件');
        }
    }, []);

    const newFile = useCallback(() => {
        if (markdownRef.current !== savedMarkdownRef.current && !window.confirm('未保存的更改将丢失。仍要新建文档吗？')) return;
        setActivePath('');
        window.basePath = '';
        markdownRef.current = '';
        savedMarkdownRef.current = '';
        setMarkdown('');
        setCursor(undefined);
        setNotice('');
    }, []);

    const openFile = useCallback(async () => {
        openPicker('open', folderPath || activePath.replace(/[\\/][^\\/]*$/, ''));
    }, [activePath, folderPath, openPicker]);

    const openFolder = useCallback(async (path?: string) => {
        try {
            const selectedPath = path;
            if (!selectedPath) {
                openPicker('folder');
                return;
            }
            const result = await invoke<{ root: string; entries: FileEntry[] }>('fs/list', { dir: selectedPath });
            setFolderPath(result.root);
            setFileEntries(result.entries ?? []);
            setCollapsedFolders(new Set());
            await window.dbxPlugin?.storage?.set('folder', result.root);
            setNotice('');
        } catch (error) {
            setNotice(error instanceof Error ? error.message : '无法读取文件夹');
        }
    }, [openPicker]);

    useEffect(() => {
        window.dbxPlugin?.storage?.get('folder').then((path: string | null) => {
            if (path) return openFolder(path);
            return undefined;
        }).catch(() => undefined);
    }, [openFolder]);

    const saveFile = useCallback(async (silent = false) => {
        try {
            const path = activePath;
            if (!path) {
                openPicker('save', folderPath, 'untitled.md');
                return;
            }
            await invoke('fs/write', { path, content: markdownRef.current ?? '' });
            window.basePath = path.replace(/[\\/][^\\/]*$/, '');
            savedMarkdownRef.current = markdownRef.current ?? '';
            if (!silent) showToast(`已保存：${path}`, 'ok');
        } catch (error) {
            showToast(`保存失败：${error instanceof Error ? error.message : '无法保存文件'}`, 'err');
        }
    }, [activePath, folderPath, openPicker, showToast]);

    const saveToPath = useCallback(async (path: string) => {
        try {
            setActivePath(path);
            await invoke('fs/write', { path, content: markdownRef.current ?? '' });
            window.basePath = path.replace(/[\\/][^\\/]*$/, '');
            savedMarkdownRef.current = markdownRef.current ?? '';
            closePicker();
            showToast(`已保存：${path}`, 'ok');
        } catch (error) {
            const message = error instanceof Error ? error.message : '无法保存文件';
            setPickerError(message);
            showToast(`保存失败：${message}`, 'err');
        }
    }, [closePicker, showToast]);

    const exportToPath = useCallback(async (path: string) => {
        setPickerBusy(true);
        setPickerError('');
        try {
            const basePath = activePath ? activePath.replace(/[\\/][^\\/]*$/, '') : '';
            const baseUrl = basePath ? `file:///${basePath.replaceAll('\\', '/')}/` : undefined;
            const html = await new ExportHtml(markdownRef.current, { ...optionsRef.current, baseUrl }).generate({ printOptimization: false, title: activePath.split(/[\\/]/).pop() || 'Markdown' });
            await invoke('fs/write', { path, content: html });
            closePicker();
            showToast(`HTML 已导出：${path}`, 'ok');
        } catch (error) {
            const message = error instanceof Error ? error.message : '无法导出 HTML';
            setPickerError(message);
            showToast(`导出失败：${message}`, 'err');
        } finally {
            setPickerBusy(false);
        }
    }, [activePath, closePicker, showToast]);

    const confirmPicker = useCallback(async () => {
        if (!pickerMode || pickerBusy) return;
        if (pickerMode === 'folder') {
            const path = pickerSelection?.isDir ? pickerSelection.path : pickerPath;
            if (!path) return;
            closePicker();
            void openFolder(path);
            return;
        }
        if (pickerMode === 'open') {
            if (!pickerSelection || pickerSelection.isDir) return;
            const path = pickerSelection.path;
            closePicker();
            void openPath(path);
            return;
        }
        const name = pickerName.trim();
        if (!pickerPath || !name) return;
        const normalizedName = pickerMode === 'export'
            ? (/\.html?$/i.test(name) ? name : `${name}.html`)
            : (/\.(md|markdown|txt)$/i.test(name) ? name : `${name}.md`);
        const targetDir = pickerSelection?.isDir ? pickerSelection.path : pickerPath;
        if (!targetDir) return;
        const path = `${targetDir.replace(/[\\/]+$/, '')}\\${normalizedName}`;
        try {
            const stat = await invoke<{ exists: boolean; isDir: boolean }>('fs/stat', { path });
            if (stat.isDir) {
                setPickerError('目标路径是文件夹，请更换文件名。');
                return;
            }
            if (stat.exists && !window.confirm(`${normalizedName} 已存在，是否覆盖？`)) return;
        } catch (error) {
            setPickerError(error instanceof Error ? error.message : '无法检查目标文件');
            return;
        }
        if (pickerMode === 'export') void exportToPath(path);
        else void saveToPath(path);
    }, [closePicker, exportToPath, openFolder, openPath, pickerBusy, pickerMode, pickerName, pickerPath, pickerSelection, saveToPath]);

    const pickerParent = useCallback(() => {
        if (!pickerPath) return;
        const normalized = pickerPath.replace(/\//g, '\\').replace(/\\+$/, '');
        if (/^[A-Za-z]:$/.test(normalized)) {
            void loadPickerPath('');
            return;
        }
        const index = normalized.lastIndexOf('\\');
        void loadPickerPath(index <= 2 ? `${normalized.slice(0, 2)}\\` : normalized.slice(0, index));
    }, [loadPickerPath, pickerPath]);

    const jumpToTypedPath = useCallback((value: string) => {
        const target = value.trim().replace(/^"|"$/g, '');
        if (!target) return;
        void loadPickerPath(target);
    }, [loadPickerPath]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && pickerMode) {
                event.preventDefault();
                closePicker();
                return;
            }
            if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
            const key = event.key.toLowerCase();
            if (key === 's') {
                event.preventDefault();
                void saveFile();
            } else if (key === 'n') {
                event.preventDefault();
                newFile();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [closePicker, newFile, pickerMode, saveFile]);

    useEffect(() => {
        if (!options?.autosave || !activePath || markdown === savedMarkdownRef.current) return;
        const timer = window.setTimeout(() => { void saveFile(true); }, 2000);
        return () => window.clearTimeout(timer);
    }, [activePath, markdown, options?.autosave, saveFile]);

    const persistPreferences = useCallback((next: { autosave?: boolean; typewriter?: boolean; sidebar?: boolean }) => {
        void window.dbxPlugin?.storage?.get('prefs').then((prefs: any) => window.dbxPlugin?.storage?.set('prefs', { ...prefs, ...next }));
    }, []);

    const toggleOption = useCallback((name: 'autosave' | 'typewriter') => {
        setOptions((old: any) => {
            const next = { ...old, [name]: !old[name] };
            persistPreferences({ [name]: next[name] });
            return next;
        });
    }, [persistPreferences]);

    const toggleSidebar = useCallback(() => {
        setSidebarOpen(value => {
            persistPreferences({ sidebar: !value });
            return !value;
        });
    }, [persistPreferences]);

    const visibleFiles = fileEntries.filter(entry => {
        const separator = entry.path.includes('\\') ? '\\' : '/';
        const parentPath = entry.path.slice(0, entry.path.lastIndexOf(separator));
        return !Array.from(collapsedFolders).some(folder => parentPath === folder || parentPath.startsWith(`${folder}\\`) || parentPath.startsWith(`${folder}/`));
    });

    const toggleFolder = useCallback((path: string) => {
        setCollapsedFolders(current => {
            const next = new Set(current);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    }, []);

    const menuItem = (label: string, onClick: () => void, key?: string) => (
        <button type="button" role="menuitem" key={key || label} onMouseDown={event => event.preventDefault()} onClick={() => { onClick(); setOpenMenu(null); }}>{label}</button>
    );
    const menuTrigger = (id: string, label: string) => (
        <button type="button" className="menu-trigger" aria-haspopup="menu" aria-expanded={openMenu === id}
            onClick={() => setOpenMenu(openMenu === id ? null : id)}>{label}</button>
    );

    const changeFolder = useCallback((entry: FileEntry) => {
        if (entry.isDir) toggleFolder(entry.path);
        else void openPath(entry.path);
    }, [openPath, toggleFolder]);

    const exportHtml = useCallback(async () => {
        openPicker('export', folderPath, 'export.html');
    }, [folderPath, openPicker]);

    useEffect(() => transport.addListener<{ type: string, text: string }>('ImportFile', ({ text }) => {
        setMarkdown(htmlToMarkdown(text, [], DEFAULT_TURNDOWN_CONFIG))
    }), [options]);

    useEffect(() => transport.addListener<{ text: string, basePath: string }>('LoadFile', ({ text, basePath }) => {
        window.basePath = basePath
        setCursor(undefined)
        setMarkdown(text)
        markdownRef.current = text
        OnFileLoaded();
    }), [OnFileLoaded]);

    useEffect(() => transport.addListener<{ text: string, cursor: string, basePath: string }>('SetMarkdown', ({ text, cursor, basePath }) => {
        window.basePath = basePath
        setCursor(cursor)
        setTimeout(() => setMarkdown(text))
        markdownRef.current = text
    }), []);

    useEffect(() => transport.addListener<Record<string, unknown>>('SettingsChanged', (newOptions) => {
        for (const name in newOptions) {
            const value = newOptions[name];
            if (name.startsWith('search'))
                setSearchArg(old => old ? { ...old, opt: { ...old.opt, [name]: value } } : old)
        }
        setOptions((oldOptions: any) => ({ ...oldOptions, ...newOptions }))
    }), []);

    useEffect(() => transport.addListener<{ open: number }>('SearchOpenChange', ({ open }) => {
        setSearchOpen(open)
    }), []);

    if (!options) {
        return <div className="typedown-loading">正在加载编辑器...</div>
    }

    const editorSurface = options.sourceCode ? (
        <CodeMirror options={options} cursor={cursor} markdown={markdown ?? ''} searchOpen={searchOpen}
            searchArg={searchArg} scrollTopRef={codeMirrorScrollRef} onMarkdownChange={setMarkdown}
            onCursorChange={setCursor} onSearchArgChange={setSearchArg} />
    ) : (
        <MuyaEditor options={options} cursor={cursor} markdown={markdown ?? ''} searchOpen={searchOpen}
            searchArg={searchArg} scrollTopRef={muyaScrollTopRef} onMarkdownChange={setMarkdown}
            onCursorChange={setCursor} onSearchArgChange={setSearchArg} />
    );

    return (
        <div className="typedown-shell">
            <header className="typedown-bar">
                <button type="button" className="icon-action" aria-label="切换侧边栏" title="切换侧边栏" aria-pressed={sidebarOpen} onClick={toggleSidebar}>☰</button>
                <div className="typedown-document" title={activePath}>{activePath.split(/[\\/]/).pop() || '未命名.md'}{markdown !== savedMarkdownRef.current && <span className="dirty-indicator" title="有未保存的更改" />}</div>
                <span className="typedown-notice" role="status">{notice}</span>
                <button type="button" className="bar-action" onClick={newFile} title="新建 Markdown 文档 (Ctrl+N)">新建 MD</button>
                <button type="button" className="bar-action primary" onClick={() => void saveFile()} title="保存 (Ctrl+S)">保存</button>
            </header>
            <nav className="typedown-menu-bar" aria-label="编辑器菜单" ref={menuBarRef}>
                <div className="menu-group">
                    {menuTrigger('file', '文件')}
                    {openMenu === 'file' && <div className="menu-dropdown" role="menu">
                        {menuItem('新建 Markdown', newFile)}
                        {menuItem('打开…', () => void openFile())}
                        {menuItem('保存', () => void saveFile())}
                        {menuItem('导出 HTML…', () => void exportHtml())}
                    </div>}
                </div>
                <div className="menu-group">
                    {menuTrigger('paragraph', '段落')}
                    {openMenu === 'paragraph' && <div className="menu-dropdown menu-dropdown-wide" role="menu">
                        {paragraphCommands.map(([label, command]) => menuItem(label, () => transport.postMessage('UpdateParagraph', command), command))}
                        <div className="menu-separator" />
                        {menuItem('在上方插入段落', () => transport.postMessage('InsertParagraph', 'before'))}
                        {menuItem('在下方插入段落', () => transport.postMessage('InsertParagraph', 'after'))}
                    </div>}
                </div>
                <div className="menu-group">
                    {menuTrigger('format', '格式')}
                    {openMenu === 'format' && <div className="menu-dropdown" role="menu">
                        {formatCommands.map(([label, command]) => menuItem(label, () => transport.postMessage('Format', command), command))}
                    </div>}
                </div>
                <div className="menu-group">
                    {menuTrigger('view', '视图')}
                    {openMenu === 'view' && <div className="menu-dropdown" role="menu">
                        {menuItem(options.sourceCode ? '切换到所见即所得' : '切换到源码', () => setOptions((old: any) => ({ ...old, sourceCode: !old.sourceCode })))}
                        {menuItem(sidebarOpen ? '隐藏侧边栏' : '显示侧边栏', toggleSidebar)}
                        {menuItem(options.typewriter ? '关闭打字机模式' : '打字机模式', () => toggleOption('typewriter'))}
                        {menuItem(options.autosave ? '关闭自动保存' : '开启自动保存', () => toggleOption('autosave'))}
                        {menuItem('显示大纲', () => { setSidebarOpen(true); setSidebarTab('outline'); })}
                    </div>}
                </div>
            </nav>
            <div className="typedown-workspace">
                {sidebarOpen && <aside className="typedown-sidebar">
                    <div className="sidebar-tabs" role="tablist" aria-label="文档导航">
                        <button type="button" role="tab" aria-selected={sidebarTab === 'files'} onClick={() => setSidebarTab('files')}>文件</button>
                        <button type="button" role="tab" aria-selected={sidebarTab === 'outline'} onClick={() => setSidebarTab('outline')}>大纲</button>
                    </div>
                    {sidebarTab === 'files' ? <div className="sidebar-content">
                        <div className="folder-heading"><span title={folderPath}>{folderPath ? folderPath.split(/[\\/]/).pop() : '文件'}</span><button type="button" onClick={() => void openFolder()}>打开文件夹</button></div>
                        {folderPath ? <div className="file-tree" role="list">
                            {visibleFiles.map(entry => {
                                const relativePath = entry.path.slice(folderPath.length).replace(/^[\\/]/, '');
                                const depth = relativePath.split(/[\\/]/).length - 1;
                                return <button type="button" role="listitem" key={entry.path}
                                    className={`file-row${activePath === entry.path ? ' active' : ''}${entry.isDir ? ' directory' : ''}`}
                                    style={{ paddingLeft: 9 + depth * 14 }} title={entry.path} onClick={() => changeFolder(entry)}>
                                    <span aria-hidden="true" className={`file-row-icon ${entry.isDir ? 'folder' : 'markdown'}`}>
                                        {entry.isDir ? (collapsedFolders.has(entry.path) ? '▸' : '▾') : 'MD'}
                                    </span>{entry.name}
                                </button>;
                            })}
                            {!visibleFiles.length && <div className="sidebar-empty">此文件夹中没有 Markdown 文件。</div>}
                        </div> : <div className="sidebar-empty">打开文件夹以浏览 Markdown 文件。</div>}
                    </div> : <div className="outline-list">
                        {outline.map(item => <button type="button" key={item.slug} className={currentHeading === item.slug ? 'active' : ''}
                            style={{ paddingLeft: 10 + (item.lvl - 1) * 12 }} title={item.content}
                            onClick={() => transport.postMessage('ScrollTo', { slug: item.slug })}>{item.content}</button>)}
                        {!outline.length && <div className="sidebar-empty">此文档没有标题。</div>}
                    </div>}
                </aside>}
                <main className="typedown-editor-area">{editorSurface}</main>
            </div>
            {toast && <div className={`toast-item ${toast.kind === 'err' ? 'toast-error' : 'toast-ok'}`} role="status">{toast.text}</div>}
            {pickerMode && <div className="picker-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) closePicker(); }}>
                <section className="picker-dialog" role="dialog" aria-modal="true" aria-labelledby="picker-title">
                    <header className="picker-header">
                        <h2 id="picker-title">{pickerMode === 'open' ? '打开 Markdown 文件' : pickerMode === 'folder' ? '选择文件夹' : pickerMode === 'export' ? '导出 HTML' : '保存 Markdown 文件'}</h2>
                        <button type="button" aria-label="关闭" onClick={closePicker}>×</button>
                    </header>
                    <div className="picker-location">
                        <button type="button" onClick={() => void loadPickerPath('')}>此电脑</button>
                        {pickerPath && <><span>›</span><span title={pickerPath}>{pickerPath}</span></>}
                    </div>
                    <div className="picker-toolbar">
                        <button type="button" onClick={pickerParent} disabled={!pickerPath}>返回上级</button>
                        <input className="picker-jump" placeholder="输入完整路径后回车，如 D:\docs" value={pickerJump}
                            onChange={event => setPickerJump(event.target.value)}
                            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); jumpToTypedPath(pickerJump); } }} />
                        <button type="button" onClick={() => jumpToTypedPath(pickerJump)}>跳转</button>
                    </div>
                    <div className="picker-tree" role="listbox" aria-label="文件和文件夹">
                        {renderPickerTree(pickerEntries)}
                        {!pickerEntries.length && <div className="picker-empty">{pickerDrives ? '没有可用磁盘' : pickerMode === 'folder' ? '此文件夹没有子目录' : '此文件夹中没有 Markdown 文件'}</div>}
                    </div>
                    {(pickerMode === 'save' || pickerMode === 'export') && <label className="picker-filename">
                        <span>文件名</span><input value={pickerName} onChange={event => setPickerName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') confirmPicker(); }} />
                    </label>}
                    {pickerError && <div className="picker-error" role="alert">{pickerError}</div>}
                    <footer className="picker-footer">
                        <button type="button" onClick={closePicker}>取消</button>
                        <button type="button" className="primary" onClick={confirmPicker} disabled={pickerBusy}>{pickerBusy ? '导出中…' : pickerMode === 'open' ? '打开' : pickerMode === 'folder' ? '选择文件夹' : pickerMode === 'export' ? '导出' : '保存'}</button>
                    </footer>
                </section>
            </div>}
            <ImageEditLayer />
        </div>
    );
}

export default Editor;
