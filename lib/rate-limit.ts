import { isIP } from "node:net";

const WINDOW_MS = 60_000;
const CAPACITY = 10;
const MAX_CREDIT = WINDOW_MS * CAPACITY;

interface Bucket {
  credit: number;
  updatedAt: number;
}

// The proxy must replace untrusted X-Forwarded-For before reaching the app.
export function linkClientKey(headers: Headers): string {
  const candidate = headers.get("x-forwarded-for")?.split(",", 1)[0].trim();
  if (!candidate || candidate.includes("%") || !isIP(candidate)) return "unknown";
  return isIP(candidate) === 6
    ? new URL(`http://[${candidate}]/`).hostname
    : candidate;
}

export class LinkRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private nextPruneAt = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  // Returns zero when admitted, otherwise the delay until a token is available.
  consume(key: string): number {
    const now = this.now();
    if (now >= this.nextPruneAt) {
      for (const [storedKey, bucket] of this.buckets) {
        if (now - bucket.updatedAt >= WINDOW_MS) this.buckets.delete(storedKey);
      }
      this.nextPruneAt = now + WINDOW_MS;
    }

    let bucket = this.buckets.get(key);
    if (!bucket) {
      // Do not evict a live bucket: rotating addresses must not reset its limit.
      if (this.buckets.size >= this.maxKeys) return WINDOW_MS;
      bucket = { credit: MAX_CREDIT, updatedAt: now };
      this.buckets.set(key, bucket);
    }
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.credit = Math.min(MAX_CREDIT, bucket.credit + elapsed * CAPACITY);
    bucket.updatedAt = Math.max(now, bucket.updatedAt);
    if (bucket.credit < WINDOW_MS) {
      return Math.ceil((WINDOW_MS - bucket.credit) / CAPACITY);
    }
    bucket.credit -= WINDOW_MS;
    return 0;
  }
}

const globals = globalThis as typeof globalThis & {
  __demeuLinkRateLimiter?: LinkRateLimiter;
};

export function linkRateLimiter(): LinkRateLimiter {
  return (globals.__demeuLinkRateLimiter ??= new LinkRateLimiter());
}
