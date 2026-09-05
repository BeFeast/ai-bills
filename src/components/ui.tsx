'use client';

import type { ReactNode } from 'react';
import { barWidth, fmtPct } from './format';

export type Severity = 'ok' | 'warn' | 'danger' | 'muted';

/** Hover/focus tooltip chip — accessible label mirrors the legacy `tip` spans. */
export function Tip({ cls, label, note, kind = 'badge-mini' }: { cls: string; label: string; note: string; kind?: string }) {
  return (
    <span className={`tip ${kind} ${cls}`} tabIndex={0} role="button" aria-label={`${label}. ${note}`} data-tip={note}>
      {label}
    </span>
  );
}

export function AvailabilityPill({ tone, label, detail }: { tone: string; label: string; detail: string }) {
  return (
    <div className="availability-line">
      <span
        className={`tip availability ${tone}`}
        tabIndex={0}
        role="button"
        aria-label={`${label}. ${detail}`}
        data-tip={detail}
      >
        {label}
      </span>
    </div>
  );
}

export function LiveBadge({ ok, text }: { ok: boolean; text?: string }) {
  return <span className={`badge ${ok ? 'ok' : 'danger'}`}>{text ?? (ok ? 'Live' : 'Error')}</span>;
}

export function Bar({ pct, state }: { pct: number | null | undefined; state: Severity }) {
  return (
    <div className={`bar bar-${state}`}>
      <div style={{ width: barWidth(pct) }} />
    </div>
  );
}

/** A single utilization row: title, badges, percent, progress bar and KV rows. */
export function UsageBlock({
  state,
  label,
  pct,
  right,
  children,
}: {
  state: Severity;
  label: string;
  pct: number | null;
  right?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className={`usage ${state}`}>
      <div className="usage-top">
        <h3>{label}</h3>
        <div className="usage-right usage-inline">
          {right}
          <strong>{fmtPct(pct)}</strong>
        </div>
      </div>
      <Bar pct={pct} state={state} />
      <div className="kv compact">{children}</div>
    </section>
  );
}

export function Metric({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: ReactNode;
  note: string;
  /** Provider/family tint: claude | kimi | codex | cursor | billing | live */
  tone?: 'claude' | 'kimi' | 'codex' | 'cursor' | 'billing' | 'live';
}) {
  return (
    <div className={`metric${tone ? ` tone-${tone}` : ''}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      <div className="muted">{note}</div>
    </div>
  );
}

export function StatusPill({ status }: { status: string }) {
  const s = String(status || 'unknown').toLowerCase();
  const cls = s.includes('active') || s.includes('ok') ? 'ok' : s.includes('error') || s.includes('fail') ? 'danger' : 'warn';
  return <span className={`pill ${cls}`}>{status || 'unknown'}</span>;
}

export function Sparkline({ values }: { values?: number[] | null }) {
  if (!values?.length) return <span className="muted">n/a</span>;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values
    .map((v, i) => `${((i / Math.max(1, values.length - 1)) * 120).toFixed(1)},${(26 - ((v - min) / span) * 22).toFixed(1)}`)
    .join(' ');
  return (
    <svg className="spark" width="120" height="28" viewBox="0 0 120 28" aria-hidden="true">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

/** collapsed-by-default accordion (spend / credits / subscription detail). */
export function Accordion({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="subsection accordion spend-accordion">
      <summary>
        <span>{title}</span>
        <span className="accordion-hint">collapsed by default</span>
      </summary>
      {children}
    </details>
  );
}
