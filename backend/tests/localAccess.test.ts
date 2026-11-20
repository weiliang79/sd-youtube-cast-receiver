import { describe, expect, it, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { LocalAccess, WS_PROTOCOL, WS_AUTH_PREFIX } from '../src/LocalAccess';
import { handleRequest } from '../src/httpServer';
import { WsManager } from '../src/wsManager';
import { access, headers, STEAM_ORIGIN, TOKEN } from './testAccess';

function invoke(method: string, url: string, overrides: Record<string, any> = {}) {
  const pairing = { getState: vi.fn(() => ({ status: 'ready', code: '123456789012' })), start: vi.fn(), stop: vi.fn() };
  const req = Object.assign(new EventEmitter(), { method, url, headers: { ...headers, ...overrides } });
  const res = { setHeader: vi.fn(), writeHead: vi.fn(), end: vi.fn() };
  handleRequest(req as any, res as any, { access, pairing } as any);
  req.emit('end');
  return { pairing, res };
}

describe('local API capability boundary', () => {
  it.each([
    ['GET', '/api/pairing'], ['POST', '/api/pairing/start'], ['POST', '/api/pairing/stop'],
    ['POST', '/api/network/trust'], ['POST', '/api/play'], ['GET', '/api/state'],
  ])('rejects unauthenticated local and spoofed-Steam clients: %s %s', (method, path) => {
    for (const origin of [undefined, STEAM_ORIGIN]) {
      const { pairing, res } = invoke(method, path, { authorization: undefined, origin });
      expect(res.writeHead).toHaveBeenCalledWith(401, expect.anything());
      expect(pairing.getState).not.toHaveBeenCalled();
      expect(pairing.start).not.toHaveBeenCalled();
      expect(pairing.stop).not.toHaveBeenCalled();
    }
  });

  it.each(['https://evil.example', 'null', 'https://steamloopback.host.evil.example', 'http://steamloopback.host', 'https://steamloopback.host:444', 'https://steamloopback.host/', ['https://steamloopback.host']])('rejects untrusted or noncanonical origins even with a valid capability: %s', (origin) => {
    const { pairing, res } = invoke('POST', '/api/pairing/start', { origin });
    expect(res.writeHead).toHaveBeenCalledWith(403, expect.anything());
    expect(pairing.start).not.toHaveBeenCalled();
    expect(res.setHeader).not.toHaveBeenCalledWith('Access-Control-Allow-Origin', '*');
    expect(res.setHeader).not.toHaveBeenCalledWith('Access-Control-Allow-Origin', origin);
  });

  it.each(['evil.example:39281', 'localhost:39281', '127.0.0.1:9999', undefined])('rejects unexpected Host headers: %s', (host) => {
    expect(invoke('GET', '/api/pairing', { host }).res.writeHead).toHaveBeenCalledWith(403, expect.anything());
  });

  it('permits authenticated Steam frontend reads, suppresses caching, and scopes CORS', async () => {
    const { pairing, res } = invoke('GET', '/api/pairing');
    await Promise.resolve(); await Promise.resolve();
    expect(pairing.getState).toHaveBeenCalledOnce();
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.anything());
    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', STEAM_ORIGIN);
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });

  it('requires the current capability, never a query-string or retired capability', () => {
    const wrong = `Bearer ${'y'.repeat(43)}`;
    expect(invoke('GET', '/api/pairing', { authorization: wrong }).res.writeHead).toHaveBeenCalledWith(401, expect.anything());
    expect(invoke('GET', `/api/pairing?token=${TOKEN}`, { authorization: undefined }).res.writeHead).toHaveBeenCalledWith(401, expect.anything());
    expect(() => new LocalAccess('')).toThrow();
  });

  it('allows only the trusted frontend preflight and keeps the health probe public', async () => {
    const { res } = invoke('OPTIONS', '/api/pairing/start', {
      authorization: undefined, 'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, content-type',
    });
    expect(res.writeHead).toHaveBeenCalledWith(204);
    expect(invoke('OPTIONS', '/api/pairing', { origin: 'https://evil.example' }).res.writeHead).toHaveBeenCalledWith(403, expect.anything());
    const health = invoke('GET', '/api/health', { origin: undefined, authorization: undefined });
    await Promise.resolve(); await Promise.resolve();
    expect(health.res.writeHead).toHaveBeenCalledWith(200, expect.anything());
  });

  it('does not authenticate WebSockets via query strings, bearer headers alone, or extra protocols', () => {
    for (const protocols of [undefined, WS_PROTOCOL, `${WS_AUTH_PREFIX}${TOKEN}`, `${WS_PROTOCOL}, ${WS_AUTH_PREFIX}${TOKEN}, extra`]) {
      expect(access.authorizeWebSocket({ url: '/', headers: { ...headers, 'sec-websocket-protocol': protocols } } as any)).toBe(false);
    }
    expect(access.authorizeWebSocket({ url: `/?token=${TOKEN}`, headers: { ...headers, 'sec-websocket-protocol': `${WS_PROTOCOL}, ${WS_AUTH_PREFIX}${TOKEN}` } } as any)).toBe(false);
  });
});

