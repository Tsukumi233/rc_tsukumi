import { lookup as dnsLookup } from 'node:dns';
import type { LookupFunction } from 'node:net';
import ipaddr from 'ipaddr.js';
import type { Caller, Config } from './config.js';
import { DeliveryError, RequestError } from './errors.js';

export function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}

export function assertTargetAllowed(
  raw: string,
  caller: Caller,
  config: Pick<Config, 'allowPrivateTargets'>,
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RequestError('invalid_url', 400);
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    /[\s\u0000-\u001f\u007f]/.test(raw)
  ) {
    throw new RequestError('invalid_url', 400);
  }
  if (
    !caller.allowedOrigins.includes(url.origin) ||
    (!config.allowPrivateTargets && url.protocol !== 'https:')
  ) {
    throw new RequestError('target_not_allowed', 403);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!config.allowPrivateTargets && ipaddr.isValid(host) && !isPublicAddress(host))
    throw new RequestError('target_not_allowed', 403);
  return url;
}

// Resolve inside the actual connection lookup. The checked addresses are the
// addresses passed to the socket; there is no second, unchecked DNS resolution.
export function safeLookup(
  allowPrivate: boolean,
  resolve: typeof dnsLookup = dnsLookup,
): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) {
        callback(error, '', 0);
        return;
      }
      if (
        !addresses.length ||
        (!allowPrivate && addresses.some((a) => !isPublicAddress(a.address)))
      ) {
        callback(new DeliveryError('target_not_allowed', false), '', 0);
        return;
      }
      const candidates = options.family
        ? addresses.filter((a) => a.family === options.family)
        : addresses;
      if (!candidates.length) {
        callback(new DeliveryError('dns_no_address', true), '', 0);
        return;
      }
      if (options.all) callback(null, candidates);
      else callback(null, candidates[0]!.address, candidates[0]!.family);
    });
  };
}
