'use client';

import type { CSSProperties, ReactNode, SelectHTMLAttributes } from 'react';

export type SelectOption = { value: string; label: ReactNode; disabled?: boolean };
type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & { label?: ReactNode; options?: SelectOption[]; fieldStyle?: CSSProperties; fieldClassName?: string };

export function Select({ label, options, children, fieldStyle, fieldClassName, className, ...rest }: SelectProps) {
  const select = (
    <select className={`bf-select${className ? ` ${className}` : ''}`} {...rest}>
      {options ? options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>) : children}
    </select>
  );
  if (!label) return select;
  return <label className={`bf-field${fieldClassName ? ` ${fieldClassName}` : ''}`} style={fieldStyle}><span className="bf-label">{label}</span>{select}</label>;
}
