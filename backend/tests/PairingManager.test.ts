import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PairingManager } from '../src/PairingManager';

class Service extends EventEmitter {
  timer: ReturnType<typeof setTimeout> | null = null;
  start = vi.fn(() => { this.emit('request'); });
  stop = vi.fn(() => { if (this.timer) clearTimeout(this.timer); this.timer = null; });
  respond(code: string) {
    this.emit('response', code);
    // Mirror the library's late timer scheduling even after stop().
    this.timer = setTimeout(() => this.emit('request'), 300000);
  }
}

describe('PairingManager', () => {
  let service: Service;
  let manager: PairingManager;
  let changed: ReturnType<typeof vi.fn>;
  let ensureReceiver: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    service = new Service();
    changed = vi.fn();
    ensureReceiver = vi.fn(async () => {});
    manager = new PairingManager(service, changed, ensureReceiver);
  });
  afterEach(() => { manager.dispose(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });
  const settle = async () => { await vi.advanceTimersByTimeAsync(0); };

  it('starts lazily and shares one service across repeated start requests', async () => {
    expect(manager.getState()).toEqual({ status: 'idle', code: null, error: null, expiresAt: null });
    expect(service.start).not.toHaveBeenCalled();
    expect(manager.start().status).toBe('loading');
    manager.start();
    await settle();
    expect(ensureReceiver).toHaveBeenCalledTimes(1);
    expect(service.start).toHaveBeenCalledTimes(1);
    service.respond('123 456 789 012');
    expect(manager.getState()).toEqual({ status: 'ready', code: '123456789012', error: null, expiresAt: Date.now() + 300000 });
    manager.start();
    expect(service.start).toHaveBeenCalledTimes(1);
    const snapshot = manager.getState();
    snapshot.code = 'modified';
    expect(manager.getState().code).toBe('123456789012');
  });

  it('broadcasts refresh transitions and hides expired codes', async () => {
    manager.start(); await settle();
    service.respond('123456789012');
    await vi.advanceTimersByTimeAsync(300000);
    expect(manager.getState()).toMatchObject({ status: 'loading', code: null, expiresAt: null });
    service.respond('999888777666');
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'ready', code: '999888777666' }));
  });

  it('clears codes on errors, sanitizes errors, and retries on the same service', async () => {
    const log = vi.spyOn(console, 'error');
    manager.start(); await settle();
    service.respond('123456789012');
    service.emit('request');
    service.emit('error', new Error('secret response 123456789012'));
    expect(manager.getState()).toMatchObject({ status: 'error', code: null, expiresAt: null });
    expect(manager.getState().error).not.toContain('123456789012');
    expect(log).not.toHaveBeenCalled();
    await settle();
    manager.start(); await settle();
    expect(service.start).toHaveBeenCalledTimes(2);
    service.respond('999888777666');
    expect(manager.getState().status).toBe('ready');
  });

  it('stops and discards a late response and its newly scheduled timer', async () => {
    manager.start(); await settle();
    changed.mockClear();
    manager.stop();
    service.respond('123456789012');
    await settle();
    expect(manager.getState()).toMatchObject({ status: 'idle', code: null });
    expect(changed.mock.calls.every(([state]) => state.code === null)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not mistake an old response for a rapid stop/start retry', async () => {
    manager.start(); await settle();
    manager.stop(); manager.start(); await settle();
    expect(service.start).toHaveBeenCalledTimes(1);
    service.respond('123456789012'); await settle();
    expect(service.start).toHaveBeenCalledTimes(2);
    expect(manager.getState()).toMatchObject({ status: 'loading', code: null });
    service.respond('999888777666');
    expect(manager.getState().code).toBe('999888777666');
  });

  it('times out requests without publishing a subsequent late code', async () => {
    manager.start(); await settle();
    await vi.advanceTimersByTimeAsync(30000);
    expect(manager.getState()).toMatchObject({ status: 'error', code: null });
    service.respond('123456789012'); await settle();
    expect(manager.getState().status).toBe('error');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refreshes after receiver rebinds and drops stale in-flight responses', async () => {
    manager.start(); await settle();
    manager.receiverUnavailable(); manager.receiverReady();
    service.respond('123456789012'); await settle();
    expect(manager.getState()).toMatchObject({ status: 'loading', code: null });
    service.respond('999888777666');
    expect(manager.getState().code).toBe('999888777666');
  });

  it('reports session initialization failure and allows retry', async () => {
    ensureReceiver.mockRejectedValueOnce(new Error('sensitive initialization detail'));
    manager.start(); await settle();
    expect(manager.getState()).toMatchObject({ status: 'error', code: null });
    expect(service.start).not.toHaveBeenCalled();
    manager.start(); await settle();
    expect(service.start).toHaveBeenCalledTimes(1);
  });

  it('rejects non-code service responses without exposing their contents', async () => {
    manager.start(); await settle();
    service.respond('<html>upstream failure</html>'); await settle();
    expect(manager.getState()).toMatchObject({ status: 'error', code: null });
    expect(manager.getState().error).not.toContain('html');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles shutdown during a fetch and detaches after a late error', async () => {
    manager.start(); await settle();
    manager.dispose();
    expect(() => service.emit('error', new Error('late error'))).not.toThrow();
    await settle();
    expect(service.listenerCount('request')).toBe(0);
    expect(service.listenerCount('response')).toBe(0);
    expect(service.listenerCount('error')).toBe(0);
    manager.start();
    expect(service.start).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not initialize a receiver for a request stopped before startup', async () => {
    manager.start(); manager.stop(); await settle();
    expect(ensureReceiver).not.toHaveBeenCalled();
    expect(service.start).not.toHaveBeenCalled();
    expect(manager.getState().status).toBe('idle');
  });
});
