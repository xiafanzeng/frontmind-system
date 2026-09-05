import { KolProviderError } from "./errors.js";

interface TokenValue {
  value: string;
  expiresAt?: number;
}

export class KolTokenCache {
  private current?: TokenValue;
  private inFlight?: Promise<TokenValue>;
  private blocked = false;

  constructor(
    private readonly authenticate: (signal?: AbortSignal) => Promise<string>,
    private readonly options: {
      refreshSkewMs: number;
      now: () => Date;
    },
  ) {}

  async getToken(
    input: {
      forceRefresh?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<string> {
    if (this.blocked && !input.forceRefresh) {
      throw new KolProviderError(
        "authentication_blocked",
        "KOL authentication is blocked until a deliberate safe refresh succeeds",
        { operation: "authenticate" },
      );
    }
    if (!input.forceRefresh && this.usable(this.current))
      return this.current.value;
    this.inFlight ??= this.authenticate(input.signal)
      .then((value) => ({ value, expiresAt: jwtExpiry(value) }))
      .finally(() => {
        this.inFlight = undefined;
      });
    try {
      const token = await this.inFlight;
      this.current = token;
      this.blocked = false;
      return token.value;
    } catch (error) {
      this.blocked = true;
      throw error;
    }
  }

  invalidate(): void {
    this.current = undefined;
  }

  block(): void {
    this.current = undefined;
    this.blocked = true;
  }

  private usable(value: TokenValue | undefined): value is TokenValue {
    return Boolean(
      value &&
      (value.expiresAt === undefined ||
        value.expiresAt - this.options.refreshSkewMs >
          this.options.now().valueOf()),
    );
  }
}

function jwtExpiry(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as { exp?: unknown };
    return typeof decoded.exp === "number" && Number.isFinite(decoded.exp)
      ? decoded.exp * 1_000
      : undefined;
  } catch {
    return undefined;
  }
}
