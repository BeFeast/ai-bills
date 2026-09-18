'use client';

import { useEffect, useRef, type ReactNode, type SyntheticEvent } from 'react';

type DialogProps = {
  open: boolean;
  title: ReactNode;
  titleId?: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** Called when the user dismisses (Escape, scrim click, close button). Not called while `busy`. */
  onClose: () => void;
  busy?: boolean;
};

/** Native <dialog> (focus trap, Escape) dressed in the BeFeast dialog recipe with a blurred scrim. */
export function Dialog({ open, title, titleId = 'bf-dialog-title', description, children, footer, onClose, busy }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    else if (!open && node.open) node.close();
  }, [open]);
  function cancel(event: SyntheticEvent<HTMLDialogElement>) {
    event.preventDefault();
    if (!busy) onClose();
  }
  return (
    <dialog ref={ref} className="bf-dialog" aria-labelledby={titleId} onCancel={cancel} onClick={(event) => { if (event.target === event.currentTarget) cancel(event); }}>
      {open ? (
        <div className="bf-dialog__inner">
          <h2 id={titleId} className="t-h2 bf-dialog__title">{title}</h2>
          {description ? <p className="t-small bf-dialog__description">{description}</p> : null}
          {children}
          {footer ? <div className="bf-dialog__footer">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}
