// All user-visible dates/times render in Pacific regardless of the viewer's
// locale. Keep this single source of truth so we never drift per-component.
export const DISPLAY_TZ = "America/Los_Angeles";

/**
 * Origin for the "All" time range: start of the company's operating period.
 * Anything older than this is out of scope for the dashboard.
 */
export const ALL_TIME_ORIGIN = "2025-10-20T00:00:00.000Z";

/** YYYY-MM-DD in Pacific — used as a stable grouping key for "By day". */
export function pacificDayKey(iso: string): string {
  // en-CA produces YYYY-MM-DD; date-part only.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DISPLAY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/** "Today" / "Yesterday" / "Mon, Apr 21" — header for a given YYYY-MM-DD key. */
export function formatPacificDayHeader(key: string): string {
  const today = pacificDayKey(new Date().toISOString());
  if (key === today) return "Today";
  // Compute yesterday in Pacific.
  const yesterdayIso = new Date(Date.now() - 86_400_000).toISOString();
  if (key === pacificDayKey(yesterdayIso)) return "Yesterday";

  // Build a Date at Pacific midnight for that YYYY-MM-DD to format a nice label.
  const [y, m, d] = key.split("-").map(Number);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: DISPLAY_TZ,
    weekday: "long",
    month: "short",
    day: "numeric",
  }).formatToParts(new Date(Date.UTC(y, m - 1, d, 12)));
  return parts.map((p) => p.value).join("");
}

/** Short timestamp used in the feature detail log. */
export function formatPacific(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: DISPLAY_TZ,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}
