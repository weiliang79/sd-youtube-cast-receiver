import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { unzipSync } from 'fflate';
import { download, ensureBinaries, NODE_ARCHIVE, NODE_VERSION, packagePlugin, REQUIRED, ROOT, validateLinuxX64, validatePackage } from '../../scripts/package.mjs';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const linuxBinary = () => {
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  bytes.writeUInt16LE(62, 18);
  return bytes;
};

// Read the ZIP central directory independently of fflate's unzip implementation.
function centralDirectory(bytes: Buffer) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const entries = [];
  let offset = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
    expect(bytes.readUInt32LE(offset)).toBe(0x02014b50);
    const length = bytes.readUInt16LE(offset + 28);
    entries.push({
      name: bytes.subarray(offset + 46, offset + 46 + length).toString(),
      os: bytes[offset + 5],
      mode: bytes.readUInt32LE(offset + 38) >>> 16,
    });
    offset += 46 + length + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return entries;
}

describe('cross-platform Linux x64 packaging', () => {
  let root: string;
  let archive: Buffer;
  let fetchImpl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ytcast package '));
    for (const file of REQUIRED.filter((name: string) => !name.startsWith('bin/'))) {
      mkdirSync(join(root, file, '..'), { recursive: true });
      writeFileSync(join(root, file), 'fixture');
    }
    writeFileSync(join(root, 'plugin.json'), JSON.stringify({ name: 'YouTube Cast Receiver' }));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(join(root, 'main.py'), readFileSync(join(ROOT, 'main.py')));
    const source = join(root, 'archive-source');
    const member = `node-${NODE_VERSION}-linux-x64/bin/node`;
    mkdirSync(join(source, member, '..'), { recursive: true });
    writeFileSync(join(source, member), linuxBinary());
    const tar = process.platform === 'win32' && process.env.SystemRoot
      ? join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';
    const result = spawnSync(tar, ['-czf', join(root, NODE_ARCHIVE), '-C', source, member], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    archive = readFileSync(join(root, NODE_ARCHIVE));
    fetchImpl = vi.fn(async (url: string) => {
      let bytes: Buffer | string;
      if (url.endsWith(`/${NODE_ARCHIVE}`)) bytes = archive;
      else if (url.endsWith('/SHASUMS256.txt')) bytes = `${sha256(archive)}  ${NODE_ARCHIVE}\n`;
      else if (url.endsWith('/yt-dlp_linux')) bytes = linuxBinary();
      else if (url.endsWith('/SHA2-256SUMS')) bytes = `${sha256(linuxBinary())}  yt-dlp_linux\n`;
      else throw new Error(`Unexpected download: ${url}`);
      return new Response(bytes);
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('preserves the Decky ZIP layout, CommonJS launcher, and Unix executable permissions', async () => {
    writeFileSync(join(root, '.env'), 'must not ship');
    writeFileSync(join(root, 'backend/out/server.js'), 'stale');
    writeFileSync(join(root, 'backend/out/package.json'), '{"type":"commonjs"}');
    const output = await packagePlugin({ root, skipBuild: true, fetchImpl });
    const bytes = readFileSync(output);
    const entries = centralDirectory(bytes);
    const prefix = 'YouTube Cast Receiver/';
    expect(entries.map((entry) => entry.name).sort()).toEqual(REQUIRED.map((file: string) => prefix + file).sort());
    for (const entry of entries) {
      expect(entry.os).toBe(3); // Unix, even when the build host is Windows.
      expect(entry.mode).toBe(entry.name.startsWith(prefix + 'bin/') ? 0o100755 : 0o100644);
    }
    const files = unzipSync(bytes);
    expect(Buffer.from(files[prefix + 'main.py']).toString()).toContain('"server.cjs"');
    expect(Buffer.from(files[prefix + 'backend/out/server.cjs']).toString()).toBe('fixture');
    expect(() => validatePackage(bytes, 'YouTube Cast Receiver')).not.toThrow();
    expect(fetchImpl.mock.calls.map(([url]) => url)).toContain(`https://nodejs.org/dist/${NODE_VERSION}/${NODE_ARCHIVE}`);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toContain('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux');
    expect(readdirSync(root).some((name) => name.startsWith('.package-'))).toBe(false);
    expect(readdirSync(join(root, 'bin')).sort()).toEqual(['.package-binaries.json', 'node', 'yt-dlp']);
  });

  it('reuses verified binaries while replacing the ZIP without stale files on repeated builds', async () => {
    writeFileSync(join(root, 'dist/old.js'), 'old asset');
    const output = await packagePlugin({ root, skipBuild: true, fetchImpl });
    rmSync(join(root, 'dist/old.js'));
    writeFileSync(join(root, 'dist/index.js'), 'updated frontend');
    fetchImpl.mockClear();
    await packagePlugin({ root, skipBuild: true, fetchImpl });
    const files = unzipSync(readFileSync(output));
    expect(files['YouTube Cast Receiver/dist/old.js']).toBeUndefined();
    expect(Buffer.from(files['YouTube Cast Receiver/dist/index.js']).toString()).toBe('updated frontend');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('redownloads damaged or wrong-architecture cached binaries', async () => {
    await ensureBinaries(root, { fetchImpl });
    writeFileSync(join(root, 'bin/node'), 'host executable');
    fetchImpl.mockClear();
    await ensureBinaries(root, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(readFileSync(join(root, 'bin/node'))).toEqual(linuxBinary());
  });

  it('rejects checksum failures before publishing either binary or replacing an existing ZIP', async () => {
    const output = join(root, 'youtube-cast-receiver.zip');
    writeFileSync(output, 'previous ZIP');
    const original = fetchImpl.getMockImplementation()!;
    fetchImpl.mockImplementation((url: string) => url.endsWith('/SHA2-256SUMS')
      ? Promise.resolve(new Response(`${'0'.repeat(64)}  yt-dlp_linux\n`)) : original(url));
    await expect(packagePlugin({ root, skipBuild: true, fetchImpl })).rejects.toThrow('SHA-256');
    expect(readFileSync(output, 'utf8')).toBe('previous ZIP');
    expect(readdirSync(join(root, 'bin'))).toEqual([]);
  });

  it('rejects missing payload files and preserves the previous ZIP', async () => {
    await ensureBinaries(root, { fetchImpl });
    rmSync(join(root, 'main.py'));
    writeFileSync(join(root, 'youtube-cast-receiver.zip'), 'previous ZIP');
    await expect(packagePlugin({ root, skipBuild: true, fetchImpl })).rejects.toThrow();
    expect(readFileSync(join(root, 'youtube-cast-receiver.zip'), 'utf8')).toBe('previous ZIP');
    expect(readdirSync(root).some((name) => name.startsWith('.package-'))).toBe(false);
  });

  it('cleans temporary files when a checksum-valid archive cannot be extracted', async () => {
    archive = Buffer.from('not a gzip archive');
    await expect(ensureBinaries(root, { fetchImpl })).rejects.toThrow('failed');
    expect(readdirSync(join(root, 'bin'))).toEqual([]);
  });

  it('rejects invalid plugin names before downloading or creating paths', async () => {
    writeFileSync(join(root, 'plugin.json'), JSON.stringify({ name: '../escape' }));
    await expect(packagePlugin({ root, skipBuild: true, fetchImpl })).rejects.toThrow('directory name');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('stops on a failed build before downloading or replacing a ZIP', async () => {
    const pnpm = join(root, 'fake pnpm.mjs');
    const log = join(root, 'commands.log');
    writeFileSync(pnpm, `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ')); process.exit(23);`);
    vi.stubEnv('npm_execpath', pnpm);
    await expect(packagePlugin({ root, fetchImpl })).rejects.toThrow('failed (23)');
    expect(readFileSync(log, 'utf8')).toBe('install --frozen-lockfile');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(existsSync(join(root, 'youtube-cast-receiver.zip'))).toBe(false);
  });

  it('runs the frozen install and both builds through pnpm without shell quoting', async () => {
    const pnpm = join(root, 'fake pnpm.mjs');
    const log = join(root, 'commands.log');
    writeFileSync(pnpm, `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');`);
    vi.stubEnv('npm_execpath', pnpm);
    const output = await packagePlugin({ root, fetchImpl });
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
      'install --frozen-lockfile', 'run build --forceExit', 'run build:backend',
    ]);
    expect(existsSync(output)).toBe(true);
  });

  it('retries failed transfers and removes incomplete files on final failure', async () => {
    const destination = join(root, 'download');
    const fetchRetry = vi.fn()
      .mockResolvedValueOnce(new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array([1])); controller.error(new Error('connection lost')); },
      })))
      .mockResolvedValueOnce(new Response('complete'));
    await download('https://example.invalid/fixture', destination, fetchRetry);
    expect(fetchRetry).toHaveBeenCalledTimes(2);
    expect(readFileSync(destination, 'utf8')).toBe('complete');
    rmSync(destination);
    const fetchFailure = vi.fn(async () => new Response('', { status: 503 }));
    await expect(download('https://example.invalid/fixture', destination, fetchFailure)).rejects.toThrow('Download failed');
    expect(fetchFailure).toHaveBeenCalledTimes(3);
    expect(existsSync(destination)).toBe(false);
  });

  it('rejects non-Linux and non-x64 binaries', () => {
    const arm = linuxBinary();
    arm.writeUInt16LE(183, 18);
    expect(() => validateLinuxX64(arm, 'node')).toThrow('Linux x86_64');
    expect(() => validateLinuxX64(Buffer.from('MZ Windows binary'), 'yt-dlp')).toThrow('Linux x86_64');
  });
});
