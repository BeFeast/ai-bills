'use client';

import type { ReactNode } from 'react';

export type TabItem<T extends string> = { value: T; label: ReactNode; count?: number };

/** Pill tab group. `idPrefix` keeps the tab/panel aria wiring stable for existing tests. */
export function Tabs<T extends string>({ items, value, onChange, idPrefix, 'aria-label': ariaLabel }: { items: TabItem<T>[]; value: T; onChange: (value: T) => void; idPrefix?: string; 'aria-label'?: string }) {
  return (
    <div className="bf-tabs" role="tablist" aria-label={ariaLabel}>
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            id={idPrefix ? `${idPrefix}-tab-${item.value}` : undefined}
            aria-controls={idPrefix ? `${idPrefix}-panel-${item.value}` : undefined}
            aria-selected={active}
            className={`bf-tab${active ? ' bf-tab--active' : ''}`}
            onClick={() => onChange(item.value)}
          >
            {item.label}
            {item.count !== undefined ? <span className="bf-tab__count mono">{item.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
