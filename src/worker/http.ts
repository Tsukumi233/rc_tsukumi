import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { performance } from 'node:perf_hooks';
import type { Config } from '../config.js';
import type { DeliveryResult, DeliveryTask } from '../domain.js';
import { DeliveryError, RequestError } from '../errors.js';
import { assertTargetAllowed, safeLookup } from '../target.js';

export function retryAfter(value: string | undefined): { delayMs: number; date?: Date } {
  if (!value) return { delayMs: 0 };
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    // Saturate at a safely representable value; never shorten to the retry cap.
    return { delayMs: Math.min(Number(trimmed) * 1000, 10 * 365 * 86400000) };
  }
  // HTTP-date supports IMF-fixdate and the two obsolete wire formats. Do not
  // interpret arbitrary strings such as an ISO date as a scheduling command.
  const httpDate =
    /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-[A-Z][a-z]{2}-\d{2} \d{2}:\d{2}:\d{2} GMT|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/;
  if (!httpDate.test(trimmed)) return { delayMs: 0 };
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? { delayMs: 0, date: new Date(parsed) } : { delayMs: 0 };
}

export async function deliver(task: DeliveryTask, config: Config): Promise<DeliveryResult> {
  const start = performance.now();
  const result = (fields: Omit<DeliveryResult, 'durationMs'>): DeliveryResult => ({
    ...fields,
    durationMs: Math.round(performance.now() - start),
  });
  try {
    const caller = config.callers.find((c) => c.id === task.caller_id);
    if (!caller) throw new DeliveryError('caller_removed', false);
    const url = assertTargetAllowed(task.url, caller, config);
    const response = await new Promise<{ status: number; retryAfter?: string }>(
      (resolve, reject) => {
        const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
        const req = request(
          url,
          {
            method: task.method,
            headers: task.headers,
            agent: false,
            lookup: safeLookup(config.allowPrivateTargets),
            maxHeaderSize: 16 * 1024,
            signal: AbortSignal.timeout(config.httpTimeoutMs),
          },
          (res) => {
            resolve({ status: res.statusCode!, retryAfter: res.headers['retry-after'] });
            // Only final response headers are relevant. Do not buffer untrusted bodies.
            res.on('error', () => {});
            res.destroy();
          },
        );
        req.on('error', reject);
        req.on('upgrade', (_res, socket) => {
          socket.destroy();
          reject(new DeliveryError('unexpected_upgrade', false));
        });
        req.end(task.body ?? undefined);
      },
    );
    const success = response.status >= 200 && response.status < 300;
    const canRetry = [408, 429].includes(response.status) || response.status >= 500;
    const retry = retryAfter(response.retryAfter);
    return result({
      outcome: success ? 'http_success' : canRetry ? 'retryable_error' : 'permanent_error',
      httpStatus: response.status,
      errorCode: success ? null : `http_${response.status}`,
      retryDelayMs: retry.delayMs,
      retryNotBefore: retry.date,
    });
  } catch (error) {
    let code = 'network_error';
    let retryable = true;
    if (error instanceof DeliveryError) {
      code = error.code;
      retryable = error.retryable;
    } else if (error instanceof RequestError) {
      code = 'target_not_allowed';
      retryable = false;
    } else {
      const original = (error as NodeJS.ErrnoException)?.code ?? '';
      if (original === 'ABORT_ERR') code = 'timeout';
      else if (
        [
          'ENOTFOUND',
          'ERR_INVALID_URL',
          'ERR_INVALID_HTTP_TOKEN',
          'ERR_HTTP_INVALID_HEADER_VALUE',
        ].includes(original)
      ) {
        code = 'invalid_destination';
        retryable = false;
      } else if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(original)) {
        code = 'tls_error';
        retryable = false;
      }
    }
    return result({
      outcome: retryable ? 'retryable_error' : 'permanent_error',
      httpStatus: null,
      errorCode: code,
      retryDelayMs: 0,
    });
  }
}
