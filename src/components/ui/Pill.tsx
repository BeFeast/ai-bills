import type { CSSProperties, ReactNode } from 'react';

export type PillTone = 'ok' | 'warn' | 'bad' | 'info' | 'queued' | 'idle';

export function Pill({ tone, dot, title, className, style, children }: { tone?: PillTone; dot?: boolean; title?: string; className?: string; style?: CSSProperties; children: ReactNode }) {
  return (
    <span className={`bf-pill${tone ? ` bf-pill--${tone}` : ''}${className ? ` ${className}` : ''}`} title={title} style={style}>
      {dot ? <span className="bf-pill__dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

/** Legacy severity strings (ok | warn | danger | muted) mapped onto pill tones. */
export function toneOf(state: string | null | undefined): PillTone | undefined {
  switch ((state || '').toLowerCase()) {
    case 'ok': case 'fresh': case 'active': case 'available': case 'settled': return 'ok';
    case 'warn': case 'stale': case 'partial': return 'warn';
    case 'danger': case 'bad': case 'error': case 'failed': case 'rejected': return 'bad';
    case 'info': return 'info';
    case 'muted': case 'idle': case 'unknown': return 'idle';
    default: return undefined;
  }
}
