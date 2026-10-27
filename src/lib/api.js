// Client for the trip Worker. The setup key goes in a request header, never the URL.

export const KEY_HEADER = 'X-Setup-Key';

export class ApiError extends Error {
  constructor(kind, message, status = 0, details = []) {
    super(message);
    this.kind = kind;       // 'no-key' | 'no-server' | 'unauthorised' | 'invalid' | 'not-found' | 'offline' | 'server'
    this.status = status;
    this.details = details;
  }
}

export function createApi({ base, key, fetchImpl = (...a) => fetch(...a) }) {
  const root = (base || '').replace(/\/+$/, '');

  async function call(method, path, body) {
    if (!root) throw new ApiError('no-server', 'No server address is set. Add it in Settings.');
    if (!key) throw new ApiError('no-key', 'No setup key yet. Paste it in Settings.');
    let res;
    try {
      res = await fetchImpl(root + path, {
        method,
        headers: { [KEY_HEADER]: key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError('offline', 'Can’t reach the server. Check your connection and try again.');
    }
    if (res.status === 204) return null;
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (res.ok) return data;
    if (res.status === 401) throw new ApiError('unauthorised', 'The setup key wasn’t accepted. Check it in Settings.', 401);
    if (res.status === 404) throw new ApiError('not-found', 'That trip no longer exists. It may have been deleted on the other phone.', 404);
    if (res.status === 400) throw new ApiError('invalid', data?.error || 'Some trip details need fixing.', 400, data?.details || []);
    throw new ApiError('server', data?.error || `The server returned an error (${res.status}).`, res.status);
  }

  return {
    list: async () => (await call('GET', '/api/trips')).trips,
    create: async (trip) => (await call('POST', '/api/trips', trip)).trip,
    update: async (id, trip) => (await call('PUT', `/api/trips/${encodeURIComponent(id)}`, trip)).trip,
    remove: (id) => call('DELETE', `/api/trips/${encodeURIComponent(id)}`),
    snapshots: async (id) => (await call('GET', `/api/trips/${encodeURIComponent(id)}/snapshots`)).snapshots,
  };
}
