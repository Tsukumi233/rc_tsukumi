export type Status = 'pending' | 'in_flight' | 'succeeded' | 'dead';
export interface Envelope {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers: Record<string, string>;
  body: string | null;
}
export interface DeliveryResult {
  outcome: 'http_success' | 'retryable_error' | 'permanent_error';
  httpStatus: number | null;
  errorCode: string | null;
  durationMs: number;
  retryDelayMs: number;
  retryNotBefore?: Date;
}

export type DeliveryTask = Envelope & { id: string; caller_id: string; attempt_count: number };
