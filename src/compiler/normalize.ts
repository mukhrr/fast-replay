/**
 * Path segments that are volatile between runs. Recording `/api/sensors/4` and
 * replaying against `/api/sensors/9` must still match, so identifiers collapse
 * to `*` on both sides.
 */
const VOLATILE_SEGMENT = [
  /^\d+$/, // numeric id
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // uuid
  /^[0-9a-f]{12,}$/i, // hex blob
  /^[A-Za-z0-9_-]{16,}$/, // opaque token / nanoid
];

function normalizeSegment(seg: string): string {
  if (!seg) return seg;
  return VOLATILE_SEGMENT.some((re) => re.test(seg)) ? '*' : seg;
}

/**
 * Reduce a URL to a stable pattern. Same-origin URLs become an origin-relative
 * path so a repro survives a different dev-server port; cross-origin URLs keep
 * their origin so third-party traffic stays distinguishable.
 *
 * The query string is dropped: it is dominated by cache-busters and is almost
 * never what identifies an endpoint.
 */
export function normalizeUrlPattern(url: string, baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  const path = parsed.pathname.split('/').map(normalizeSegment).join('/') || '/';

  let sameOrigin = false;
  try {
    sameOrigin = parsed.origin === new URL(baseUrl).origin;
  } catch {
    sameOrigin = false;
  }

  return sameOrigin ? path : `${parsed.origin}${path}`;
}

export function isSameOrigin(url: string, baseUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '[^/]+');
  return new RegExp(`^${escaped}$`);
}

/**
 * Does a live URL satisfy a recorded pattern? Compared after normalization so
 * generated ids line up, and also as a glob so a hand-edited IR can widen a
 * pattern with `*` and have it behave the way a reader would expect.
 */
export function matchesUrlPattern(url: string, pattern: string, baseUrl: string): boolean {
  const normalized = normalizeUrlPattern(url, baseUrl);
  if (normalized === pattern) return true;

  let rawPath = url;
  try {
    const parsed = new URL(url);
    rawPath = isSameOrigin(url, baseUrl) ? parsed.pathname : `${parsed.origin}${parsed.pathname}`;
  } catch {
    /* keep the raw string */
  }

  const re = globToRegExp(pattern);
  return re.test(normalized) || re.test(rawPath);
}
