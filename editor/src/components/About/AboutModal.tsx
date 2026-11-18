import React from 'react';
import { X } from 'lucide-react';
import {
  APP_NAME, APP_TAGLINE, REPO_URL, LICENSE_NAME,
  UPSTREAM_NAME, UPSTREAM_VERSION, UPSTREAM_URL, UPSTREAM_LICENSE,
} from '../../utils/appInfo';

interface AboutModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/** 插件自己的图标（与 manifest.json 的 icon 同源），内联绘制：不依赖外部图片，也不带上游品牌 */
const PluginLogo: React.FC = () => (
  <svg viewBox="0 0 96 96" role="img" aria-label={APP_NAME}>
    <rect width="96" height="96" rx="22" fill="#172554" />
    <path d="M24 12h34l16 16v56H24z" fill="#fff" />
    <path d="M58 12v16h16" fill="#bfdbfe" />
    <path d="M58 12l16 16H58z" fill="#60a5fa" />
    <path d="M34 38v18M46 38v18M34 47h12" fill="none" stroke="#2563eb" strokeWidth="4" strokeLinecap="round" />
    <path d="M34 66h28M34 74h20" fill="none" stroke="#64748b" strokeWidth="4" strokeLinecap="round" />
  </svg>
);

const AboutModal: React.FC<AboutModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  const isStandalone = new URLSearchParams(window.location.search).get('window') === 'about';
  const isMac = window.api.app.platform === 'darwin';
  const open = (url: string) => window.api.shell.openExternal(url);

  return (
    <div className={isStandalone ? 'standalone about-standalone' : 'modal-backdrop'} onClick={onClose}>
      {isStandalone && <div className="standalone-drag" />}
      <div className={isStandalone ? 'about-card about-card--standalone' : 'modal-card about-card'} onClick={(e) => e.stopPropagation()}>
        <div className="about-logo"><PluginLogo /></div>
        <h1 className="about-name">{APP_NAME}</h1>
        <p className="about-version">Version {window.api.appVersion}</p>
        <p className="about-slogan">{APP_TAGLINE}</p>

        <div className="about-info">
          <div className="about-info__row"><span>项目仓库</span><span className="about-link" onClick={() => open(REPO_URL)}>View Repository</span></div>
          <div className="about-info__row"><span>编辑内核</span><span className="about-link" onClick={() => open(UPSTREAM_URL)}>{UPSTREAM_NAME} {UPSTREAM_VERSION}</span></div>
          <div className="about-info__row"><span>内核许可</span><span className="about-info__value">{UPSTREAM_LICENSE}</span></div>
          <div className="about-info__row"><span>本插件许可</span><span className="about-info__value">{LICENSE_NAME}</span></div>
        </div>

        <p className="about-footer">
          &copy; 2026 huangqiang，以 {LICENSE_NAME} 许可发布。<br />
          内嵌的 Tiptap、CodeMirror、KaTeX、DOMPurify 等第三方组件<br />
          许可全文随插件分发于 <code>assets/licenses/</code>
        </p>

        {(!isStandalone || !isMac) && (
          <button onClick={onClose} className="modal-close"><X size={20} /></button>
        )}
      </div>
    </div>
  );
};

export default AboutModal;
