import { randomBytes } from "node:crypto";

export class SetupTokenManager {
  private readonly tokens = new Map<string, number>();

  constructor(private readonly ttlMs = 15 * 60_000) {}

  public create(): string {
    const token = randomBytes(24).toString("hex");
    this.tokens.set(token, Date.now() + this.ttlMs);
    return token;
  }

  public isValid(token: string | undefined): boolean {
    if (!token) {
      return false;
    }

    const expiresAt = this.tokens.get(token);
    if (!expiresAt) {
      return false;
    }

    if (expiresAt <= Date.now()) {
      this.tokens.delete(token);
      return false;
    }

    return true;
  }
}
