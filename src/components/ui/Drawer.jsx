import { useEffect } from 'react';
import Icon from './Icon.jsx';

/** Right-side detail panel. Escape or backdrop click closes it. */
export default function Drawer({ title, subtitle, icon, actions, footer, onClose, children, wide }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !document.querySelector('.modal-backdrop')) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <div className="drawer-backdrop" onMouseDown={onClose} />
      <aside className={`drawer ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : 'Details'}>
        <header className="drawer-header">
          {icon}
          <div className="stack tight" style={{ flex: 1, minWidth: 0 }}>
            <h2 className="truncate" style={{ fontSize: 'var(--fs-xl)' }}>
              {title}
            </h2>
            {subtitle && <div className="muted small">{subtitle}</div>}
          </div>
          {actions}
          <button type="button" className="btn ghost sm icon-only" onClick={onClose} aria-label="Close">
            <Icon name="close" size={14} />
          </button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer && <footer className="drawer-footer">{footer}</footer>}
      </aside>
    </>
  );
}
