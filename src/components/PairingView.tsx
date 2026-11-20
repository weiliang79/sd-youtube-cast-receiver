import { useEffect, useState } from 'react';
import { DialogButton } from '@decky/ui';
import { pairingClient } from '../services/pairingClient';

export const PairingView = () => {
  const [snapshot, setSnapshot] = useState(pairingClient.getSnapshot);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const unsubscribe = pairingClient.subscribe(setSnapshot);
    setSnapshot(pairingClient.getSnapshot());
    void pairingClient.refresh();
    return unsubscribe; // Closing the panel must not stop code refreshes.
  }, []);
  const { state, online, busy, error } = snapshot;
  useEffect(() => {
    setNow(Date.now());
    if (!state?.expiresAt) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, state.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [state]);

  const code = online && state?.status === 'ready' && state.expiresAt && state.expiresAt > Math.max(now, Date.now())
    ? state.code?.match(/.{1,3}/g)?.join(' ') : null;
  const loading = state?.status === 'loading' || (state?.status === 'ready' && !code);
  const active = state?.status === 'loading' || state?.status === 'ready';
  return (
    <div style={{ padding: '12px 18px', display: 'flex', flexDirection: 'column', gap: '12px', height: '100%', overflowY: 'auto', boxSizing: 'border-box' }}>
      <div style={{ fontWeight: 'bold' }}>Link with TV code</div>
      <div style={{ fontSize: '13px' }}>
        On your phone, open YouTube → Cast → Add a device (or Link with TV code).
        Enter this code and tap Link.
        Both devices need internet access; they can be on different networks.
      </div>
      <div aria-live="polite" style={{ minHeight: '50px' }}>
        {code ? <div style={{ fontSize: '24px', fontWeight: 'bold', textAlign: 'center' }}>{code}</div>
          : loading ? 'Generating TV code…' : !online ? 'Waiting for backend…' : 'Generate a code to link your phone.'}
        {(error || state?.error) && <div role="alert" style={{ fontSize: '13px' }}>{error || state?.error}</div>}
      </div>
      {state?.status === 'ready' && <div style={{ fontSize: '12px' }}>Codes refresh automatically. Use the latest code shown.</div>}
      {error ? <DialogButton disabled={!online || busy} onClick={() => { void pairingClient.refresh(); }}>Retry connection</DialogButton>
        : <DialogButton disabled={!online || busy || !!active} onClick={() => { void pairingClient.start(); }}>
          {state?.status === 'error' ? 'Retry' : 'Generate TV code'}
        </DialogButton>}
      {active && <DialogButton disabled={!online || busy} onClick={() => { void pairingClient.stop(); }}>Stop generating codes</DialogButton>}
      <div style={{ fontSize: '12px' }}>Stopping hides the code and stops refreshing it. Active phones stay connected; issued codes are not revoked.</div>
    </div>
  );
};
