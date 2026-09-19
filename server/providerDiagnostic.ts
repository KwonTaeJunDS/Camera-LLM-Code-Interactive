/** Provider diagnostics are allowlisted values, never an SDK error serialization. */
export function providerDiagnostic(error: unknown): {
  status: number | null;
  code: string;
  reason: string;
} {
  const source = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const rawStatus = Number(source.status ?? source.statusCode ?? source.code);
  const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : null;
  const message = typeof source.message === 'string' ? source.message : '';
  if (source.name === 'AbortError') return {status, code: 'CANCELLED', reason: 'CLIENT_ABORT'};
  if (source.name === 'TimeoutError' || status === 408 || status === 504) {
    return {status, code: 'DEADLINE_EXCEEDED', reason: 'TIMEOUT'};
  }
  if (status === 503) {
    return {status, code: 'UNAVAILABLE', reason: /high demand|overload|capacity|exhausted/i.test(message) ? 'HIGH_DEMAND' : 'SERVICE_UNAVAILABLE'};
  }
  if (status === 500) return {status, code: 'INTERNAL', reason: 'PROVIDER_INTERNAL_ERROR'};
  if (status === 502) return {status, code: 'BAD_GATEWAY', reason: 'PROVIDER_GATEWAY_ERROR'};
  if (status === 429) return {status, code: 'RESOURCE_EXHAUSTED', reason: 'QUOTA_OR_RATE_LIMIT'};
  if (status === 400) return {status, code: 'INVALID_ARGUMENT', reason: 'REQUEST_REJECTED'};
  if (status === 401 || status === 403) return {status, code: 'PERMISSION_DENIED', reason: 'CREDENTIAL_OR_ACCESS_RESTRICTION'};
  if (status === 404) {
    return {status, code: 'NOT_FOUND', reason: /(?:no longer |not )available to new users/i.test(message) ? 'MODEL_ACCESS_RESTRICTION' : 'MODEL_UNAVAILABLE'};
  }
  if (source.name === 'TypeError' || /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(message)) {
    return {status, code: 'TRANSPORT_ERROR', reason: 'CONNECTION_FAILURE'};
  }
  return {status, code: 'UNKNOWN', reason: 'UNCLASSIFIED_FAILURE'};
}
