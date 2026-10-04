#!/usr/bin/env node
// Installs a static Windows ffmpeg build as a Tauri sidecar.
//
// The app must never depend on whatever ffmpeg the user happens to have: the
// Scoop shim in particular is a console wrapper that flashes a black window on
// every spawn and can double-spawn the real binary. Shipping our own static
// build fixes both problems and makes the packaged app portable.
//
// Output: src-tauri/binaries/ffmpeg-<target>.exe  (Tauri externalBin convention)
//
// Usage: node scripts/fetch-ffmpeg.mjs [--force] [--source <url>]
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat, copyFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const execFileAsync = promisify(execFile);

// ffmpeg is GPL-2.0-or-later; a static build with libx264 has no shared-library
// licence obligations beyond shipping the licence text, which we do in the
// bundle README and in binaries/FFMPEG-LICENSE.txt.
const DEFAULT_SOURCES = ['https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'];

const MIN_SIZE_BYTES = 8 * 1024 * 1024;
// Tauri names external binaries after the Rust target triple
// (ffmpeg-<triple>.exe), so ask the toolchain rather than guessing from Node's
// arch/platform aliases.
async function targetTriple() {
  if (process.env.FLUENT_IPTV_TARGET_TRIPLE) return process.env.FLUENT_IPTV_TARGET_TRIPLE;
  try {
    const { stdout } = await execFileAsync('rustc', ['-vV'], { timeout: 15000 });
    const host = /^host:\s*(\S+)$/m.exec(stdout)?.[1];
    if (host) return host;
  } catch {
    // rustc not on PATH; fall through to the conventional host triple.
  }
  return 'x86_64-pc-windows-msvc';
}
const ROOT = path.resolve(import.meta.dirname, '..');
const BIN_DIR = path.join(ROOT, 'src-tauri', 'binaries');

const args = process.argv.slice(2);
const force = args.includes('--force');
const sources = args.includes('--source')
  ? [args[args.indexOf('--source') + 1]]
  : DEFAULT_SOURCES;

async function usable(file) {
  try {
    const { size } = await stat(file);
    return size > MIN_SIZE_BYTES;
  } catch {
    return false;
  }
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const total = Number(res.headers.get('content-length') || 0);
  let seen = 0;
  let lastTick = 0;
  const sink = createWriteStream(dest);
  const source = Readable.fromWeb(res.body);
  source.on('data', (chunk) => {
    seen += chunk.length;
    const now = Date.now();
    if (now - lastTick > 1000) {
      lastTick = now;
      const mb = (seen / 1048576).toFixed(1);
      const pct = total ? ` / ${(total / 1048576).toFixed(1)} MB` : '';
      process.stdout.write(`  ${mb}${pct} MB\r`);
    }
  });
  await pipeline(source, sink);
  process.stdout.write('\n');
}

async function extractOnly(zip, wanted) {
  const tmp = path.join(os.tmpdir(), `ffmpeg-sidecar-${process.pid}`);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  // Expand-Archive ships with Windows; bsdtar also handles zip on Win10+.
  try {
    await execFileAsync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${tmp}' -Force`,
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
  } catch {
    await execFileAsync('tar', ['-xf', zip, '-C', tmp], { maxBuffer: 64 * 1024 * 1024 });
  }
  for (const name of wanted) {
    const found = await findFile(tmp, name);
    if (found) return { file: found, cleanupDir: tmp };
  }
  await rm(tmp, { recursive: true, force: true });
  throw new Error(`archive does not contain ${wanted.join(' or ')}`);
}

async function findFile(dir, name, depth = 0) {
  const { readdir } = await import('node:fs/promises');
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name) return full;
  }
  if (depth > 3) return null;
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const hit = await findFile(path.join(dir, entry.name), name, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

async function version(binary) {
  try {
    const { stdout } = await execFileAsync(binary, ['-version'], { timeout: 20000 });
    return stdout.split(/\r?\n/)[0].trim();
  } catch (e) {
    return `unknown (${e.message})`;
  }
}

async function main() {
  const target = await targetTriple();
  const dest = path.join(BIN_DIR, `ffmpeg-${target}.exe`);
  if (!existsSync(BIN_DIR)) await mkdir(BIN_DIR, { recursive: true });

  if (!force && (await usable(dest))) {
    console.log(`[fetch-ffmpeg] already present: ${path.relative(ROOT, dest)}`);
    console.log(`[fetch-ffmpeg] ${await version(dest)}`);
    return;
  }

  const tmpZip = path.join(os.tmpdir(), `ffmpeg-sidecar-${process.pid}.zip`);
  const failures = [];
  try {
    for (const url of sources) {
      console.log(`[fetch-ffmpeg] downloading ${url}`);
      try {
        await download(url, tmpZip);
        const { file, cleanupDir } = await extractOnly(tmpZip, ['ffmpeg.exe']);
        try {
          await copyFile(file, dest);
        } finally {
          await rm(cleanupDir, { recursive: true, force: true });
        }
        console.log(`[fetch-ffmpeg] installed ${path.relative(ROOT, dest)}`);
        console.log(`[fetch-ffmpeg] ${await version(dest)}`);
        await writeFile(
          path.join(BIN_DIR, 'FFMPEG-LICENSE.txt'),
          await licenseNotice(await version(dest)),
          'utf8',
        );
        return;
      } catch (e) {
        failures.push(`${url}: ${e.message}`);
        console.warn(`[fetch-ffmpeg] source failed: ${e.message}`);
      } finally {
        await rm(tmpZip, { force: true });
      }
    }
  } finally {
    await rm(tmpZip, { force: true });
  }

  throw new Error(
    `could not obtain a static ffmpeg build.\n  ${failures.join('\n  ')}\n` +
      'Provide the binary manually as src-tauri/binaries/' +
      `ffmpeg-${target}.exe, or point --source at a mirror.`,
  );
}

async function licenseNotice(versionLine) {
  return [
    'Bundled ffmpeg',
    '==============',
    '',
    versionLine,
    '',
    'Source: https://www.gyan.dev/ffmpeg/builds/ (static Windows build,',
    'essentials configuration, includes libx264 and libx265).',
    '',
    'ffmpeg is licensed under the GNU General Public License, version 2 or later.',
    'The complete licence text ships inside the ffmpeg source distribution at',
    'https://ffmpeg.org/legal.html and https://www.gnu.org/licenses/old-licenses/gpl-2.0.html',
    '',
    'ffmpeg is a free software project. This bundled binary is redistributed',
    'unmodified under the terms of that licence.',
    '',
  ].join('\n');
}

main().catch((e) => {
  console.error(`[fetch-ffmpeg] ${e.message}`);
  process.exit(1);
});