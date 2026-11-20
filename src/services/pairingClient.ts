import { backendFetch } from './backendAccess';

export interface PairingState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  code: string | null;
  error: string | null;
  expiresAt: number | null;
}

interface Snapshot {
  state: PairingState | null;
  online: boolean;
  busy: boolean;
  error: string | null;
}

type Request = (path: string, method: 'GET' | 'POST') => Promise<PairingState>;

/** In-memory panel state, fed by the existing audioManager WebSocket. */
export class PairingClient {
  private snapshot: Snapshot = { state: null, online: false, busy: false, error: null };
  private listeners = new Set<(snapshot: Snapshot) => void>();
  private version = 0;
  private requestId = 0;

  constructor(private request: Request) {}

  getSnapshot = (): Snapshot => this.snapshot;

  subscribe = (listener: (snapshot: Snapshot) => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(update: Partial<Snapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    this.listeners.forEach((listener) => listener(this.snapshot));
  }

  connect(): void {
    this.version++;
    this.publish({ online: true, state: null, error: null });
    void this.refresh();
  }

  disconnect(): void {
    this.version++;
    this.requestId++;
    this.publish({ online: false, state: null, busy: false, error: 'Backend disconnected. Reconnecting…' });
  }

  receive(state: PairingState): void {
    if (!this.snapshot.online) return;
    this.version++;
    this.publish({ state, error: null });
  }

  refresh(): Promise<void> { return this.load('/api/pairing', 'GET'); }
  start(): Promise<void> { return this.load('/api/pairing/start', 'POST'); }
  stop(): Promise<void> { return this.load('/api/pairing/stop', 'POST'); }

  private async load(path: string, method: 'GET' | 'POST'): Promise<void> {
    if (!this.snapshot.online) return;
    const version = this.version;
    const id = ++this.requestId;
    this.publish({ busy: true, error: null });
    try {
      const state = await this.request(path, method);
      // An event, disconnect or newer command supersedes this HTTP snapshot.
      if (id === this.requestId && version === this.version) this.publish({ state });
    } catch {
      if (id === this.requestId && version === this.version) {
        this.publish({ state: null, error: 'Could not contact the backend. Please retry.' });
      }
    } finally {
      if (id === this.requestId) this.publish({ busy: false });
    }
  }
}

export const pairingClient = new PairingClient(async (path, method) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await backendFetch(path, { method, signal: controller.signal });
    if (!response.ok) throw new Error('Pairing request failed');
    const state = await response.json();
    if (!['idle', 'loading', 'ready', 'error'].includes(state.status)) throw new Error('Invalid pairing state');
    return state as PairingState;
  } finally {
    clearTimeout(timeout);
  }
});
