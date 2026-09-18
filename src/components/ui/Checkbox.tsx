'use client';

import type { InputHTMLAttributes, ReactNode } from 'react';

type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label?: ReactNode };

export function Checkbox({ label, disabled, className, ...rest }: CheckboxProps) {
  return (
    <label className={`bf-check${disabled ? ' bf-check--disabled' : ''}${className ? ` ${className}` : ''}`}>
      <input type="checkbox" disabled={disabled} {...rest} />
      <span className="bf-check__box" aria-hidden="true">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
      </span>
      {label ? <span>{label}</span> : null}
    </label>
  );
}
