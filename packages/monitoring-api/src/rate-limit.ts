type Bucket = { failures: number[] };

export class LoginRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  constructor(
    private readonly maxFailures = 5,
    private readonly windowMs = 15 * 60_000,
  ) {}

  canAttempt(key: string, now = Date.now()): boolean {
    return this.prune(key, now).failures.length < this.maxFailures;
  }

  recordFailure(key: string, now = Date.now()): void {
    const bucket = this.prune(key, now);
    bucket.failures.push(now);
    this.buckets.set(key, bucket);
  }

  clear(key: string): void {
    this.buckets.delete(key);
  }

  private prune(key: string, now: number): Bucket {
    const bucket = this.buckets.get(key) ?? { failures: [] };
    bucket.failures = bucket.failures.filter(
      (timestamp) => timestamp > now - this.windowMs,
    );
    if (bucket.failures.length === 0) this.buckets.delete(key);
    return bucket;
  }
}
