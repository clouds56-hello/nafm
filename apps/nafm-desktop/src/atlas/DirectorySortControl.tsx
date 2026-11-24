import type { DirectorySort } from "../lib/types";

const orders = [
  { field: "size", direction: "desc", label: "Size, largest first" },
  { field: "size", direction: "asc", label: "Size, smallest first" },
  { field: "name", direction: "asc", label: "Name, A to Z" },
  { field: "name", direction: "desc", label: "Name, Z to A" },
  { field: "date", direction: "desc", label: "Date modified, newest first" },
  { field: "date", direction: "asc", label: "Date modified, oldest first" },
] as const satisfies ReadonlyArray<DirectorySort & { label: string }>;

const fieldLabels = { size: "Size", name: "Name", date: "Modified" };

export function DirectorySortControl({ sort, onChange }: { sort: DirectorySort; onChange: (sort: DirectorySort) => void }) {
  const value = `${sort.field}-${sort.direction}`;
  return (
    <label className="atlas-directory-sort">
      <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 4h6M2 8h4M2 12h2M12 3v10" />
        <path d={sort.direction === "desc" ? "m9 10 3 3 3-3" : "m9 6 3-3 3 3"} />
      </svg>
      <span aria-hidden="true">{fieldLabels[sort.field]}</span>
      <select
        aria-label="Sort contents"
        value={value}
        onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }}
        onChange={(event) => {
          const order = orders.find(({ field, direction }) => `${field}-${direction}` === event.currentTarget.value);
          if (order) onChange({ field: order.field, direction: order.direction });
        }}
      >
        {orders.map(({ field, direction, label }) => (
          <option key={label} value={`${field}-${direction}`}>{label}</option>
        ))}
      </select>
    </label>
  );
}
