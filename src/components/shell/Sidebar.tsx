'use client';

import type { ReactNode } from 'react';

export type SidebarItem<T extends string> = { id: T; label: string; icon?: ReactNode; count?: number; /** Deep link for the item; the click still goes through onSelect so the app can switch without a reload. */ href?: string };

type SidebarProps<T extends string> = {
  brand: { mark: ReactNode; name: ReactNode; sub?: ReactNode };
  sectionLabel?: string;
  items: SidebarItem<T>[];
  activeId: T;
  onSelect: (id: T) => void;
  footer?: ReactNode;
  className?: string;
};

/** `.bf-sb` recipe: brand row, section label, 34px nav rows, mono footer pinned to the bottom. */
export function Sidebar<T extends string>({ brand, sectionLabel, items, activeId, onSelect, footer, className }: SidebarProps<T>) {
  return (
    <nav className={`bf-sb${className ? ` ${className}` : ''}`} aria-label="Dashboard sections">
      <div className="bf-sb__brand">
        {brand.mark}
        <div className="bf-sb__brand-text">
          <div className="bf-sb__name">{brand.name}</div>
          {brand.sub ? <div className="bf-sb__sub mono">{brand.sub}</div> : null}
        </div>
      </div>
      {sectionLabel ? <div className="bf-sb__sec">{sectionLabel}</div> : null}
      {items.map((item) => {
        const active = item.id === activeId;
        return (
          <a key={item.id} href={item.href ?? `?view=${item.id}`} className={`bf-sb__link${active ? ' bf-sb__link--active' : ''}`} aria-current={active ? 'page' : undefined}
            onClick={(event) => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return; event.preventDefault(); onSelect(item.id); }}>
            {item.icon ? <span className="bf-sb__icon">{item.icon}</span> : null}
            <span className="bf-sb__label">{item.label}</span>
            {item.count !== undefined ? <span className="bf-sb__count">{item.count}</span> : null}
          </a>
        );
      })}
      {footer ? <div className="bf-sb__footer">{footer}</div> : null}
    </nav>
  );
}
