import { describe, expect, it, vi } from 'vitest';
import { ReceiverLifecycle } from '../src/ReceiverLifecycle';
import { createRequire } from 'node:module';
import os from 'node:os';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';

function setup() {
  const addresses: string[] = [];
  const bindings: string[][] = [];
  const receiver = { start: vi.fn(async () => { bindings.push([...addresses]); }), stop: vi.fn(async () => {}) };
  const unavailable = vi.fn();
  const ready = vi.fn();
  const lifecycle = new ReceiverLifecycle(receiver, addresses, unavailable, ready);
  return { receiver, lifecycle, bindings, addresses, unavailable, ready };
}

describe('ReceiverLifecycle', () => {
  it('uses an SDK address filter that excludes LAN sockets and updates without restarting SSDP', async () => {
    const require = createRequire(import.meta.url);
    const requireSdk = createRequire(require.resolve('yt-cast-receiver'));
    const requireDial = createRequire(requireSdk.resolve('@patrickkfkan/peer-dial'));
    const { createPeer } = requireDial('@patrickkfkan/peer-ssdp');
    const addresses = ['127.0.0.1'];
    const sockets: Array<{ close: ReturnType<typeof vi.fn> }> = [];
    vi.useFakeTimers();
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      wlan0: [{ address: '192.0.2.10', family: 'IPv4', internal: false } as any],
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as any],
    });
    const createSocket = vi.spyOn(dgram, 'createSocket').mockImplementation(() => {
      const socket = Object.assign(new EventEmitter(), { bind: vi.fn(), close: vi.fn() });
      sockets.push(socket);
      return socket as any;
    });
    const peer = createPeer({ bindToAddresses: addresses });
    try {
      peer.start();
      expect(createSocket).not.toHaveBeenCalled();
      addresses.splice(0);
      await vi.advanceTimersByTimeAsync(15000);
      expect(createSocket).toHaveBeenCalledTimes(2);
      addresses.push('127.0.0.1');
      await vi.advanceTimersByTimeAsync(15000);
      expect(sockets.every((socket) => socket.close.mock.calls.length === 1)).toBe(true);
    } finally {
      peer.close();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it('starts manual pairing with no trusted/discovered network and excludes LAN addresses', async () => {
    const { lifecycle, receiver, bindings } = setup();
    await lifecycle.setNetwork(null);
    expect(receiver.start).not.toHaveBeenCalled();
    await Promise.all([lifecycle.enableManual(), lifecycle.enableManual()]);
    expect(receiver.start).toHaveBeenCalledTimes(1);
    expect(bindings).toEqual([['127.0.0.1']]);
    expect(lifecycle.advertising).toBe(false);
    await lifecycle.close();
    expect(receiver.stop).toHaveBeenCalledTimes(1);
    await expect(lifecycle.enableManual()).rejects.toThrow();
  });

  it('preserves automatic trusted-network discovery and rebinds when networks change', async () => {
    const { lifecycle, receiver, bindings } = setup();
    await lifecycle.setNetwork('network-a');
    await lifecycle.setNetwork('network-a');
    expect(receiver.start).toHaveBeenCalledTimes(1);
    expect(lifecycle.advertising).toBe(true);
    await lifecycle.setNetwork('network-b');
    expect(receiver.stop).toHaveBeenCalledTimes(1);
    expect(bindings).toEqual([[], []]);
    await lifecycle.setNetwork(null);
    expect(lifecycle.advertising).toBe(false);
    expect(receiver.stop).toHaveBeenCalledTimes(2);
  });

  it('changes discovery filters without disconnecting an active manual session', async () => {
    const { lifecycle, receiver, addresses, ready, unavailable } = setup();
    await lifecycle.enableManual();
    expect(addresses).toEqual(['127.0.0.1']);
    await lifecycle.setNetwork('network-a');
    expect(lifecycle.advertising).toBe(true);
    expect(addresses).toEqual([]);
    await lifecycle.setNetwork(null);
    expect(lifecycle.advertising).toBe(false);
    expect(addresses).toEqual(['127.0.0.1']);
    expect(receiver.start).toHaveBeenCalledTimes(1);
    expect(receiver.stop).not.toHaveBeenCalled();
    expect(ready).toHaveBeenCalledTimes(1);
    expect(unavailable).not.toHaveBeenCalled();
    await lifecycle.close();
  });

  it('recovers from startup failures without overlapping receiver operations', async () => {
    const { lifecycle, receiver } = setup();
    receiver.start.mockRejectedValueOnce(new Error('offline'));
    await expect(lifecycle.enableManual()).rejects.toThrow('offline');
    await lifecycle.enableManual();
    expect(receiver.start).toHaveBeenCalledTimes(2);
    await lifecycle.close();
  });
});
