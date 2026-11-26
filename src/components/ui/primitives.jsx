import { useState } from 'react';
import Icon from './Icon.jsx';
import { useToast } from './Toast.jsx';

export function Button({ variant, size, icon, iconOnly, children, className = '', type = 'button', ...rest }) {
  const cls = ['btn', variant, size, iconOnly ? 'icon-only' : '', className].filter(Boolean).join(' ');
  return (
    <button type={type} className={cls} {...rest}>
      {icon && <Icon name={icon} size={size === 'sm' ? 14 : 16} />}
      {!iconOnly && children}
    </button>
  );
}

export function Card({ title, sub, actions, children, flush, className = '', ...rest }) {
  return (
    <section className={`card ${flush ? 'flush' : ''} ${className}`} {...rest}>
      {(title || actions) && (
        <header className="card-header">
          <div className="stack tight">
            {title && <h2 className="card-title">{title}</h2>}
            {sub && <div className="card-sub">{sub}</div>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Badge({ tone = '', children, title, icon }) {
  return (
    <span className={`badge ${tone}`} title={title}>
      {icon && <Icon name={icon} size={11} />}
      {children}
    </span>
  );
}

export function Dot({ tone = '', pulse }) {
  return <span className={`dot ${tone} ${pulse ? 'pulse' : ''}`} aria-hidden="true" />;
}

export function Stat({ label, value, hint, icon }) {
  return (
    <div className="stat">
      <div className="stat-label">
        {icon && <Icon name={icon} size={14} />}
        {label}
      </div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export function PageHeader({ title, sub, actions }) {
  return (
    <header className="page-header">
      <div>
        <h1 className="page-title">{title}</h1>
        {sub && <p className="page-sub">{sub}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Empty({ icon = 'info', title, children, action }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon name={icon} size={22} />
      </div>
      {title && <div className="empty-title">{title}</div>}
      {children && <div className="empty-desc">{children}</div>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}

export function Loading({ label = 'Loading…' }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" />
      {label}
    </div>
  );
}

export function Callout({ tone = 'info', icon, title, children }) {
  const ic = icon || (tone === 'danger' || tone === 'warn' ? 'alert' : tone === 'ok' ? 'checkCircle' : 'info');
  return (
    <div className={`callout ${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      <Icon name={ic} size={16} />
      <div className="stack tight">
        {title && <strong>{title}</strong>}
        <div>{children}</div>
      </div>
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder = 'Search…', width, autoFocus }) {
  return (
    <label className="search">
      <Icon name="search" size={14} />
      <span className="visually-hidden">{placeholder}</span>
      <input
        className="input"
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={width ? { width } : undefined}
        autoFocus={autoFocus}
        spellCheck={false}
      />
    </label>
  );
}

export function Toggle({ checked, onChange, label, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      className="toggle"
      aria-checked={!!checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

export function Field({ label, hint, error, children, style }) {
  return (
    <label className="field" style={style}>
      {label && <span className="field-label">{label}</span>}
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Select({ value, onChange, options, ariaLabel, style }) {
  return (
    <select className="select" value={value ?? ''} onChange={(e) => onChange(e.target.value)} aria-label={ariaLabel} style={style}>
      {options.map((o) => (
        <option key={String(o.value)} value={o.value ?? ''}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Segmented({ value, onChange, options, ariaLabel }) {
  return (
    <div className="segmented" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Chip({ pressed, onClick, children, count }) {
  return (
    <button type="button" className="chip" aria-pressed={!!pressed} onClick={onClick}>
      {children}
      {count != null && <span className="chip-count">{count}</span>}
    </button>
  );
}

export function Tabs({ value, onChange, tabs }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.value} type="button" role="tab" className="tab" aria-selected={value === t.value} onClick={() => onChange(t.value)}>
          {t.label}
          {t.count != null && <span className="faint xs" style={{ marginLeft: 6 }}>{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Copies text and shows a toast. */
export function CopyButton({ text, label = 'Copy', size = 'sm', iconOnly = true }) {
  const toast = useToast();
  const [done, setDone] = useState(false);
  return (
    <Button
      size={size}
      variant="ghost"
      icon={done ? 'check' : 'copy'}
      iconOnly={iconOnly}
      title={label}
      aria-label={label}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(String(text));
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          toast.error('Copy failed', 'The clipboard is not available.');
        }
      }}
    >
      {label}
    </Button>
  );
}

/** Small inline bar chart. `values` are numbers; highlights non-zero bars. */
export function Sparkline({ values, height = 40, title }) {
  const max = Math.max(1, ...values);
  return (
    <div className="sparkline" style={{ height }} role="img" aria-label={title}>
      {values.map((v, i) => (
        <span key={i} className={v > 0 ? 'on' : ''} style={{ height: `${Math.max(4, (v / max) * 100)}%` }} title={String(v)} />
      ))}
    </div>
  );
}

export function Meter({ value, max = 100 }) {
  const pct = Math.max(0, Math.min(100, (value / (max || 1)) * 100));
  return (
    <div className="meter" role="meter" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Process icon (data URL from the backend) with a neutral fallback. */
export function ProcIcon({ src }) {
  return <span className="proc-icon">{src ? <img src={src} alt="" /> : <Icon name="terminal" size={12} />}</span>;
}
