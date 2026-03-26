export class CooldownWindow {
  private readonly blockedUntil = new Map<string, number>();

  public block(id: string, durationMs: number): number {
    const until = Date.now() + durationMs;
    this.blockedUntil.set(id, until);
    return until;
  }

  public clear(id: string): void {
    this.blockedUntil.delete(id);
  }

  public isBlocked(id: string, now = Date.now()): boolean {
    const until = this.blockedUntil.get(id);
    if (!until) {
      return false;
    }

    if (until <= now) {
      this.blockedUntil.delete(id);
      return false;
    }

    return true;
  }

  public remainingMs(id: string, now = Date.now()): number {
    const until = this.blockedUntil.get(id);
    if (!until) {
      return 0;
    }

    return Math.max(0, until - now);
  }
}
