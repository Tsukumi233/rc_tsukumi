export type LogFields = Partial<{
  notificationId: string;
  callerId: string;
  status: string;
  errorCode: string;
  attempt: number;
  durationMs: number;
  httpStatus: number | null;
  count: number;
  pending: number;
  inFlight: number;
  succeeded: number;
  dead: number;
  oldestPendingSeconds: number;
  port: number;
}>;

// Do not pass arbitrary errors, URLs, headers or payloads to the logger.
export function log(event: string, fields: LogFields = {}): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
}
