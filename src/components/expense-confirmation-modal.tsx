"use client";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";

export default function ExpenseConfirmationModal({
  open,
  locked,
  returnFocusRef,
  onCancel,
  children,
}: {
  open: boolean;
  locked: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  onCancel: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return;
    dialog.showModal();
    dialog.querySelector<HTMLHeadingElement>("h2")?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      dialog.close();
      document.body.style.overflow = previous;
      requestAnimationFrame(() => {
        if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
      });
    };
  }, [open, returnFocusRef]);
  return (
    <dialog
      ref={ref}
      className="payment-modal expense-confirmation-modal"
      aria-labelledby="confirm-import-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!locked) onCancel();
      }}
    >
      {children}
    </dialog>
  );
}
