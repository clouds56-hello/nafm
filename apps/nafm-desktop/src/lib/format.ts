const bytes = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const integers = new Intl.NumberFormat();
const fileEquivalents = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const unitIndex = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${bytes.format(value / 1024 ** unitIndex)} ${units[unitIndex]}`;
}

export function formatCount(value: number): string {
  return integers.format(value);
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

export function fileName(path: string): string {
  const segments = path.replaceAll("\\", "/").split("/").filter(Boolean);
  return segments.at(-1) ?? path;
}

export function percent(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.min(100, Math.max(0, (numerator / denominator) * 100)) : 0;
}

export function formatHealth(value: number | null): string {
  return value === null ? "—" : `${Math.round(Math.min(100, Math.max(0, value)))}`;
}

export function formatFileEquivalent(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return fileEquivalents.format(value);
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
