import { useId, useState, type KeyboardEventHandler } from "react";
import type { DirectorySort } from "../lib/types";
import { useAnchoredPopover } from "./useAnchoredPopover";

const fieldLabels = { size: "Size", name: "Name", date: "Date modified" } satisfies Record<DirectorySort["field"], string>;
const directionLabels = { asc: "Ascending", desc: "Descending" } satisfies Record<DirectorySort["direction"], string>;

function SortGroup<T extends string>({ title, labels, value, onSelect, onKeyDown }: {
  title: string;
  labels: Record<T, string>;
  value: T;
  onSelect: (value: T) => void;
  onKeyDown?: KeyboardEventHandler<HTMLFieldSetElement>;
}) {
  const id = useId();
  return (
    <fieldset role="radiogroup" aria-labelledby={id} onKeyDown={onKeyDown}>
      <legend id={id}>{title}</legend>
      <div className="atlas-sort-choices">
        {(Object.keys(labels) as T[]).map((key) => (
          <label key={key}>
            <input
              type="radio" name={id} value={key} checked={value === key}
              tabIndex={value === key ? 0 : -1} onChange={() => onSelect(key)}
            />
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
  const { open, trigger, panel, show, close, toggle, containerProps } = useAnchoredPopover("input:checked");
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

  return (
    <div {...containerProps}>
      <button
        ref={trigger} type="button" className="atlas-directory-sort"
        aria-label="Sort contents" aria-expanded={open} aria-controls={open ? id : undefined} aria-haspopup="dialog"
        title={fieldLabels[selected.field] + ", " + directionLabels[selected.direction].toLowerCase()}
        onClick={toggle}
        onKeyDown={(event) => {
          if (!open && event.key === "ArrowDown") {
            event.preventDefault();
            show();
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
            onSelect={(field) => void choose({ ...selected, field })}
            onKeyDown={(event) => {
              if (event.key !== "Tab" || !event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return;
              event.preventDefault();
              close(true);
            }}
          />
          <SortGroup title="Direction" labels={directionLabels} value={selected.direction}
            onSelect={(direction) => void choose({ ...selected, direction })} />
        </div>
      )}
    </div>
  );
}
