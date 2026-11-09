"use client";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";

export default function PaymentModal({
  open,
  locked,
  step,
  returnFocusRef,
  onCancel,
  children,
}: {
  open: boolean;
  locked: boolean;
  step: string;
  returnFocusRef: RefObject<HTMLElement | null>;
  onCancel: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
    return () => {
      if (dialog.open) dialog.close();
      requestAnimationFrame(() => {
        if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
      });
    };
  }, [open, returnFocusRef]);
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);
  useEffect(() => {
    if (open) ref.current?.querySelector<HTMLHeadingElement>("h2")?.focus();
  }, [open, step]);
  return (
    <dialog
      ref={ref}
      className="payment-modal"
      aria-labelledby="payment-modal-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!locked) onCancel();
      }}
    >
      <button
        className="payment-modal-close"
        type="button"
        aria-label="Cerrar"
        disabled={locked}
        onClick={onCancel}
      >
        <span aria-hidden="true">×</span>
      </button>
      {children}
    </dialog>
  );
}
