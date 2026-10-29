import React, { useEffect, useState } from 'react';
import transport, { invoke } from 'services/transport';

type Rect = { top: number; left: number; width: number; height: number; bottom: number; right: number };

const layerBackdrop: React.CSSProperties = { position: 'fixed', inset: 0, zIndex: 9000 };

function toolbarStyle(rect: Rect): React.CSSProperties {
  return {
    position: 'fixed',
    top: Math.max(8, rect.top - 46),
    left: rect.left,
    zIndex: 9001,
    display: 'flex',
    gap: 4,
    padding: 4,
    background: '#ffffff',
    border: '1px solid #d0d0d0',
    borderRadius: 6,
    boxShadow: '0 2px 10px rgba(0,0,0,0.18)',
  };
}

const btn: React.CSSProperties = {
  border: '1px solid #d0d0d0', background: '#f6f6f6', borderRadius: 4,
  padding: '4px 8px', cursor: 'pointer', fontSize: 13,
};

const fieldLabel: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 };
const fieldInput: React.CSSProperties = { padding: 6, border: '1px solid #ccc', borderRadius: 4, fontSize: 13 };

/**
 * 宿主侧图片编辑层。
 * Muya 的图片工具栏/选择器只通过 transport 通知宿主，浮层必须由宿主渲染。
 * 这里补齐缺失的宿主端：监听 OpenImageToolbar / OpenImageSelector，
 * 渲染浮层，并把用户操作回传 ImageEditToolbarClick / ReplaceImage。
 */
const ImageEditLayer: React.FC = () => {
  const [toolbar, setToolbar] = useState<{ rect: Rect; attrs: Record<string, any> } | null>(null);
  const [selector, setSelector] = useState<{ imageInfo: { alt: string; src: string; title: string }; rect: Rect } | null>(null);
  const [alt, setAlt] = useState('');
  const [src, setSrc] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    const onToolbar = (p: any) => setToolbar({ rect: p.boundingClientRect, attrs: p.attrs });
    const onSelector = (p: any) => {
      setAlt(p.imageInfo?.alt || '');
      setSrc(p.imageInfo?.src || '');
      setTitle(p.imageInfo?.title || '');
      setErr('');
      setSelector({ imageInfo: p.imageInfo, rect: p.boundingClientRect });
    };
    transport.addListener('OpenImageToolbar', onToolbar);
    transport.addListener('OpenImageSelector', onSelector);
    return () => {
      transport.removeListener('OpenImageToolbar', onToolbar);
      transport.removeListener('OpenImageSelector', onSelector);
    };
  }, []);

  const sendToolbar = (type: string, attrName?: string, attrValue?: string) => {
    transport.postMessage('ImageEditToolbarClick', attrName ? { type, attrName, attrValue } : { type });
    setToolbar(null);
  };

  const pickImage = async () => {
    setBusy(true);
    setErr('');
    try {
      const res = await invoke<{ cancelled: boolean; path?: string }>('fs/pickFile', { filter: 'image' }, 300000);
      if (!res.cancelled && res.path) {
        const img = await invoke<{ dataUrl: string }>('fs/readImage', { path: res.path });
        setSrc(img.dataUrl);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : '选择图片失败');
    } finally {
      setBusy(false);
    }
  };

  const confirmReplace = () => {
    transport.postMessage('ReplaceImage', {
      alt: alt.trim(),
      src: src.trim(),
      title: title.trim(),
      isReplaceSelected: true,
    });
    setSelector(null);
  };

  return (
    <>
      {toolbar && (
        <>
          <div style={layerBackdrop} onClick={() => setToolbar(null)} />
          <div style={toolbarStyle(toolbar.rect)}>
            <button style={btn} title="删除图片" onClick={() => sendToolbar('delete')}>删除</button>
            <button style={btn} title="左对齐" onClick={() => sendToolbar('left')}>左</button>
            <button style={btn} title="居中" onClick={() => sendToolbar('center')}>中</button>
            <button style={btn} title="右对齐" onClick={() => sendToolbar('right')}>右</button>
            <button style={btn} title="编辑图片" onClick={() => sendToolbar('edit')}>编辑</button>
          </div>
        </>
      )}
      {selector && (
        <div className="picker-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setSelector(null); }}>
          <section className="picker-dialog" role="dialog" aria-modal="true" aria-labelledby="img-edit-title">
            <header className="picker-header">
              <h2 id="img-edit-title">编辑图片</h2>
              <button type="button" aria-label="关闭" onClick={() => setSelector(null)}>×</button>
            </header>
            <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <label style={fieldLabel}>说明文字
                <input style={fieldInput} value={alt} onChange={e => setAlt(e.target.value)} />
              </label>
              <label style={fieldLabel}>标题
                <input style={fieldInput} value={title} onChange={e => setTitle(e.target.value)} />
              </label>
              <label style={fieldLabel}>图片地址（http(s)://、data: 或本地路径）
                <input style={fieldInput} value={src} onChange={e => setSrc(e.target.value)} placeholder="可点击下方按钮选择本地图片" />
              </label>
              <button type="button" style={{ ...btn, alignSelf: 'flex-start' }} onClick={() => void pickImage()} disabled={busy}>
                {busy ? '读取中…' : '选择本地图片…'}
              </button>
              {err && <div className="picker-error" role="alert">{err}</div>}
            </div>
            <footer className="picker-footer">
              <button type="button" onClick={() => setSelector(null)}>取消</button>
              <button type="button" className="primary" onClick={confirmReplace}>确定</button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
};

export default ImageEditLayer;
