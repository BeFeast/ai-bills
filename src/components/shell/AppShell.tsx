'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Button, Pill, menuIcon, type PillTone } from '@/components/ui';
import { Sidebar, type SidebarItem } from './Sidebar';

export type Theme = 'light' | 'dark';
const THEME_KEY = 'ai-bills-theme';

/** Reads the persisted scheme and mirrors it onto <html data-theme>. Light is the default. */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>('light');
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(THEME_KEY);
      if (stored === 'dark' || stored === 'light') setTheme(stored);
      else if (document.documentElement.getAttribute('data-theme') === 'dark') setTheme('dark');
    } catch { /* storage may be unavailable; stay light */ }
  }, []);
  useEffect(() => {
    if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
  }, [theme]);
  function toggle() {
    setTheme((current) => {
      const next: Theme = current === 'dark' ? 'light' : 'dark';
      try { window.localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
      return next;
    });
  }
  return [theme, toggle];
}

type AppShellProps<T extends string> = {
  brand: { mark: ReactNode; name: string; sub?: string };
  items: SidebarItem<T>[];
  view: T;
  onView: (view: T) => void;
  sidebarFooter?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  status: { text: ReactNode; tone?: PillTone };
  countdown?: ReactNode;
  onRefresh: () => void;
  refreshing?: boolean;
  theme: Theme;
  onToggleTheme: () => void;
  footerLeft?: ReactNode;
  footerRight?: ReactNode;
  children: ReactNode;
};

/** 232px sidebar + sticky topbar + content + footer; ≤900px the sidebar becomes a 264px drawer on a blurred scrim. */
export function AppShell<T extends string>({ brand, items, view, onView, sidebarFooter, title, subtitle, status, countdown, onRefresh, refreshing, theme, onToggleTheme, footerLeft, footerRight, children }: AppShellProps<T>) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => {
    if (!drawerOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setDrawerOpen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [drawerOpen]);
  const select = (next: T) => { setDrawerOpen(false); onView(next); };
  const sidebar = <Sidebar brand={brand} sectionLabel="dashboard" items={items} activeId={view} onSelect={select} footer={sidebarFooter} />;
  return (
    <div className="app">
      <div className="app__side">{sidebar}</div>
      {drawerOpen ? (
        <div className="drawer" onClick={() => setDrawerOpen(false)}>
          <div className="drawer__panel" onClick={(event) => event.stopPropagation()}>{sidebar}</div>
        </div>
      ) : null}
      <div className="app__main">
        <header className="topbar">
          <Button variant="ghost" size="sm" className="topbar__menu" onClick={() => setDrawerOpen(true)} aria-label="Open navigation">{menuIcon} Menu</Button>
          <div className="topbar__title">
            <h1 className="t-h3">{title}</h1>
            {subtitle ? <p className="t-small">{subtitle}</p> : null}
          </div>
          <div className="topbar__tools">
            <Pill tone={status.tone} dot>{status.text}</Pill>
            {countdown ? <span className="topbar__countdown mono">{countdown}</span> : null}
            <Button variant="secondary" size="sm" onClick={onRefresh} disabled={refreshing}>{refreshing ? 'Refreshing…' : 'Refresh now'}</Button>
            <Button variant="ghost" size="sm" onClick={onToggleTheme}>{theme === 'dark' ? 'Light scheme' : 'Dark scheme'}</Button>
          </div>
        </header>
        <main className="content" key={view}>{children}</main>
        <footer className="app__footer">
          <span>{footerLeft}</span>
          <span className="mono">{footerRight}</span>
        </footer>
      </div>
    </div>
  );
}
