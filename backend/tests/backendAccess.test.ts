import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@decky/api', () => ({ call: vi.fn() }));
import { call } from '@decky/api';
import { backendFetch, backendWebSocket, resetBackendAccess } from '../../src/services/backendAccess';
import { apiJumpToTrack, apiPause, destroyAudio, getCurrentTrack, initAudio } from '../../src/services/audioManager';
import { pairingClient } from '../../src/services/pairingClient';

const firstToken = 'a'.repeat(43);
const nextToken = 'b'.repeat(43);
const rpc = vi.mocked(call);
const sockets: FakeSocket[] = [];
class FakeSocket {
  static OPEN = 1;
  readyState = 0;
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn(() => { this.readyState = 3; });
  send = vi.fn();
  constructor(public url: string, public protocols: string[]) { sockets.push(this); }
}

describe('Decky capability bootstrap and frontend access', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    resetBackendAccess();
    vi.clearAllMocks();
    sockets.length = 0;
    rpc.mockResolvedValue(firstToken);
    fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(
      url.endsWith('/api/pairing') ? { status: 'idle', code: null, error: null, expiresAt: null } : {},
    )));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('document', {
      getElementById: () => null,
      createElement: () => ({ style: {}, addEventListener: vi.fn(), removeEventListener: vi.fn(), remove: vi.fn(), pause: vi.fn(), src: '' }),
      body: { appendChild: vi.fn() },
    });
  });
  afterEach(() => { destroyAudio(); vi.unstubAllGlobals(); });

  it('gets one capability through Decky RPC for HTTP and WS without a token URL', async () => {
    await Promise.all([backendFetch('/api/pairing'), backendFetch('/api/state'), backendWebSocket()]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('get_api_token');
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).not.toContain(firstToken);
      expect(init.headers.get('Authorization')).toBe(`Bearer ${firstToken}`);
      expect(init.cache).toBe('no-store');
    }
    expect(sockets[0].url).not.toContain(firstToken);
    expect(sockets[0].protocols).toEqual(['ytcast-v1', `ytcast-auth.${firstToken}`]);
  });

  it('reacquires a new capability after a backend restart rejects the cached one', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }));
    await backendFetch('/api/pairing');
    rpc.mockResolvedValueOnce(nextToken);
    await backendFetch('/api/pairing');
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].headers.get('Authorization')).toBe(`Bearer ${nextToken}`);
  });

  it('fails closed on RPC failure or an invalid capability and permits recovery', async () => {
    rpc.mockRejectedValueOnce(new Error('RPC unavailable'));
    await expect(backendFetch('/api/pairing/start', { method: 'POST' })).rejects.toThrow();
    rpc.mockResolvedValueOnce('');
    await expect(backendWebSocket()).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(0);
    await backendFetch('/api/pairing');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('cancels HTTP and WS bootstrap results after unload/reset', async () => {
    let resolve!: (value: string) => void;
    rpc.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const request = backendFetch('/api/pairing/start', { method: 'POST' });
    const socket = backendWebSocket();
    resetBackendAccess();
    resolve(firstToken);
    await expect(request).rejects.toThrow('superseded');
    await expect(socket).rejects.toThrow('superseded');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(0);
  });

  it('does not let a delayed retired 401 invalidate a new capability', async () => {
    let resolve!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const old = backendFetch('/api/state');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    resetBackendAccess();
    rpc.mockResolvedValueOnce(nextToken);
    await backendFetch('/api/state');
    resolve(new Response('', { status: 401 }));
    await expect(old).rejects.toThrow('superseded');
    await backendFetch('/api/state');
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.at(-1)[1].headers.get('Authorization')).toBe(`Bearer ${nextToken}`);
  });

  it('authenticates existing playback and queue-jump callers', async () => {
    await apiPause();
    await apiJumpToTrack('video-id');
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:39281/api/pause');
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('http://127.0.0.1:39281/api/queue/jump');
    expect(init.method).toBe('POST');
    expect(init.headers.get('Authorization')).toBe(`Bearer ${firstToken}`);
    expect(JSON.parse(init.body)).toEqual({ videoId: 'video-id' });
  });

  it('ignores stale socket open/message events after unload and reinitialization', async () => {
    initAudio();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const oldOpen = sockets[0].onopen!;
    const oldMessage = sockets[0].onmessage!;
    destroyAudio();
    initAudio();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1].onopen!();
    await vi.waitFor(() => expect(pairingClient.getSnapshot().state?.status).toBe('idle'));
    const requests = fetchMock.mock.calls.length;
    oldOpen();
    oldMessage({ data: JSON.stringify({ event: 'pairing', data: { status: 'ready', code: '123456789012' } }) });
    oldMessage({ data: JSON.stringify({ event: 'track', data: { videoId: 'old', url: 'https://example.invalid/old' } }) });
    expect(fetchMock.mock.calls).toHaveLength(requests);
    expect(pairingClient.getSnapshot().state?.status).toBe('idle');
    expect(getCurrentTrack()).toBeNull();
  });
});
