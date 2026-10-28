import { X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

export function Modal({ title, onClose, children, footer, wide, icon }: { title: string; onClose?: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; icon?: ReactNode }) {
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-label={title}>
        <div className="modal-header">
          {icon}
          <h2>{title}</h2>
          {onClose && (
            <button className="icon-btn" onClick={onClose} aria-label="Close">
              <X size={16} />
            </button>
          )}
        </div>
        {children}
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

/** Button with a dropdown menu; closes on outside click. */
export function Menu({ button, children, align = 'left', up }: { button: (open: () => void, isOpen: boolean) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; up?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      {button(() => setOpen((o) => !o), open)}
      {open && (
        <div className="menu" style={{ [align]: 0, ...(up ? { bottom: '100%', marginBottom: 4 } : { top: '100%', marginTop: 4 }) }}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ icon, children, onClick, kbd, disabled }: { icon?: ReactNode; children: ReactNode; onClick: () => void; kbd?: string; disabled?: boolean }) {
  return (
    <button className="item" onClick={onClick} disabled={disabled}>
      {icon}
      <span>{children}</span>
      {kbd && <span className="kbd">{kbd}</span>}
    </button>
  );
}

/** Vertical drag handle between columns. */
export function Resizer({ onResize }: { onResize: (dx: number) => void }) {
  const [dragging, setDragging] = useState(false);
  return (
    <div
      className={`resizer${dragging ? ' dragging' : ''}`}
      onMouseDown={(e) => {
        e.preventDefault();
        let last = e.clientX;
        setDragging(true);
        const move = (ev: MouseEvent) => {
          onResize(ev.clientX - last);
          last = ev.clientX;
        };
        const up = () => {
          setDragging(false);
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      }}
    />
  );
}

/** Text input that commits on blur/Enter, so typing doesn't create an undo entry per key. */
export function TextField({ value, onCommit, placeholder, mono, list, autoFocus, className }: { value: string; onCommit: (v: string) => void; placeholder?: string; mono?: boolean; list?: string; autoFocus?: boolean; className?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      className={`input${mono ? ' mono' : ''}${className ? ` ${className}` : ''}`}
      value={v}
      placeholder={placeholder}
      list={list}
      autoFocus={autoFocus}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onCommit(v)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setV(value);
        e.stopPropagation();
      }}
    />
  );
}

export function NumberField({ value, onCommit, min, step }: { value: number; onCommit: (v: number) => void; min?: number; step?: number }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const commit = () => {
    const n = Number(v);
    if (!Number.isNaN(n) && n !== value && (min === undefined || n >= min)) onCommit(n);
    else setV(String(value));
  };
  return (
    <input
      className="input"
      type="number"
      value={v}
      min={min}
      step={step}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        e.stopPropagation();
      }}
    />
  );
}
