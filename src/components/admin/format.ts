// Shared formatters for admin panels.

/** Localized integer with a "—" dash for null/undefined: 1234 → "1,234". */
export const formatCount = (n: number | null | undefined, suffix = ""): string =>
  n != null ? `${n.toLocaleString()}${suffix}` : "—";

/** ISO date → local date, or "—" for null. */
export const formatDate = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleDateString() : "—";

/** ISO timestamp → local date+time. */
export const formatDateTime = (iso: string): string => new Date(iso).toLocaleString();

/** Human-readable byte size (1024-based): 1536 → "1.5 KB". */
export function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const decimals = i > 0 && v < 10 ? 1 : 0;
  return `${v.toFixed(decimals)} ${units[i]}`;
}
