export class TestContext {
  userId: string | null = null;
  sessionId: number | null = null;
  activeTraceId: string | null = null;
  savedSittingAlertMinutes: number | null = null;
  lastResponse: unknown = null;

  reset(): void {
    this.userId = null;
    this.sessionId = null;
    this.activeTraceId = null;
    this.savedSittingAlertMinutes = null;
    this.lastResponse = null;
  }
}
