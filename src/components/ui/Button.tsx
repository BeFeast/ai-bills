'use client';

import type { AnchorHTMLAttributes, ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export function buttonClass(variant: ButtonVariant = 'primary', size: ButtonSize = 'md', extra?: string): string {
  return `bf-btn bf-btn--${variant}${size !== 'md' ? ` bf-btn--${size}` : ''}${extra ? ` ${extra}` : ''}`;
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize };

/** BeFeast button recipe. Defaults to type="button" so form submits stay explicit. */
export function Button({ variant = 'primary', size = 'md', className, type = 'button', ...rest }: ButtonProps) {
  return <button type={type} className={buttonClass(variant, size, className)} {...rest} />;
}

type ButtonLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: ButtonVariant; size?: ButtonSize };

/** Anchor styled as a button, for external links that must stay real links. */
export function ButtonLink({ variant = 'secondary', size = 'md', className, ...rest }: ButtonLinkProps) {
  return <a className={buttonClass(variant, size, className)} {...rest} />;
}
