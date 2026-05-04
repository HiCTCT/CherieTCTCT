/**
 * Token redaction helpers for the Meta provider.
 *
 * Rules enforced here:
 *  - access_token values are never printed raw in any string
 *  - ad_snapshot_url values containing access_token are never printed raw
 *  - paging.next is never passed to these functions at all (callers discard it)
 *  - All URL-shaped fields in log output go through safeUrlLabel()
 *  - All error messages go through redactToken() before printing
 */

/**
 * Replaces the value of any `access_token` query parameter in a string
 * with `REDACTED`. Safe to call on full URLs or partial strings.
 *
 * Example:
 *   "...&access_token=EAAxxxYYY&other=1"
 *   → "...&access_token=REDACTED&other=1"
 */
export function redactToken(value: string): string {
  return value.replace(/access_token=[^&\s"']*/gi, 'access_token=REDACTED');
}

/**
 * Returns a safe label for a URL that may contain an access_token.
 *
 * - If the URL contains `access_token=`, returns 'present (token redacted)'
 * - If the URL is absent or empty, returns 'N/A'
 * - Otherwise returns the URL as-is (no token present)
 *
 * Used for ad_snapshot_url and Ad Link fields in log output.
 */
export function safeUrlLabel(url: string | undefined | null): string {
  if (!url) return 'N/A';
  if (/access_token=/i.test(url)) return 'present (token redacted)';
  return url;
}

/**
 * Logs a labelled URL field safely.
 * Convenience wrapper so callers never need to remember to call safeUrlLabel.
 */
export function safeLog(label: string, url: string | undefined | null): void {
  console.log(`${label}${safeUrlLabel(url)}`);
}