describe('actual HTTP and WebSocket transport authorization', () => {
  it('blocks unauthenticated subscribers and preserves authenticated playback and pairing updates', async () => {
    let policy: LocalAccess;
    const pairing = { getState: vi.fn(() => ({ code: '123456789012' })), start: vi.fn(), stop: vi.fn() };
    const pause = vi.fn(async () => {});
    const server = createServer((req, res) => handleRequest(req, res, { access: policy, pairing, libraryPlayer: { pause } } as any));
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = (server.address() as any).port;
    policy = new LocalAccess(TOKEN, port);
    const ws = new WsManager(server, policy);
    const sockets: WebSocket[] = [];
    const url = `http://127.0.0.1:${port}`;
    async function rejected(protocols?: string[], origin?: string) {
      const client = new WebSocket(`ws://127.0.0.1:${port}`, protocols, { origin });
      sockets.push(client);
      await new Promise<void>((resolve, reject) => {
        client.once('open', () => reject(new Error('Unauthorized connection accepted')));
        client.once('error', () => resolve());
      });
      expect(ws.getClientCount()).toBe(0);
    }
    try {
      const unauthed = await fetch(`${url}/api/pairing`, { headers: { Origin: STEAM_ORIGIN } });
      expect(unauthed.status).toBe(401);
      expect(pairing.getState).not.toHaveBeenCalled();
      const crossOrigin = await fetch(`${url}/api/pairing/start`, { method: 'POST', headers: { Origin: 'https://evil.example', Authorization: `Bearer ${TOKEN}` } });
      expect(crossOrigin.status).toBe(403);
      expect(pairing.start).not.toHaveBeenCalled();
      const valid = await fetch(`${url}/api/pause`, { method: 'POST', headers: { Origin: STEAM_ORIGIN, Authorization: `Bearer ${TOKEN}` } });
      expect(valid.status).toBe(200);
      expect(pause).toHaveBeenCalledOnce();
      await rejected(undefined, STEAM_ORIGIN);
      await rejected([WS_PROTOCOL, `${WS_AUTH_PREFIX}${'y'.repeat(43)}`], STEAM_ORIGIN);
      await rejected([WS_PROTOCOL, `${WS_AUTH_PREFIX}${TOKEN}`], 'https://evil.example');
      const client = new WebSocket(`ws://127.0.0.1:${port}`, [WS_PROTOCOL, `${WS_AUTH_PREFIX}${TOKEN}`], { origin: STEAM_ORIGIN });
      sockets.push(client);
      await once(client, 'open');
      expect(client.protocol).toBe(WS_PROTOCOL); // Capability is not echoed.
      expect(ws.getClientCount()).toBe(1);
      const received = once(client, 'message');
      ws.broadcast('pairing', { code: '123456789012' });
      expect(JSON.parse(String((await received)[0]))).toEqual({ event: 'pairing', data: { code: '123456789012' } });
      const incoming = new Promise((resolve) => ws.onMessage(resolve));
      client.send(JSON.stringify({ event: 'progress', data: { currentTime: 1, duration: 2 } }));
      expect(await incoming).toMatchObject({ event: 'progress' });
    } finally {
      sockets.forEach((client) => client.terminate());
      ws.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
