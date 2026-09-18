import type { ReactNode } from 'react';

/** Two-line table cell: main text (500) over an 11px faint sub line. */
export function Cell({ main, sub, mono, className }: { main: ReactNode; sub?: ReactNode; mono?: boolean; className?: string }) {
  return (
    <div className={`cell${mono ? ' cell--mono' : ''}${className ? ` ${className}` : ''}`}>
      <span className="cell__main">{main}</span>
      {sub ? <span className="cell__sub">{sub}</span> : null}
    </div>
  );
}

/** Small nested panel on `--surface-2`. */
export function Panel({ children, className, onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  return <div className={`panel${className ? ` ${className}` : ''}`} onClick={onClick}>{children}</div>;
}

/** Tinted notice banner (warn / bad / ok / info). */
export function Notice({ tone, role, children }: { tone: 'warn' | 'bad' | 'ok' | 'info'; role?: 'status' | 'alert'; children: ReactNode }) {
  return <div className={`notice notice--${tone}`} role={role}>{children}</div>;
}
