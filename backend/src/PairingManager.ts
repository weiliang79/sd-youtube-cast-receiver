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
const CONNECTION_GRACE = 30000;

/** One library service, with transient state only. Never log raw responses/errors. */
export class PairingManager {
  private state: PairingState = { ...IDLE };
  private active = false;
  private ready = false;
  private disposed = false;
  private started = false;
  private inFlight = false;
  private draining = false;
  private initializations = 0;
  private keepReceiverUntil = 0;
  private shutdownWaiters = new Set<() => void>();
  private externalStopped = false;
  private sdkStart: () => void;
  private sdkStop: () => void;
  private generation = 0;
  private requestGeneration = -1;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private service: Service,
    private changed: (state: PairingState) => void,
    private ensureReceiver: () => Promise<void>,
  ) {
    this.sdkStart = service.start.bind(service);
    this.sdkStop = service.stop.bind(service);
    // Session.restart() also calls these public methods. Serialize its calls
    // with manager requests so a restart cannot overlap an outstanding fetch.
    // Keep these guards through disposal to reject delayed SDK restarts.
    service.start = () => {
      if (!this.active || this.disposed) return;
      if (this.started && !this.externalStopped) return;
      this.externalStopped = false;
      this.generation++;
      this.ready = true;
      this.loading();
      this.tryStart();
    };
    service.stop = () => {
      this.externalStopped = true;
      this.ready = false;
      this.requestStop();
      if (this.active) this.loading();
    };
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
    void Promise.resolve().then(async () => {
      if (!this.active || this.disposed || generation !== this.generation) return;
      this.initializations++;
      try { await this.ensureReceiver(); }
      finally { this.initializations--; this.finishShutdown(); }
    }).then(() => {
      if (!this.active || this.disposed || generation !== this.generation) return;
      this.ready = true;
      this.externalStopped = false;
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
    this.requestStop();
    this.publish(IDLE);
    return this.getState();
  }

  receiverUnavailable(): void {
    this.ready = false;
    this.generation++;
    this.requestStop();
    if (this.active) this.loading();
  }

  receiverReady(): void {
    this.ready = true;
    this.externalStopped = false;
    this.tryStart();
  }

  canIdleReceiver(): boolean {
    return !this.active && !this.inFlight && !this.draining && this.initializations === 0
      && Date.now() >= this.keepReceiverUntil;
  }

  dispose(): Promise<void> {
    this.disposed = true;
    this.stop();
    return new Promise((resolve) => {
      this.shutdownWaiters.add(resolve);
      this.finishShutdown();
    });
  }

  private requestStop(): void {
    // SDK stop() marks STOPPED and then becomes a no-op. Stopping mid-fetch
    // would leave the timer it schedules after response impossible to stop.
    if (!this.inFlight && !this.draining) this.sdkStop();
    this.started = false;
  }

  private finishShutdown(): void {
    if (!this.disposed || this.inFlight || this.draining || this.initializations) return;
    this.sdkStop();
    this.detach();
    this.shutdownWaiters.forEach((resolve) => resolve());
    this.shutdownWaiters.clear();
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
    this.requestStop();
    this.publish({ ...IDLE, status: 'error', error: message });
  }

  private tryStart(): void {
    if (!this.active || !this.ready || this.disposed || this.started || this.inFlight || this.draining) return;
    this.started = true;
    try { this.sdkStart(); } catch { this.fail(); }
  }

  private onRequest = (): void => {
    this.inFlight = true;
    this.requestGeneration = this.generation;
    if (this.active) this.loading();
  };

  private onResponse = (raw: string): void => {
    const current = this.inFlight && this.active && !this.externalStopped && this.requestGeneration === this.generation;
    this.inFlight = false;
    this.draining = true;
    const valid = typeof raw === 'string' && /^\d+(?:[\s-]+\d+)*$/.test(raw.trim());
    if (valid) this.keepReceiverUntil = Date.now() + CODE_LIFETIME + CONNECTION_GRACE;
    if (current && valid) {
      this.clearTimer();
      this.publish({ status: 'ready', code: raw.replace(/[\s-]/g, ''), error: null, expiresAt: Date.now() + CODE_LIFETIME });
      // Hide the old code even if the library's next automatic refresh is delayed.
      if (this.active && !this.disposed && this.requestGeneration === this.generation) {
        this.timer = setTimeout(() => this.loading(), CODE_LIFETIME);
      }
    } else {
      if (current) this.fail();
    }
    this.drainStoppedRequest();
  };

  private onError = (): void => {
    const current = this.inFlight && this.active && this.requestGeneration === this.generation;
    this.inFlight = false;
    this.draining = true;
    this.started = false;
    if (current) this.fail();
    this.drainStoppedRequest();
  };

  private drainStoppedRequest(): void {
    // The installed SDK schedules its refresh synchronously after emit(). Keep
    // RUNNING until this microtask so stop() clears it. Tests use the real SDK.
    queueMicrotask(() => {
      if (!this.active || this.disposed || this.externalStopped || this.requestGeneration !== this.generation) {
        this.sdkStop();
        this.started = false;
      }
      this.draining = false;
      if (this.disposed) this.finishShutdown();
      else this.tryStart();
    });
  }

  private detach(): void {
    this.service.off('request', this.onRequest);
    this.service.off('response', this.onResponse);
    this.service.off('error', this.onError);
  }
}
