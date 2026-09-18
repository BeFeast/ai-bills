'use client';

import type { CSSProperties, InputHTMLAttributes, ReactNode } from 'react';

type InputProps = InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode; hint?: ReactNode; error?: ReactNode; fieldStyle?: CSSProperties; fieldClassName?: string };

export function Input({ label, hint, error, fieldStyle, fieldClassName, className, ...rest }: InputProps) {
  const input = <input className={`bf-input${error ? ' bf-input--error' : ''}${className ? ` ${className}` : ''}`} {...rest} />;
  if (!label && !hint && !error) return input;
  return (
    <label className={`bf-field${fieldClassName ? ` ${fieldClassName}` : ''}`} style={fieldStyle}>
      {label ? <span className="bf-label">{label}</span> : null}
      {input}
      {error ? <span className="bf-hint bf-hint--error">{error}</span> : hint ? <span className="bf-hint">{hint}</span> : null}
    </label>
  );
}
