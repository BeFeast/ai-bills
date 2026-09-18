import type { CSSProperties, ReactNode } from 'react';

type CardProps = {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  selected?: boolean;
  hover?: boolean;
  padded?: boolean;
  className?: string;
  style?: CSSProperties;
  id?: string;
  'aria-label'?: string;
  children?: ReactNode;
};

/** White card with hairline, 12px radius and the soft navy shadow. */
export function Card({ title, subtitle, actions, selected, hover, padded = true, className, style, id, children, ...aria }: CardProps) {
  return (
    <section id={id} aria-label={aria['aria-label']} className={`bf-card${selected ? ' bf-card--selected' : ''}${hover ? ' bf-card--hover' : ''}${className ? ` ${className}` : ''}`} style={style}>
      {title || actions ? (
        <div className="bf-card__header">
          <div className="bf-card__heading">
            {title ? <h2 className="t-h3">{title}</h2> : null}
            {subtitle ? <p className="t-small bf-card__subtitle">{subtitle}</p> : null}
          </div>
          {actions ? <div className="bf-card__actions">{actions}</div> : null}
        </div>
      ) : null}
      <div className={padded ? 'bf-card__body' : undefined}>{children}</div>
    </section>
  );
}
