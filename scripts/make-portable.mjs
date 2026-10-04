#!/usr/bin/env node
// Assembles a portable Fluent IPTV build: no installer, no registry, no PATH
// requirements. Copy the folder anywhere on a Windows machine with the WebView2
// runtime (preinstalled on Windows 11) and run FluentIPTV.exe.
//
// Usage: node scripts/make-portable.mjs [--out <dir>] [--zip]
import { existsSync } from 'node:fs';
import { copyFile, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(import.meta.dirname, '..');
const RELEASE = path.join(ROOT, 'src-tauri', 'target', 'release');
const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const OUT = path.resolve(
  ROOT,
  outIndex >= 0 ? args[outIndex + 1] : path.join('artifacts', `FluentIPTV-${pkg.version}-portable`),
);
const WANT_ZIP = args.includes('--zip');

// The sidecar is fetched by `npm run ffmpeg:fetch` before the release build, and
// Tauri stages it next to the binary as plain `ffmpeg.exe`.
const REQUIRED = ['fluent-iptv.exe', 'ffmpeg.exe'];
const OPTIONAL = [
  ['binaries/FFMPEG-LICENSE.txt', path.join('binaries', 'FFMPEG-LICENSE.txt')],
];

async function main() {
  const missing = REQUIRED.filter((f) => !existsSync(path.join(RELEASE, f)));
  if (missing.length) {
    throw new Error(
      `missing from ${path.relative(ROOT, RELEASE)}: ${missing.join(', ')}\n` +
        'Build the release binary first:  npm run app:portable',
    );
  }

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  await copyFile(path.join(RELEASE, 'fluent-iptv.exe'), path.join(OUT, 'FluentIPTV.exe'));
  await copyFile(path.join(RELEASE, 'ffmpeg.exe'), path.join(OUT, 'ffmpeg.exe'));
  for (const [from, to] of OPTIONAL) {
    const src = path.join(RELEASE, from);
    if (!existsSync(src)) continue;
    const dest = path.join(OUT, to);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(src, dest);
  }

  const version = await exeVersion(path.join(OUT, 'ffmpeg.exe'));
  await writeFile(path.join(OUT, 'README.txt'), readme(version), 'utf8');

  console.log(`[portable] ${path.relative(ROOT, OUT)}/`);
  for (const entry of ['FluentIPTV.exe', 'ffmpeg.exe', 'binaries/FFMPEG-LICENSE.txt', 'README.txt']) {
    console.log(`[portable]   ${entry}`);
  }
  console.log(`[portable] ffmpeg: ${version}`);

  if (WANT_ZIP) await zip(OUT);
}

async function exeVersion(binary) {
  try {
    const { stdout } = await execFileAsync(binary, ['-version'], { timeout: 20000 });
    return stdout.split(/\r?\n/)[0].trim();
  } catch (e) {
    return `unknown (${e.message})`;
  }
}

async function zip(dir) {
  const zipPath = `${dir}.zip`;
  await rm(zipPath, { force: true });
  // 7-Zip is markedly faster on a ~120 MB payload; Compress-Archive is the
  // everywhere-else fallback.
  try {
    await execFileAsync('7z', ['a', '-tzip', '-bso0', '-bsp0', `${zipPath}.tmp`, dir], {
      maxBuffer: 32 * 1024 * 1024,
    });
    await rename(`${zipPath}.tmp`, zipPath);
  } catch {
    await rm(`${zipPath}.tmp`, { force: true });
    console.log('[portable] 7-Zip unavailable, falling back to Compress-Archive');
    await execFileAsync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Compress-Archive -Path '${dir}' -DestinationPath '${zipPath}' -Force`,
      ],
      { maxBuffer: 32 * 1024 * 1024, timeout: 15 * 60 * 1000 },
    );
  }
  console.log(`[portable] ${path.relative(ROOT, zipPath)}`);
}

async function rename(from, to) {
  const { rename: fsRename } = await import('node:fs/promises');
  await fsRename(from, to);
}

function readme(ffmpegVersion) {
  return [
    'Fluent IPTV — portable build',
    '============================',
    '',
    'Run FluentIPTV.exe. Nothing to install, nothing to add to PATH.',
    '',
    'Requirements',
    '------------',
    '  * Windows 10 1809 or newer, 64-bit',
    '  * Microsoft Edge WebView2 Runtime (preinstalled on Windows 11)',
    '',
    'Contents',
    '--------',
    '  FluentIPTV.exe            the player',
    '  ffmpeg.exe                bundled transcoder (do not remove)',
    '  binaries/FFMPEG-LICENSE.txt',
    '',
    'Notes',
    '-----',
    '  * ffmpeg is bundled so the app never depends on a system install and',
    '    never flashes a console window when it spawns a transcoder.',
    '  * The app starts a local media server on 127.0.0.1:8787 (or the next',
    '    free port). Diagnostics: curl http://127.0.0.1:8787/api/sessions',
    '  * Set FFMPEG_PATH to override the bundled ffmpeg if you really want to.',
    '',
    `  ${ffmpegVersion}`,
    '  ffmpeg is licensed under the GNU General Public License v2 or later;',
    '  see binaries/FFMPEG-LICENSE.txt.',
    '',
  ].join('\n');
}

main().catch((e) => {
  console.error(`[portable] ${e.message}`);
  process.exit(1);
});