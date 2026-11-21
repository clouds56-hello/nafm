const sizes = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const counts = new Intl.NumberFormat();
const units = ["B", "KB", "MB", "GB", "TB", "PB"];

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const unit = Math.min(units.length - 1, Math.max(0, Math.floor(Math.log2(bytes) / 10)));
  return `${sizes.format(bytes / 1024 ** unit)} ${units[unit]}`;
}

export function formatCount(count: number): string {
  return counts.format(count);
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}
