import type { CSSProperties, ReactNode } from 'react';

export type Column<K extends string = string> = { key: K; label: ReactNode; align?: 'left' | 'right' | 'center'; mono?: boolean };

type TableProps<Row, K extends string> = {
  columns: Column<K>[];
  rows: Row[];
  renderCell: (row: Row, column: Column<K>, index: number) => ReactNode;
  rowKey: (row: Row, index: number) => string;
  /** Shown as a single full-width row when there are no rows. */
  empty?: ReactNode;
  caption?: string;
  className?: string;
  style?: CSSProperties;
};

/** Hairline-framed table; header cells uppercase micro type, rows tint on hover. */
export function Table<Row, K extends string = string>({ columns, rows, renderCell, rowKey, empty, caption, className, style }: TableProps<Row, K>) {
  return (
    <div className={`bf-table-wrap${className ? ` ${className}` : ''}`} style={style}>
      <table className="bf-table">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr>{columns.map((column) => <th key={column.key} style={{ textAlign: column.align || 'left' }}>{column.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={rowKey(row, index)}>
              {columns.map((column) => (
                <td key={column.key} className={column.mono ? 'bf-td--mono' : undefined} style={{ textAlign: column.align || 'left' }}>
                  {renderCell(row, column, index)}
                </td>
              ))}
            </tr>
          ))}
          {!rows.length && empty !== undefined ? <tr><td colSpan={columns.length} className="bf-td--empty">{empty}</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}
