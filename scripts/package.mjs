import { createHash } from 'node:crypto';
import { createWriteStream, chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { zipSync, unzipSync } from 'fflate';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const NODE_VERSION = 'v20.18.3';
export const NODE_ARCHIVE = `node-${NODE_VERSION}-linux-x64.tar.gz`;
const NODE_BASE = `https://nodejs.org/dist/${NODE_VERSION}`;
const YTDLP_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
export const REQUIRED = [
  'dist/index.js', 'backend/out/server.cjs',
  'backend/xml/app-desc.xml', 'backend/xml/device-desc.xml',
  'bin/node', 'bin/yt-dlp', 'package.json', 'plugin.json', 'main.py', 'LICENSE',
];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? result.signal})`);
}

export function buildProject(root) {
  // pnpm supplies its JS entry point on all hosts, avoiding Windows .cmd/shell quoting.
  const pnpm = process.env.npm_execpath;
  if (!pnpm) throw new Error('Run through pnpm: pnpm run package (or use --skip-build for existing artifacts).');
  run(process.execPath, [pnpm, 'install', '--frozen-lockfile'], root);
  // The existing TypeScript plugin can leave file watchers alive after emission.
  // Rollup's CLI exits after a completed one-shot build with this flag.
  run(process.execPath, [pnpm, 'run', 'build', '--forceExit'], root);
  run(process.execPath, [pnpm, 'run', 'build:backend'], root);
}

export async function download(url, destination, fetchImpl = fetch) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(300000) });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { flags: 'wx' }));
      return;
    } catch (error) {
      rmSync(destination, { force: true });
      if (attempt === 3) throw new Error(`Download failed: ${url}: ${error.message}`, { cause: error });
    }
  }
}

function verifyChecksum(file, sums, name) {
  const entry = readFileSync(sums, 'utf8').split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1]?.replace(/^\*/, '') === name);
  if (!entry || hash(readFileSync(file)) !== entry[0].toLowerCase()) {
    throw new Error(`SHA-256 mismatch or missing checksum for ${name}`);
  }
}

export function validateLinuxX64(bytes, name) {
  // ELF64, little-endian, EM_X86_64. Never package a host macOS/Windows/ARM executable.
  if (bytes.length < 20 || bytes.subarray(0, 4).toString('hex') !== '7f454c46'
      || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== 62) {
    throw new Error(`${name} must be a Linux x86_64 ELF executable`);
  }
}

export async function ensureBinaries(root, { fetchImpl = fetch } = {}) {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const metadata = join(bin, '.package-binaries.json');
  try {
    const cached = JSON.parse(readFileSync(metadata, 'utf8'));
    if (cached.nodeVersion === NODE_VERSION && cached.ytdlpAsset === 'yt-dlp_linux') {
      for (const name of ['node', 'yt-dlp']) {
        const bytes = readFileSync(join(bin, name));
        validateLinuxX64(bytes, name);
        if (hash(bytes) !== cached[name]) throw new Error(`Invalid cached ${name}`);
        chmodSync(join(bin, name), 0o755);
      }
      console.log('Using verified cached Linux x64 binaries.');
      return;
    }
  } catch {
    // Missing, old or damaged cache: download verified replacements below.
  }
  const work = mkdtempSync(join(bin, '.package-'));
  try {
    console.log(`Downloading Node ${NODE_VERSION} and yt-dlp for Linux x64...`);
    const archive = join(work, NODE_ARCHIVE);
    const sums = join(work, 'node-sha256.txt');
    await download(`${NODE_BASE}/${NODE_ARCHIVE}`, archive, fetchImpl);
    await download(`${NODE_BASE}/SHASUMS256.txt`, sums, fetchImpl);
    verifyChecksum(archive, sums, NODE_ARCHIVE);
    // macOS/Linux tar and Windows 10/11 bsdtar support .tar.gz. Extract only Node.
    const tar = process.platform === 'win32' && process.env.SystemRoot
      ? join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';
    const member = `node-${NODE_VERSION}-linux-x64/bin/node`;
    run(tar, ['-xzf', archive, '-C', work, member], root);
    const node = join(work, member);
    const ytdlp = join(work, 'yt-dlp');
    const ytdlpSums = join(work, 'ytdlp-sha256.txt');
    await download(`${YTDLP_BASE}/yt-dlp_linux`, ytdlp, fetchImpl);
    await download(`${YTDLP_BASE}/SHA2-256SUMS`, ytdlpSums, fetchImpl);
    verifyChecksum(ytdlp, ytdlpSums, 'yt-dlp_linux');
    const cached = { nodeVersion: NODE_VERSION, ytdlpAsset: 'yt-dlp_linux' };
    for (const [name, file] of [['node', node], ['yt-dlp', ytdlp]]) {
      const bytes = readFileSync(file);
      validateLinuxX64(bytes, name);
      cached[name] = hash(bytes);
      chmodSync(file, 0o755);
    }
    // Publish only after both downloads, checksums and architectures validate.
    copyFileSync(node, join(work, 'node'));
    renameSync(join(work, 'node'), join(bin, 'node'));
    renameSync(ytdlp, join(bin, 'yt-dlp'));
    chmodSync(join(bin, 'node'), 0o755);
    writeFileSync(join(work, 'metadata.json'), JSON.stringify(cached));
    renameSync(join(work, 'metadata.json'), metadata);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function pluginName(root) {
  const name = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8')).name;
  if (typeof name !== 'string' || !name.trim() || /[\\/\x00-\x1f]/.test(name) || name === '.' || name === '..') {
    throw new Error('plugin.json name must be a single ZIP directory name');
  }
  return name;
}

function collectFiles(root) {
  const files = [];
  function visit(relative) {
    const file = join(root, relative);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error(`Symlink not allowed in package: ${relative}`);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(file).sort()) visit(`${relative}/${entry}`);
    } else if (stat.isFile()) {
      files.push(relative);
    } else {
      throw new Error(`Not a regular file: ${relative}`);
    }
  }
  // Keep the production layout; copy only the current backend and explicit binaries.
  for (const path of ['dist', 'backend/out/server.cjs', 'backend/xml', 'bin/node', 'bin/yt-dlp', 'package.json', 'plugin.json', 'main.py', 'LICENSE']) visit(path);
  for (const path of REQUIRED) {
    if (!files.includes(path) || lstatSync(join(root, path)).size === 0) throw new Error(`Missing or empty required file: ${path}`);
  }
  return files;
}

export function validatePackage(bytes, name) {
  const files = unzipSync(bytes);
  const prefix = `${name}/`;
  for (const path of Object.keys(files)) {
    if (!path.startsWith(prefix) || path.includes('\\') || path.split('/').includes('..')) throw new Error(`Invalid ZIP path: ${path}`);
  }
  for (const path of REQUIRED) {
    if (!files[`${prefix}${path}`]?.length) throw new Error(`Missing or empty ZIP entry: ${path}`);
  }
  for (const path of ['bin/node', 'bin/yt-dlp']) validateLinuxX64(Buffer.from(files[prefix + path]), path);
  if (files[prefix + 'backend/out/server.js'] || files[prefix + 'backend/out/package.json']) throw new Error('Stale backend files in ZIP');
}

export async function packagePlugin({ root = ROOT, skipBuild = false, fetchImpl = fetch } = {}) {
  if (!skipBuild) buildProject(root);
  const name = pluginName(root);
  await ensureBinaries(root, { fetchImpl });
  const files = collectFiles(root);
  const work = mkdtempSync(join(root, '.package-'));
  try {
    const entries = {};
    for (const file of files) {
      const mode = file.startsWith('bin/') ? 0o100755 : 0o100644;
      entries[`${name}/${file}`] = [readFileSync(join(root, file)), { os: 3, attrs: (mode << 16) >>> 0 }];
    }
    const bytes = zipSync(entries, { level: 6 });
    validatePackage(bytes, name);
    const staged = join(work, 'plugin.zip');
    writeFileSync(staged, bytes);
    const output = join(root, 'youtube-cast-receiver.zip');
    renameSync(staged, output); // Preserve the previous ZIP until the replacement is complete.
    console.log(`Packaged ${output} (${(bytes.length / 1024 / 1024).toFixed(1)} MiB)`);
    return output;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--skip-build')) {
    console.error('Usage: pnpm run package [--skip-build]');
    process.exitCode = 1;
  } else {
    packagePlugin({ skipBuild: args.includes('--skip-build') }).catch((error) => {
      console.error(`Packaging failed: ${error.message}`);
      process.exitCode = 1;
    });
  }
}
