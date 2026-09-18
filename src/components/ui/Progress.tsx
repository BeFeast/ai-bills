import type { CSSProperties } from 'react';

export function Progress({ value, max = 100, tone, label, style }: { value: number | null | undefined; max?: number; tone?: 'warn' | 'bad'; label?: string; style?: CSSProperties }) {
  const safe = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  const pct = Math.min(Math.max((safe / max) * 100, 0), 100);
  return (
    <div className={`bf-progress${tone ? ` bf-progress--${tone}` : ''}`} role="progressbar" aria-label={label} aria-valuenow={Math.round(safe)} aria-valuemin={0} aria-valuemax={max} style={style}>
      <div className="bf-progress__fill" style={{ width: `${pct}%` }} />
    </div>
  );
}
