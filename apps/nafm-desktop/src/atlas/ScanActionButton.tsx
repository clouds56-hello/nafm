import type { ComponentProps } from "react";

interface ScanActionButtonProps extends Omit<ComponentProps<"button">, "aria-disabled" | "onClick" | "onKeyDown" | "type"> {
  unavailable: boolean;
  onActivate: () => void;
}

export function ScanActionButton({ unavailable, onActivate, ...props }: ScanActionButtonProps) {
  return (
    <button
      {...props}
      type="button"
      aria-disabled={unavailable || undefined}
      onKeyDown={(event) => {
        // The focused control can change from Scan to Stop while Enter is still held.
        if (event.key === "Enter" && event.repeat) event.preventDefault();
      }}
      onClick={(event) => {
        event.currentTarget.focus({ preventScroll: true });
        if (unavailable || event.detail > 1) return;
        onActivate();
      }}
    />
  );
}
