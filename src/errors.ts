export class RequestError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: 400 | 401 | 403 | 409 | 413,
  ) {
    super(code);
  }
}
export class DeliveryError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(code);
  }
}
