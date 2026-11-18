import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { editorExtensions } from './editorExtensions';

// 复现工具栏「代码块」按钮的逻辑：空选区 / 多行选区两条路径
let editor: Editor | null = null;

afterEach(() => { editor?.destroy(); editor = null; });

describe('代码块按钮逻辑（toggleSmartCodeBlock）', () => {
  it('空选区：toggleCodeBlock 把段落变成代码块', () => {
    editor = new Editor({ extensions: editorExtensions, content: '<p>hello</p>' });
    editor.commands.focus('start');
    const ok = editor.chain().focus().toggleCodeBlock().run();
    expect(ok).toBe(true);
    expect(editor.getJSON().content?.[0]?.type).toBe('codeBlock');
  });

  it('多行选区：deleteSelection + insertContent codeBlock', () => {
    editor = new Editor({ extensions: editorExtensions, content: '<p>line1</p><p>line2</p>' });
    const docSize = editor.state.doc.content.size;
    editor.commands.setTextSelection({ from: 1, to: docSize - 1 });
    const text = editor.state.doc.textBetween(
      editor.state.selection.from, editor.state.selection.to, '\n');
    expect(text.includes('\n')).toBe(true);
    const ok = editor.chain().focus().deleteSelection().insertContent({
      type: 'codeBlock', content: [{ type: 'text', text }],
    }).run();
    expect(ok).toBe(true);
    expect(JSON.stringify(editor.getJSON())).toContain('"codeBlock"');
  });

  it('代码块内再点一次：退回段落', () => {
    editor = new Editor({ extensions: editorExtensions, content: '<pre><code>const a = 1;</code></pre>' });
    editor.commands.focus('start');
    expect(editor.isActive('codeBlock')).toBe(true);
    const ok = editor.chain().focus().toggleCodeBlock().run();
    expect(ok).toBe(true);
    expect(editor.getJSON().content?.[0]?.type).not.toBe('codeBlock');
  });
});
