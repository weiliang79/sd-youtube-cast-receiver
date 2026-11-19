import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { handleRequest } from '../src/httpServer.js';
import { EventEmitter } from 'node:events';
import { PairingManager } from '../src/PairingManager';

function createMockReq(method: string, url: string, body?: any): any {
  const req = new EventEmitter();
  (req as any).method = method;
  (req as any).url = url;

  if (body) {
    setTimeout(() => {
      req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
    }, 1);
  } else {
    setTimeout(() => req.emit('end'), 1);
  }

  return req;
}

function createMockRes(): any {
  const res: any = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(code: number, headers?: Record<string, string>) {
      res.statusCode = code;
      if (headers) Object.assign(res.headers, headers);
    },
    setHeader(key: string, value: string) {
      res.headers[key] = value;
    },
    end(data?: string) {
      res.body = data ?? '';
    },
  };
  return res;
}

describe('HTTP Server', () => {
  it('returns 200 for GET /api/health', async () => {
    const req = createMockReq('GET', '/api/health');
    const res = createMockRes();
    const ctx = { castPlayer: {} as any, libraryPlayer: {} as any };

    handleRequest(req, res, ctx);

    await new Promise((r) => setTimeout(r, 50));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ready: true });
  });

  it('returns 404 for unknown routes', async () => {
    const req = createMockReq('GET', '/api/unknown');
    const res = createMockRes();
    const ctx = { castPlayer: {} as any, libraryPlayer: {} as any };

    handleRequest(req, res, ctx);

    await new Promise((r) => setTimeout(r, 50));

    expect(res.statusCode).toBe(404);
  });

  it('handles OPTIONS preflight requests', async () => {
    const req = createMockReq('OPTIONS', '/api/play');
    const res = createMockRes();
    const ctx = { castPlayer: {} as any, libraryPlayer: {} as any };

    handleRequest(req, res, ctx);

    expect(res.statusCode).toBe(204);
  });
});

describe('Pairing REST API', () => {
  let manager: PairingManager;
  let service: EventEmitter & { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
  let changed: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    service = Object.assign(new EventEmitter(), { start: vi.fn(), stop: vi.fn() });
    service.start.mockImplementation(() => service.emit('request'));
    changed = vi.fn();
    manager = new PairingManager(service, changed, async () => {});
  });
  afterEach(() => manager.dispose());

  function request(method: string, path: string): Promise<{ status: number; body: any }> {
    return new Promise((resolve) => {
      const res = createMockRes();
      res.end = (data: string) => resolve({ status: res.statusCode, body: JSON.parse(data) });
      handleRequest(createMockReq(method, path), res, {
        castPlayer: {} as any, libraryPlayer: {} as any, isConnected: () => false,
        network: { getCurrent: () => ({ uuid: null, name: null, trusted: false }), trust: async () => false, untrust: async () => false },
        pairing: manager,
      });
    });
  }

  it('retrieves state without starting generation', async () => {
    expect(await request('GET', '/api/pairing')).toEqual({ status: 200, body: { status: 'idle', code: null, error: null, expiresAt: null } });
    expect(service.start).not.toHaveBeenCalled();
  });

  it('starts once, returns refreshed state, and broadcasts code changes', async () => {
    const start = await request('POST', '/api/pairing/start');
    expect(start.status).toBe(200);
    expect(start.body.status).toBe('loading');
    await request('POST', '/api/pairing/start');
    expect(service.start).toHaveBeenCalledTimes(1);
    service.emit('response', '123456789012');
    const result = await request('GET', '/api/pairing');
    expect(result.body).toMatchObject({ status: 'ready', code: '123456789012' });
    expect(changed).toHaveBeenLastCalledWith(result.body);
  });

  it('stops generation and removes the code from subsequent snapshots', async () => {
    await request('POST', '/api/pairing/start');
    await vi.waitFor(() => expect(service.start).toHaveBeenCalledTimes(1));
    service.emit('response', '123456789012');
    const result = await request('POST', '/api/pairing/stop');
    expect(result).toEqual({ status: 200, body: { status: 'idle', code: null, error: null, expiresAt: null } });
    expect((await request('GET', '/api/pairing')).body).toEqual(result.body);
    expect(service.stop).toHaveBeenCalled();
  });

  it('exposes a sanitized error and accepts retry', async () => {
    await request('POST', '/api/pairing/start');
    await vi.waitFor(() => expect(service.start).toHaveBeenCalledTimes(1));
    service.emit('error', new Error('sensitive upstream data'));
    const result = await request('GET', '/api/pairing');
    expect(result.body).toMatchObject({ status: 'error', code: null });
    expect(result.body.error).not.toContain('sensitive');
    expect((await request('POST', '/api/pairing/start')).body.status).toBe('loading');
    await vi.waitFor(() => expect(service.start).toHaveBeenCalledTimes(2));
  });
});
