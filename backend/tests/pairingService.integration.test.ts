import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PairingCodeRequestService, Constants } from 'yt-cast-receiver';
import { PairingManager } from '../src/PairingManager';
import { ReceiverLifecycle } from '../src/ReceiverLifecycle';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('PairingManager with the installed SDK service', () => {
  let manager: PairingManager;
  let service: PairingCodeRequestService;
  let fetchMock: ReturnType<typeof vi.fn>;
  let replies: Array<ReturnType<typeof deferred<Response>>>;
  const settle = async () => { await vi.advanceTimersByTimeAsync(0); };

  beforeEach(() => {
    vi.useFakeTimers();
    replies = [];
    fetchMock = vi.fn(() => {
      const reply = deferred<Response>();
      replies.push(reply);
      return reply.promise;
    });
    vi.stubGlobal('fetch', fetchMock);
    service = new PairingCodeRequestService(
      { id: 'screen', app: 'youtube', name: 'Deck' } as any,
      { id: 'device', loungeIdToken: 'fixture-token' } as any,
    );
    manager = new PairingManager(service, vi.fn(), async () => {});
  });

  afterEach(() => {
    void manager.dispose();
    service.stop();
    vi.clearAllTimers();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('does not leave the SDK refresh timer alive after stopping a delayed fetch', async () => {
    manager.start(); await settle();
    manager.stop();
    replies[0].resolve(new Response('123456789012'));
    await settle();
    expect(manager.getState()).toMatchObject({ status: 'idle', code: null });
    expect(service.status).toBe(Constants.STATUSES.STOPPED);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(600000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('serializes rapid stop/start and keeps exactly one automatic refresh chain', async () => {
    manager.start(); await settle();
    manager.stop(); manager.start(); manager.start(); await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    replies[0].resolve(new Response('123456789012')); await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(manager.getState().code).toBeNull();
    replies[1].resolve(new Response('999888777666')); await settle();
    expect(manager.getState().code).toBe('999888777666');
    await vi.advanceTimersByTimeAsync(300000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(manager.getState()).toMatchObject({ status: 'loading', code: null });
    replies[2].resolve(new Response('111222333444')); await settle();
    expect(manager.getState().code).toBe('111222333444');
    manager.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for response body completion before final shutdown cleanup', async () => {
    manager.start(); await settle();
    const body = deferred<string>();
    replies[0].resolve({ text: () => body.promise } as Response); await settle();
    const disposed = manager.dispose();
    body.resolve('123456789012'); await settle();
    await disposed;
    expect(manager.getState()).toMatchObject({ status: 'idle', code: null });
    expect(service.listenerCount('response')).toBe(0);
    expect(service.listenerCount('error')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('serializes SDK Session.restart-style stop/start calls during a fetch', async () => {
    manager.start(); await settle();
    service.stop(); service.start(); // Session.end(), then Session.begin()/restart().
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    replies[0].resolve(new Response('123456789012')); await settle();
    expect(manager.getState().code).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    replies[1].resolve(new Response('999888777666')); await settle();
    expect(manager.getState().code).toBe('999888777666');
    manager.stop(); await settle();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not resurrect generation if the SDK requests a restart after user stop or shutdown', async () => {
    manager.start(); await settle();
    manager.stop(); service.start();
    replies[0].reject(new Error('offline')); await settle();
    await manager.dispose();
    service.start();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the late SDK timer after an external stop without a subsequent restart', async () => {
    manager.start(); await settle();
    service.stop();
    replies[0].resolve(new Response('123456789012')); await settle();
    expect(manager.getState().code).toBeNull();
    expect(service.status).toBe(Constants.STATUSES.STOPPED);
    expect(vi.getTimerCount()).toBe(1); // Only the manager's loading timeout.
    await vi.advanceTimersByTimeAsync(300000);
    expect(manager.getState().status).toBe('error');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves SDK start idempotence without hiding a current code', async () => {
    manager.start(); await settle();
    replies[0].resolve(new Response('123456789012')); await settle();
    const state = manager.getState();
    service.start(); service.start(); await settle();
    expect(manager.getState()).toEqual(state);
    await vi.advanceTimersByTimeAsync(30000);
    expect(manager.getState()).toEqual(state);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    manager.stop(); await settle();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps one service across network changes and idles only after grace with no phones', async () => {
    await manager.dispose();
    let phones = 0;
    let playing = false;
    const addresses: string[] = [];
    const receiver = { start: vi.fn(async () => {}), stop: vi.fn(async () => { service.stop(); }) };
    let lifecycle: ReceiverLifecycle;
    // New manager/service pair for this simulated receiver (one service at a time).
    service = new PairingCodeRequestService({ id: 'screen', app: 'youtube', name: 'Deck' } as any,
      { id: 'device', loungeIdToken: 'fixture-token' } as any);
    manager = new PairingManager(service, vi.fn(), () => lifecycle.enableManual());
    lifecycle = new ReceiverLifecycle(receiver, addresses, () => manager.receiverUnavailable(),
      () => manager.receiverReady(), () => manager.canIdleReceiver() && phones === 0 && !playing);
    manager.start(); await settle();
    replies[0].resolve(new Response('123456789012')); await settle();
    await lifecycle.setNetwork('trusted');
    await lifecycle.setNetwork(null);
    expect(receiver.start).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    manager.stop(); await settle();
    await lifecycle.releaseManualIfIdle();
    expect(receiver.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(330000);
    phones = 1;
    await lifecycle.releaseManualIfIdle();
    expect(receiver.stop).not.toHaveBeenCalled();
    phones = 0; playing = true;
    await lifecycle.releaseManualIfIdle();
    expect(receiver.stop).not.toHaveBeenCalled();
    playing = false;
    await lifecycle.releaseManualIfIdle();
    expect(receiver.stop).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    await manager.dispose();
    await lifecycle.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
