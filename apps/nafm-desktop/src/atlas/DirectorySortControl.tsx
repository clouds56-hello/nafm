import { useId, type KeyboardEventHandler } from "react";
import type { DirectorySort } from "../lib/types";
import { useAnchoredPopover } from "./useAnchoredPopover";

const fieldLabels = { size: "Size", name: "Name", date: "Date modified" } satisfies Record<DirectorySort["field"], string>;
const directionLabels = { asc: "Ascending", desc: "Descending" } satisfies Record<DirectorySort["direction"], string>;

const pendingLabels = {
  size: { asc: "Sorting smallest first…", desc: "Sorting largest first…" },
  name: { asc: "Sorting A–Z…", desc: "Sorting Z–A…" },
  date: { asc: "Sorting oldest first…", desc: "Sorting newest first…" },
} satisfies Record<DirectorySort["field"], Record<DirectorySort["direction"], string>>;

export function pendingSortLabel(sort: DirectorySort) {
  return pendingLabels[sort.field][sort.direction];
}

function SortGroup<T extends string>({ title, labels, value, onSelect, onKeyDown, sorting }: {
  title: string;
  labels: Record<T, string>;
  value: T;
  onSelect: (value: T) => void;
  onKeyDown?: KeyboardEventHandler<HTMLFieldSetElement>;
  sorting?: boolean;
}) {
  const id = useId();
  return (
    <fieldset role="radiogroup" aria-labelledby={id} onKeyDown={onKeyDown}>
      <legend><span id={id}>{title}</span>{sorting && <small aria-hidden="true">Sorting…</small>}</legend>
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

export function DirectorySortControl({ sort, pendingSort, progressId, onChange }: {
  sort: DirectorySort;
  pendingSort?: DirectorySort;
  progressId?: string;
  onChange: (sort: DirectorySort) => Promise<void>;
}) {
  const id = useId();
  const { open, trigger, panel, show, close, toggle, containerProps } = useAnchoredPopover("input:checked");
  const selected = pendingSort ?? sort;

  return (
    <div {...containerProps}>
      <button
        ref={trigger} type="button" className="atlas-directory-sort"
        aria-label="Sort contents" aria-expanded={open} aria-controls={open ? id : undefined} aria-haspopup="dialog"
        aria-describedby={progressId}
        title={fieldLabels[sort.field] + ", " + directionLabels[sort.direction].toLowerCase()}
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
          <path d={sort.direction === "desc" ? "m9 10 3 3 3-3" : "m9 6 3-3 3 3"} />
        </svg>
        {sort.field === "date" ? "Modified" : fieldLabels[sort.field]}
        <span aria-hidden="true" className="atlas-sort-chevron" />
      </button>
      {open && (
        <div id={id} ref={panel} className="atlas-sort-popover" role="dialog" aria-label="Sort contents" aria-describedby={progressId} popover="manual">
          <SortGroup title="Sort by" labels={fieldLabels} value={selected.field} sorting={Boolean(pendingSort)}
            onSelect={(field) => void onChange({ ...selected, field })}
            onKeyDown={(event) => {
              if (event.key !== "Tab" || !event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return;
              event.preventDefault();
              close(true);
            }}
          />
          <SortGroup title="Direction" labels={directionLabels} value={selected.direction}
            onSelect={(direction) => void onChange({ ...selected, direction })} />
        </div>
      )}
    </div>
  );
}
