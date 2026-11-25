import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import "./atlas-toolbar.css";

interface ToolbarDisclosureProps {
  label: string;
  className?: string;
  description?: string;
  icon: ReactNode;
  summary?: ReactNode;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  children: (close: () => void) => ReactNode;
}

export function ToolbarDisclosure({ label, className, description, icon, summary, triggerRef, children }: ToolbarDisclosureProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const localTrigger = useRef<HTMLButtonElement>(null);
  const trigger = triggerRef ?? localTrigger;
  const panel = useRef<HTMLDivElement>(null);

  function close() {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }

  useLayoutEffect(() => {
    if (!open) return;
    const body = panel.current;
    const first = body?.querySelector<HTMLElement>(
      "button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]",
    );
    (first ?? body)?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;

    function dismissOutside(event: PointerEvent) {
      if (!(event.target instanceof Node) || !root.current?.contains(event.target)) setOpen(false);
    }

    document.addEventListener("pointerdown", dismissOutside, true);
    return () => document.removeEventListener("pointerdown", dismissOutside, true);
  }, [open]);

  return (
    <div
      className={className ? `atlas-toolbar-disclosure ${className}` : "atlas-toolbar-disclosure"}
      ref={root}
      onBlur={(event) => {
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false);
        }
      }}
      onKeyDown={(event) => {
        if (!open || event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      <button
        className="atlas-toolbar-button"
        id={`${id}-trigger`}
        ref={trigger}
        type="button"
        aria-label={label}
        aria-describedby={description ? `${id}-description` : undefined}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title={label}
        onClick={() => {
          if (open) close();
          else setOpen(true);
        }}
      >
        {icon}
        {summary != null && <span className="atlas-toolbar-label">{summary}</span>}
      </button>
      {description && <span id={`${id}-description`} hidden>{description}</span>}
      {open && (
        <div
          className="atlas-toolbar-panel"
          id={id}
          ref={panel}
          role="group"
          aria-labelledby={`${id}-trigger`}
          tabIndex={-1}
        >
          {children(close)}
        </div>
      )}
    </div>
  );
}
