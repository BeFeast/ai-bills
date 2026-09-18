'use client';

import type { ReactNode } from 'react';

type StatTileProps = { label: ReactNode; value: ReactNode; note?: ReactNode; onClick?: () => void; 'aria-label'?: string };

/** KPI / metric tile: micro label, 26px tabular value, small note. Clickable tiles render as buttons. */
export function StatTile({ label, value, note, onClick, ...aria }: StatTileProps) {
  const body = <>
    <span className="t-micro">{label}</span>
    <span className="stat-tile__value tabular">{value}</span>
    {note !== undefined ? <span className="t-small">{note}{onClick ? ' →' : ''}</span> : null}
  </>;
  if (onClick) return <button type="button" className="bf-card bf-card--hover stat-tile" onClick={onClick} aria-label={aria['aria-label']}>{body}</button>;
  return <div className="bf-card stat-tile">{body}</div>;
}

export function TileGrid({ children, minWidth = 220 }: { children: ReactNode; minWidth?: number }) {
  return <div className="tile-grid" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${minWidth}px, 1fr))` }}>{children}</div>;
}
