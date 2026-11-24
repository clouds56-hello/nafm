import { useId, useLayoutEffect, useRef, useState } from "react";
import type { DirectorySort } from "../lib/types";

const fieldLabels = { size: "Size", name: "Name", date: "Date modified" } satisfies Record<DirectorySort["field"], string>;
const directionLabels = { asc: "Ascending", desc: "Descending" } satisfies Record<DirectorySort["direction"], string>;

function SortGroup<T extends string>({ title, labels, value, onSelect }: {
  title: string;
  labels: Record<T, string>;
  value: T;
  onSelect: (value: T) => void;
}) {
  const id = useId();
  return (
    <fieldset role="radiogroup" aria-labelledby={id}>
      <legend id={id}>{title}</legend>
      <div className="atlas-sort-choices">
        {(Object.keys(labels) as T[]).map((key) => (
          <label key={key}>
            <input type="radio" name={id} value={key} checked={value === key} onChange={() => onSelect(key)} />
            <span>{labels[key]}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function DirectorySortControl({ sort, onChange }: {
  sort: DirectorySort;
  onChange: (sort: DirectorySort) => Promise<void>;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<DirectorySort | null>(null);
  const selected = pending ?? sort;

  async function choose(next: DirectorySort) {
    setPending(next);
    try {
      await onChange(next);
    } finally {
      setPending((current) => current === next ? null : current);
    }
  }

  useLayoutEffect(() => {
    const button = trigger.current;
    const popup = panel.current;
    if (!open || !button || !popup) return;
    popup.showPopover?.();
    const position = () => {
      const anchor = button.getBoundingClientRect();
      const { width } = popup.getBoundingClientRect();
      const gap = 6;
      const edge = 8;
      const below = window.innerHeight - anchor.bottom - gap - edge;
      const above = anchor.top - gap - edge;
      const openAbove = popup.scrollHeight + 2 > below && above > below;
      popup.style.maxHeight = Math.max(0, openAbove ? above : below) + "px";
      popup.style.top = (openAbove ? anchor.top - gap - popup.offsetHeight : anchor.bottom + gap) + "px";
      popup.style.left = Math.max(edge, Math.min(anchor.right - width, window.innerWidth - edge - width)) + "px";
    };
    const dismissOutside = (event: Event) => {
      if (event.target instanceof Node && !popup.contains(event.target) && !button.contains(event.target)) {
        setOpen(false);
      }
    };
    position();
    popup.querySelector<HTMLInputElement>("input:checked")?.focus({ preventScroll: true });
    window.addEventListener("resize", position);
    document.addEventListener("scroll", position, true);
    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("focusin", dismissOutside);
    return () => {
      window.removeEventListener("resize", position);
      document.removeEventListener("scroll", position, true);
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("focusin", dismissOutside);
    };
  }, [open]);

  return (
    <div onMouseDown={(event) => {
      // WebKit can focus the enclosing scroll pane before a radio receives its click.
      if (event.button === 0) {
        event.preventDefault();
        if (event.target instanceof Element) {
          event.target.closest<HTMLElement>("button, input")?.focus({ preventScroll: true });
        }
      }
    }} onKeyDown={(event) => {
      if (!open || event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus({ preventScroll: true });
    }}>
      <button
        ref={trigger} type="button" className="atlas-directory-sort"
        aria-label="Sort contents" aria-expanded={open} aria-controls={open ? id : undefined} aria-haspopup="dialog"
        title={fieldLabels[selected.field] + ", " + directionLabels[selected.direction].toLowerCase()}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (!open && event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 4h6M2 8h4M2 12h2M12 3v10" />
          <path d={selected.direction === "desc" ? "m9 10 3 3 3-3" : "m9 6 3-3 3 3"} />
        </svg>
        {selected.field === "date" ? "Modified" : fieldLabels[selected.field]}
        <span aria-hidden="true" className="atlas-sort-chevron" />
      </button>
      {open && (
        <div id={id} ref={panel} className="atlas-sort-popover" role="dialog" aria-label="Sort contents" popover="manual">
          <SortGroup title="Sort by" labels={fieldLabels} value={selected.field}
            onSelect={(field) => void choose({ ...selected, field })} />
          <SortGroup title="Direction" labels={directionLabels} value={selected.direction}
            onSelect={(direction) => void choose({ ...selected, direction })} />
        </div>
      )}
    </div>
  );
}
