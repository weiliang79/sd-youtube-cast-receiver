import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { PairingManager } from '../src/PairingManager';
import { WsManager } from '../src/wsManager';

describe('pairing WebSocket updates', () => {
  it('broadcasts loading, code refreshes, and stopped state to connected clients', async () => {
    // No listener socket needed: exercise the existing connection event and serialization.
    const ws = new WsManager(createServer());
    const client = Object.assign(new EventEmitter(), { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() });
    (ws as any).wss.emit('connection', client);
    const service = Object.assign(new EventEmitter(), { start: vi.fn(), stop: vi.fn() });
    service.start.mockImplementation(() => service.emit('request'));
    const manager = new PairingManager(service, (state) => ws.broadcast('pairing', state), async () => {});
    try {
      manager.start();
      await vi.waitFor(() => expect(service.start).toHaveBeenCalledTimes(1));
      service.emit('response', '123456789012');
      service.emit('request');
      service.emit('response', '999888777666');
      manager.stop();
      const messages = client.send.mock.calls.map(([message]) => JSON.parse(message));
      expect(messages.every((message) => message.event === 'pairing')).toBe(true);
      expect(messages.map((message) => message.data.status)).toEqual(['loading', 'loading', 'ready', 'loading', 'ready', 'idle']);
      expect(messages.at(-1).data.code).toBeNull();
      expect(messages.filter((message) => message.data.status === 'ready').map((message) => message.data.code)).toEqual(['123456789012', '999888777666']);
    } finally {
      manager.dispose();
      ws.close();
    }
  });
});
