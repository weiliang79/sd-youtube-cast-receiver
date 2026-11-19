import type { PairingCodeRequestService } from 'yt-cast-receiver';

export interface PairingState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  code: string | null;
  error: string | null;
  expiresAt: number | null;
}

type Service = Pick<PairingCodeRequestService, 'on' | 'off' | 'start' | 'stop'>;
const IDLE: PairingState = { status: 'idle', code: null, error: null, expiresAt: null };
const REQUEST_TIMEOUT = 30000;
const CODE_LIFETIME = 300000;

/** One library service, with transient state only. Never log raw responses/errors. */
export class PairingManager {
  private state: PairingState = { ...IDLE };
  private active = false;
  private ready = false;
  private disposed = false;
  private started = false;
  private inFlight = false;
  private generation = 0;
  private requestGeneration = -1;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private service: Service,
    private changed: (state: PairingState) => void,
    private ensureReceiver: () => Promise<void>,
  ) {
    service.on('request', this.onRequest);
    service.on('response', this.onResponse);
    service.on('error', this.onError);
  }

  getState(): PairingState { return { ...this.state }; }

  start(): PairingState {
    if (this.disposed || this.active) return this.getState();
    this.active = true;
    const generation = ++this.generation;
    this.loading();
    void Promise.resolve().then(() => {
      if (this.active && !this.disposed && generation === this.generation) return this.ensureReceiver();
      return undefined;
    }).then(() => {
      if (!this.active || this.disposed || generation !== this.generation) return;
      this.ready = true;
      this.tryStart();
    }).catch(() => {
      if (generation === this.generation && this.active) this.fail();
    });
    return this.getState();
  }

  stop(): PairingState {
    this.active = false;
    this.generation++;
    this.clearTimer();
    this.service.stop();
    this.started = false;
    this.publish(IDLE);
    return this.getState();
  }

  receiverUnavailable(): void {
    this.ready = false;
    this.generation++;
    this.service.stop();
    this.started = false;
    if (this.active) this.loading();
  }

  receiverReady(): void {
    this.ready = true;
    this.tryStart();
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    // An outstanding library fetch may emit after stop(). Keep its error handler
    // until it settles, then detach; otherwise EventEmitter would throw.
    if (!this.inFlight) this.detach();
  }

  private publish(state: PairingState): void {
    this.state = { ...state };
    this.changed(this.getState());
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private loading(): void {
    this.clearTimer();
    this.publish({ ...IDLE, status: 'loading' });
    this.timer = setTimeout(() => this.fail('TV-code request timed out. Please retry.'), REQUEST_TIMEOUT);
  }

  private fail(message = 'Unable to generate a TV code. Check internet access and retry.'): void {
    this.active = false;
    this.generation++;
    this.clearTimer();
    this.service.stop();
    this.started = false;
    this.publish({ ...IDLE, status: 'error', error: message });
  }

  private tryStart(): void {
    if (!this.active || !this.ready || this.disposed || this.started || this.inFlight) return;
    this.started = true;
    try { this.service.start(); } catch { this.fail(); }
  }

  private onRequest = (): void => {
    this.inFlight = true;
    this.requestGeneration = this.generation;
    if (this.active) this.loading();
  };

  private onResponse = (raw: string): void => {
    const current = this.inFlight && this.active && this.requestGeneration === this.generation;
    this.inFlight = false;
    if (current && typeof raw === 'string' && /^\d+(?:[\s-]+\d+)*$/.test(raw.trim())) {
      this.clearTimer();
      this.publish({ status: 'ready', code: raw.replace(/[\s-]/g, ''), error: null, expiresAt: Date.now() + CODE_LIFETIME });
      // Hide the old code even if the library's next automatic refresh is delayed.
      this.timer = setTimeout(() => this.loading(), CODE_LIFETIME);
    } else {
      if (current) this.fail();
      this.drainStoppedRequest();
    }
  };

  private onError = (): void => {
    const current = this.inFlight && this.active && this.requestGeneration === this.generation;
    this.inFlight = false;
    this.started = false;
    if (current) this.fail();
    this.drainStoppedRequest();
  };

  private drainStoppedRequest(): void {
    // The library schedules a new refresh AFTER emitting response, even when
    // stop() was called during its fetch. Clear that timer after its callback.
    queueMicrotask(() => {
      this.service.stop();
      this.started = false;
      if (this.disposed) this.detach();
      else this.tryStart();
    });
  }

  private detach(): void {
    this.service.off('request', this.onRequest);
    this.service.off('response', this.onResponse);
    this.service.off('error', this.onError);
  }
}
