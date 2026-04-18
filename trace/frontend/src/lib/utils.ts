/**
 * Shared formatting utilities for the Trace frontend.
 */

/**
 * Formats an ISO timestamp string to HH:MM:SS local time.
 * Returns '—' when the value is absent or unparseable.
 */
export function formatTimestamp(value?: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * Formats a latency value (milliseconds).
 * - 0 / undefined → '—'
 * - < 1 ms → 'NNN µs'
 * - ≥ 1 ms → 'N.N ms'
 */
export function formatLatencyMs(ms?: number | null): string {
  if (!ms || ms <= 0) return '—';
  if (ms < 1) return `${(ms * 1000).toFixed(0)} µs`;
  return `${ms.toFixed(1)} ms`;
}

/**
 * Returns a CSS class name for a latency value used for colour-coding cells.
 * Thresholds: ok < 50 ms, warn < 200 ms, crit ≥ 200 ms.
 */
export function latencyClass(ms?: number | null): string {
  if (!ms || ms <= 0) return '';
  if (ms < 50) return 'latency-ok';
  if (ms < 200) return 'latency-warn';
  return 'latency-crit';
}
