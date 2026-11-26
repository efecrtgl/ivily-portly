import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Button } from './primitives.jsx';

/** Accessible modal: focus trap entry, Escape to close, backdrop click to close. */
export function Modal({ title, children, footer, onClose, wide, labelledBy = 'modal-title', dismissable = true }) {
  const ref = useRef(null);
  // Keep the latest callbacks in refs so parent re-renders (e.g. live
  // snapshots) never re-run the focus effect and steal focus while typing.
  const onCloseRef = useRef(onClose);
  const dismissRef = useRef(dismissable);
  useEffect(() => {
    onCloseRef.current = onClose;
    dismissRef.current = dismissable;
  });
  useEffect(() => {
    const prev = document.activeElement;
    const el = ref.current;
    const first = el?.querySelector('input, select, textarea, button:not([data-autofocus-skip])');
    first?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape' && dismissRef.current) {
        e.stopPropagation();
        onCloseRef.current?.();
      }
      if (e.key === 'Tab' && el) {
        const f = [...el.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled);
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) {
          e.preventDefault();
          f[f.length - 1].focus();
        } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) {
          e.preventDefault();
          f[0].focus();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && dismissable && onClose?.()}>
      <div ref={ref} className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
        <div className="modal-header">
          <h2 className="modal-title" id={labelledBy}>
            {title}
          </h2>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

const ConfirmContext = createContext(null);

/**
 * `const confirm = useConfirm(); if (await confirm({ title, body, confirmLabel, danger, typeToConfirm })) …`
 * `typeToConfirm` requires the user to type an exact string before confirming.
 */
export function ConfirmProvider({ children }) {
  const [req, setReq] = useState(null);
  const [typed, setTyped] = useState('');
  const confirm = useCallback(
    (opts) =>
      new Promise((resolve) => {
        setTyped('');
        setReq({ ...opts, resolve });
      }),
    [],
  );
  const close = (v) => {
    req?.resolve(v);
    setReq(null);
  };
  const blocked = req?.typeToConfirm && typed.trim() !== String(req.typeToConfirm);
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {req && (
        <Modal
          title={req.title}
          onClose={() => close(false)}
          labelledBy="confirm-title"
          footer={
            <>
              <Button variant="ghost" onClick={() => close(false)}>
                {req.cancelLabel || 'Cancel'}
              </Button>
              <Button variant={req.danger ? 'danger' : 'primary'} disabled={blocked} onClick={() => close(true)}>
                {req.confirmLabel || 'Confirm'}
              </Button>
            </>
          }
        >
          {typeof req.body === 'string' ? <p className="muted">{req.body}</p> : req.body}
          {req.typeToConfirm && (
            <label className="field">
              <span className="field-label">
                Type <code>{req.typeToConfirm}</code> to confirm
              </span>
              <input className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
            </label>
          )}
        </Modal>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used inside ConfirmProvider');
  return ctx;
}
