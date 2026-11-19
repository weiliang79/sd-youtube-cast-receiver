interface Receiver {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Serialize the library's coupled YouTube-session/DIAL lifecycle. */
export class ReceiverLifecycle {
  private network: string | null = null;
  private manual = false;
  private mode: string | null = null;
  private closed = false;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private receiver: Receiver,
    private addresses: string[],
    private unavailable: () => void,
    private ready: () => void,
  ) {}

  get advertising(): boolean { return this.mode !== null && this.mode !== 'manual'; }

  setNetwork(trustedNetworkUuid: string | null): Promise<void> {
    this.network = trustedNetworkUuid;
    return this.schedule();
  }

  async enableManual(): Promise<void> {
    if (this.closed) throw new Error('Receiver is shutting down');
    this.manual = true;
    await this.schedule();
    if (this.closed || !this.mode) throw new Error('Receiver is unavailable');
  }

  invalidate(): void {
    this.mode = null;
    this.unavailable();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.unavailable();
    await this.pending.catch(() => {});
    if (this.mode) await this.receiver.stop();
    this.mode = null;
  }

  private schedule(): Promise<void> {
    const operation = this.pending.catch(() => {}).then(async () => {
      if (this.closed) return;
      const desired = this.network ?? (this.manual ? 'manual' : null);
      if (desired === this.mode) return;
      if (this.mode && this.manual) {
        // peer-ssdp rescans the same filter every 15s. Keep the YouTube session
        // alive while discovery changes, so linked phones and code refreshes
        // do not get disconnected by a DIAL restart (including zero interfaces).
        this.bindAddresses();
        this.mode = desired;
        return;
      }
      if (this.mode) {
        this.unavailable();
        await this.receiver.stop();
        this.mode = null;
      }
      if (!desired || this.closed) return;
      // peer-ssdp retains this documented address-filter array. An empty filter
      // keeps normal discovery; loopback admits no LAN interfaces for manual use.
      this.bindAddresses();
      await this.receiver.start();
      this.mode = desired;
      if (!this.closed) this.ready();
    });
    this.pending = operation;
    return operation;
  }

  private bindAddresses(): void {
    this.addresses.splice(0, this.addresses.length, ...(this.network ? [] : ['127.0.0.1']));
  }
}
