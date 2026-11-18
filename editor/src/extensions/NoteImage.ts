import Image from '@tiptap/extension-image';
import { resolveAssetUrl } from '../utils/assetUrl';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { currentNoteDir } from '../utils/currentNoteDir';
import { copyImageSelection } from '../utils/copyImage';

/**
 * 图片节点：文档里保存的仍是 Markdown 里写的地址（assets/a.png），
 * 显示时按笔记所在目录解析成可加载的地址 —— 否则相对路径会相对应用自身去找，图片永远是裂的。
 *
 * 图下带一行图片描述（Markdown 的替代文字）；默认藏着，设置「图下显示图片描述」打开时才显示（#6）。
 * 外层多一个容器是为了放这行字，样式让它只包住图，选中框还是贴着图的。
 */
export const NoteImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      // 从笔记里复制出去的图片换成了 data: 地址，贴回笔记时用原地址，不把整张图写进文件
      src: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-note-src') || el.getAttribute('src'),
      },
      // 源文件里路径带空格、又没用 <> 包起来的宽松写法：保存时原样写回
      lenient: {
        default: false,
        parseHTML: (el: HTMLElement) => el.hasAttribute('data-lenient'),
        renderHTML: (attrs: Record<string, any>) => (attrs.lenient ? { 'data-lenient': '' } : {}),
      },
      // 手动调过的宽度（px）。不设就是自适应，由 CSS 的 max-width 兜底不溢出正文。
      width: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const raw = el.getAttribute('width') || el.style.width || '';
          const n = parseInt(raw, 10);
          return Number.isFinite(n) && n > 0 ? n : null;
        },
        renderHTML: (attrs: Record<string, any>) => (attrs.width ? { width: String(attrs.width) } : {}),
      },
    };
  },

  addNodeView() {
    return ({ node, getPos }: { node: any; getPos: () => number | undefined }) => {
      let current = node;
      const dom = document.createElement('div');
      dom.className = 'note-image';
      const img = document.createElement('img');
      const caption = document.createElement('div');
      caption.className = 'note-image__caption';

      // 图片在正文里默认只有一张图，改地址 / 改描述没有入口。悬停或选中时给两个按钮，
      // 具体动作交给 React 侧处理（编辑走插入对话框，删除走事务），这里只抛事件。
      const tools = document.createElement('div');
      tools.className = 'note-image__tools';
      tools.contentEditable = 'false';
      const mkBtn = (act: string, title: string, svg: string) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'note-image__tool';
        b.dataset.act = act;
        b.title = title;
        b.innerHTML = svg;
        // 不 preventDefault 的话按下按钮会把光标移走、选区塌掉，编辑目标就丢了
        b.addEventListener('mousedown', (e) => e.preventDefault());
        b.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const pos = getPos();
          if (typeof pos !== 'number') return;
          dom.dispatchEvent(new CustomEvent(`note-image:${act}`, {
            bubbles: true,
            detail: { pos, src: current.attrs.src || '', alt: current.attrs.alt || '' },
          }));
        });
        return b;
      };
      tools.append(
        mkBtn('edit', '编辑图片', '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z"/></svg>'),
        mkBtn('delete', '删除图片', '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'),
      );
      // 右下角手柄：拖的时候只改样式给即时反馈，松手才抛事件写进文档（避免每帧一个事务）
      const resize = document.createElement('div');
      resize.className = 'note-image__resize';
      resize.title = '拖动调整宽度';
      resize.contentEditable = 'false';
      let liveWidth: number | null = null;
      const setWidth = (px: number | null) => {
        liveWidth = px;
        const value = px ? `${px}px` : '';
        img.style.width = value;
        // 沙箱里 <img> 会被换成 canvas，两样都改，不然拖完看不见变化
        dom.querySelectorAll('canvas').forEach((c) => { (c as HTMLElement).style.width = value; });
      };
      let drag: { x: number; w: number; max: number } | null = null;
      const onMove = (e: MouseEvent) => {
        if (!drag) return;
        setWidth(Math.round(Math.min(drag.max, Math.max(80, drag.w + e.clientX - drag.x))));
      };
      const onUp = () => {
        if (!drag) return;
        drag = null;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        const pos = getPos();
        if (typeof pos === 'number') {
          dom.dispatchEvent(new CustomEvent('note-image:resize', { bubbles: true, detail: { pos, width: liveWidth } }));
        }
      };
      resize.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const contentWidth = dom.parentElement?.clientWidth || dom.getBoundingClientRect().width;
        // img 在沙箱里可能已被 hydrateDbxAssets 换成 canvas、本身脱离文档，量它得到 0；量外层容器才准
        drag = { x: e.clientX, w: dom.getBoundingClientRect().width, max: Math.max(120, contentWidth) };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });
      // 双击手柄恢复自适应（去掉文档里的 width）
      resize.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setWidth(null);
        const pos = getPos();
        if (typeof pos === 'number') dom.dispatchEvent(new CustomEvent('note-image:resize', { bubbles: true, detail: { pos, width: null } }));
      });

      dom.append(img, caption, tools, resize);
      const apply = () => {
        img.src = resolveAssetUrl(current.attrs.src || '', currentNoteDir());
        img.alt = current.attrs.alt || '';
        caption.textContent = current.attrs.alt || '';
        if (current.attrs.title) img.title = current.attrs.title;
        else img.removeAttribute('title');
        setWidth(current.attrs.width || null);
      };
      apply();
      return {
        dom,
        update: (updated) => {
          if (updated.type !== current.type) return false;
          const changed = updated.attrs.src !== current.attrs.src
            || updated.attrs.alt !== current.attrs.alt
            || updated.attrs.title !== current.attrs.title
            || updated.attrs.width !== current.attrs.width;
          current = updated;
          if (changed) apply();
          return true;
        },
        destroy: () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
        },
      };
    };
  },

  addProseMirrorPlugins() {
    return [
      ...(this.parent?.() ?? []),
      new Plugin({
        key: new PluginKey('noteImageCopy'),
        props: { handleDOMEvents: { copy: (view, event) => copyImageSelection(view, event) } },
      }),
    ];
  },
});
