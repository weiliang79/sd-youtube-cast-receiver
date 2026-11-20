import { LocalAccess } from '../src/LocalAccess';

export const TOKEN = 'test-capability-'.padEnd(43, 'x');
export const STEAM_ORIGIN = 'https://steamloopback.host';
export const access = new LocalAccess(TOKEN);
export const headers = {
  host: '127.0.0.1:39281', origin: STEAM_ORIGIN, authorization: `Bearer ${TOKEN}`,
};
