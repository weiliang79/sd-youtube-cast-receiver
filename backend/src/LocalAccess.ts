import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const STEAM_ORIGIN = 'https://steamloopback.host';
export const WS_PROTOCOL = 'ytcast-v1';
export const WS_AUTH_PREFIX = 'ytcast-auth.';

/** One capability for this backend launch; no unauthenticated token endpoint. */
export class LocalAccess {
  constructor(private token: string, private port = 39281) {
    if (!/^[A-Za-z0-9_-]{43,}$/.test(token)) throw new Error('A per-launch API capability is required');
  }

  private matches(value: string): boolean {
    const expected = Buffer.from(this.token);
    const supplied = Buffer.from(value);
    return supplied.length === expected.length && timingSafeEqual(expected, supplied);
  }

  private permittedSource(req: IncomingMessage): boolean {
    return req.headers.host === `127.0.0.1:${this.port}`
      && (req.headers.origin === undefined || req.headers.origin === STEAM_ORIGIN);
  }

  authorizeHttp(req: IncomingMessage, res: ServerResponse): boolean {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Origin');
    if (!this.permittedSource(req)) return this.reject(res, 403);
    if (req.headers.origin === STEAM_ORIGIN) {
      res.setHeader('Access-Control-Allow-Origin', STEAM_ORIGIN);
    }
    if (req.method === 'OPTIONS') {
      const method = req.headers['access-control-request-method'];
      const headers = req.headers['access-control-request-headers'];
      if (req.headers.origin !== STEAM_ORIGIN || !['GET', 'POST'].includes(String(method))
          || (headers !== undefined && (typeof headers !== 'string'
            || headers.split(',').some((header) => !['authorization', 'content-type'].includes(header.trim().toLowerCase()))))) {
        return this.reject(res, 403);
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.writeHead(204);
      res.end();
      return false;
    }
    // Keep the existing read-only health probe usable over SSH without secrets.
    if (req.method === 'GET' && req.url === '/api/health') return true;
    const auth = req.headers.authorization;
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ') || !this.matches(auth.slice(7))) {
      return this.reject(res, 401);
    }
    return true;
  }

  authorizeWebSocket(req: IncomingMessage): boolean {
    if (!this.permittedSource(req) || req.url !== '/') return false;
    const raw = req.headers['sec-websocket-protocol'];
    if (typeof raw !== 'string') return false;
    const protocols = raw.split(',').map((value) => value.trim());
    return protocols.length === 2 && protocols.includes(WS_PROTOCOL)
      && protocols.some((value) => value.startsWith(WS_AUTH_PREFIX) && this.matches(value.slice(WS_AUTH_PREFIX.length)));
  }

  private reject(res: ServerResponse, status: number): false {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: status === 401 ? 'Unauthorized' : 'Forbidden' }));
    return false;
  }
}
