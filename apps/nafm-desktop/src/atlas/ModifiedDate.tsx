import type { StorageNode } from "../lib/types";

const shortDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const fullDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function ModifiedDate({ node, compact = false }: { node: StorageNode; compact?: boolean }) {
  const time = node.modified_unix_millis;
  const date = time == null ? null : new Date(time);
  if (!date || !Number.isFinite(date.getTime())) return <>Date unavailable</>;
  return <time dateTime={date.toISOString()}>{(compact ? shortDate : fullDate).format(date)}</time>;
}
