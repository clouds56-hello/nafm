const sizes = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const counts = new Intl.NumberFormat();
const hundredths = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
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

export function formatRelativeTime(value: string | null): string {
  if (!value) return "Not scanned yet";
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return "Unknown";
  const delta = timestamp - Date.now();
  const minutes = Math.round(delta / 60_000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

export function percent(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.min(100, Math.max(0, (numerator / denominator) * 100)) : 0;
}

// A value below the maximum must stay distinguishable even at the display's precision limit.
function formatBelowMaximum(value: number, maximum: number, formatter: Intl.NumberFormat): string {
  const label = formatter.format(value);
  return label === formatter.format(maximum) ? `<${label}` : label;
}

export function formatHealth(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value >= 99.5 && value < 100) return formatBelowMaximum(value, 100, hundredths);
  return counts.format(Math.round(Math.min(100, Math.max(0, value))));
}

export function formatFileEquivalent(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return hundredths.format(value);
}

export function healthColor(value: number | null, intensity = 1): string {
  const neutral = [107, 116, 124];
  if (value === null) return `rgb(${neutral.join(" ")})`;
  const clamped = Math.min(100, Math.max(0, value));
  const [from, to, amount] = clamped <= 50
    ? [[245, 112, 111], [240, 184, 91], clamped / 50]
    : [[240, 184, 91], [91, 219, 194], (clamped - 50) / 50];
  const healthChannels = from.map((channel, index) => channel + (to[index] - channel) * amount);
  const blend = Math.min(1, Math.max(0, intensity));
  const channels = healthChannels.map((channel, index) => (
    Math.round(neutral[index] + (channel - neutral[index]) * blend)
  ));
  return `rgb(${channels.join(" ")})`;
}

const percentage = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 });
const precisePercentage = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 2 });

export function formatShare(bytes: number, parentBytes: number) {
  if (parentBytes === 0) return "—";
  const ratio = Math.min(1, bytes / parentBytes);
  if (bytes < parentBytes && ratio >= 0.995) return formatBelowMaximum(ratio, 1, precisePercentage);
  return ratio > 0 && ratio < 0.001 ? `<${percentage.format(0.001)}` : percentage.format(ratio);
}
