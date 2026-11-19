import { describe, expect, it, vi } from 'vitest';
import { PairingClient, type PairingState } from '../../src/services/pairingClient';

const idle: PairingState = { status: 'idle', code: null, error: null, expiresAt: null };
const code: PairingState = { status: 'ready', code: '123456789012', error: null, expiresAt: Date.now() + 300000 };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('PairingClient panel state', () => {
  it('restores current state on reconnect and remount without starting generation', async () => {
    const request = vi.fn(async () => code);
    const client = new PairingClient(request);
    client.connect(); await flush();
    expect(client.getSnapshot().state).toEqual(code);
    const listener = vi.fn();
    const unsubscribe = client.subscribe(listener);
    unsubscribe(); // Panel unmounts; code stays in the module-scoped store.
    expect(client.getSnapshot().state).toEqual(code);
    await client.refresh();
    expect(request.mock.calls.every(([path, method]) => path === '/api/pairing' && method === 'GET')).toBe(true);
    client.disconnect();
    expect(client.getSnapshot()).toMatchObject({ online: false, state: null });
    request.mockResolvedValueOnce(idle);
    client.connect(); await flush();
    expect(client.getSnapshot().state).toEqual(idle);
    expect(listener).not.toHaveBeenCalled();
  });

  it('does not let a stale GET overwrite a newer WebSocket refresh', async () => {
    let resolve!: (value: PairingState) => void;
    const client = new PairingClient(() => new Promise((done) => { resolve = done; }));
    client.connect();
    client.receive(code);
    resolve(idle); await flush();
    expect(client.getSnapshot().state).toEqual(code);
  });

  it('discards in-flight replies when the backend disconnects', async () => {
    let resolve!: (value: PairingState) => void;
    const client = new PairingClient(() => new Promise((done) => { resolve = done; }));
    client.connect(); client.disconnect();
    resolve(code); await flush();
    expect(client.getSnapshot()).toMatchObject({ online: false, state: null, busy: false });
  });

  it('uses start/stop endpoints and lets newer commands supersede older replies', async () => {
    const request = vi.fn(async () => idle);
    const client = new PairingClient(request);
    client.connect(); await flush();
    let resolveStart!: (value: PairingState) => void;
    request.mockImplementationOnce(() => new Promise((done) => { resolveStart = done; }));
    const start = client.start();
    await client.stop();
    resolveStart(code); await start;
    expect(client.getSnapshot().state).toEqual(idle);
    expect(request).toHaveBeenCalledWith('/api/pairing/start', 'POST');
    expect(request).toHaveBeenCalledWith('/api/pairing/stop', 'POST');
  });

  it('shows a recoverable transport error and clears potentially stale codes', async () => {
    const request = vi.fn(async () => code);
    const client = new PairingClient(request);
    client.connect(); await flush();
    request.mockRejectedValueOnce(new Error('raw response containing a code'));
    await client.refresh();
    expect(client.getSnapshot()).toMatchObject({ state: null, busy: false, error: expect.any(String) });
    await client.refresh();
    expect(client.getSnapshot()).toMatchObject({ state: code, error: null });
  });
});
