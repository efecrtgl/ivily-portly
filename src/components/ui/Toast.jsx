import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const seq = useRef(0);
  const dismiss = useCallback((id) => setItems((xs) => xs.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (tone, title, body, ms = 4200) => {
      const id = ++seq.current;
      setItems((xs) => [...xs.slice(-3), { id, tone, title, body }]);
      setTimeout(() => dismiss(id), ms);
    },
    [dismiss],
  );
  const api = useMemo(
    () => ({
      ok: (title, body) => push('ok', title, body),
      error: (title, body) => push('error', title, body, 7000),
      warn: (title, body) => push('warn', title, body, 6000),
      info: (title, body) => push('info', title, body),
      /** Shows an error from the backend `{ code, message }` shape. */
      fail: (title, err) => push('error', title, err?.message || String(err), 7000),
    }),
    [push],
  );
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`} role={t.tone === 'error' ? 'alert' : 'status'}>
            <Icon name={t.tone === 'ok' ? 'checkCircle' : t.tone === 'error' ? 'x' : t.tone === 'warn' ? 'alert' : 'info'} size={18} />
            <div className="stack tight" style={{ flex: 1 }}>
              <div className="toast-title">{t.title}</div>
              {t.body && <div className="muted selectable">{t.body}</div>}
            </div>
            <button type="button" className="btn ghost sm icon-only" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              <Icon name="close" size={12} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}
