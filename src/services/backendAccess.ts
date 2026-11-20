import { call } from '@decky/api';

let token: Promise<string> | null = null;
let generation = 0;

function capability(): Promise<string> {
  if (!token) {
    const version = generation;
    token = call<[], string>('get_api_token').then((value) => {
      if (!/^[A-Za-z0-9_-]{43,}$/.test(value)) throw new Error('Backend authentication unavailable');
      return value;
    }).catch(() => {
      if (version === generation) token = null;
      throw new Error('Backend authentication unavailable');
    });
  }
  return token;
}

export function resetBackendAccess(): void {
  generation++;
  token = null;
}

export async function backendFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const version = generation;
  const secret = await capability();
  if (version !== generation) throw new Error('Backend request superseded');
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${secret}`);
  const response = await fetch(`http://127.0.0.1:39281${path}`, { ...init, headers, cache: 'no-store' });
  if (version !== generation) throw new Error('Backend request superseded');
  if (response.status === 401 && version === generation) resetBackendAccess();
  return response;
}

export async function backendWebSocket(): Promise<WebSocket> {
  const version = generation;
  const secret = await capability();
  if (version !== generation) throw new Error('Backend connection superseded');
  // Browsers cannot set an Authorization handshake header. Negotiate only the
  // non-secret protocol; the capability is never placed in a URL or echoed back.
  return new WebSocket('ws://127.0.0.1:39281', ['ytcast-v1', `ytcast-auth.${secret}`]);
}
