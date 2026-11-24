#!/usr/bin/env node
// Builds standalone SPX-GC executables with @yao-pkg/pkg and assembles a
// ready-to-run folder per target in pkg-builds/:
//
//   pkg-builds/spx-gc-<version>-<platform>-<arch>/
//     spx-gc(.exe)   the server, with views/ and static/ embedded
//     ASSETS/        templates, plugins, media   (read from disk at runtime)
//     DATAROOT/      example projects            (read from disk at runtime)
//     locales/       UI language files           (read from disk at runtime)
//     LOG/           log folder
//
// The runtime folders live next to the executable because the app resolves
// them via spx.getStartUpFolder() (path of the executable when packaged).
//
// Usage:
//   node scripts/build.js                      build all targets
//   node scripts/build.js linux-x64 win-x64    build selected targets
//   node scripts/build.js --host               build only for this machine

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_ROOT = path.join(ROOT, 'pkg-builds');
const NODE_RANGE = 'node22';
const ALL_TARGETS = ['linux-x64', 'linux-arm64', 'macos-x64', 'macos-arm64', 'win-x64'];
const RUNTIME_FOLDERS = ['ASSETS', 'DATAROOT', 'locales'];
const EXTRA_FILES = ['LICENSE.txt', 'README.md'];
const WINDOWS_ONLY_FILES = ['utils/talk.vbs']; // text-to-speech helper, resolved from startup folder

const pkgJson = require(path.join(ROOT, 'package.json'));

function hostTarget() {
  const platform = { linux: 'linux', darwin: 'macos', win32: 'win' }[process.platform];
  if (!platform) throw new Error(`Unsupported host platform: ${process.platform}`);
  return `${platform}-${process.arch}`;
}

function parseTargets(args) {
  if (args.includes('--host')) return [hostTarget()];
  const targets = args.filter((a) => !a.startsWith('-'));
  if (targets.length === 0) return ALL_TARGETS;
  const unknown = targets.filter((t) => !ALL_TARGETS.includes(t));
  if (unknown.length) {
    throw new Error(`Unknown target(s): ${unknown.join(', ')}. Valid: ${ALL_TARGETS.join(', ')}`);
  }
  return targets;
}

// Files to ship from a runtime folder. Uses git so that untracked, gitignored
// user content (own projects, templates) never ends up in a release.
function listFiles(folder) {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--', folder], { cwd: ROOT, encoding: 'utf8' });
    return out.split('\0').filter(Boolean);
  } catch (e) {
    console.warn(`  git not available, copying ${folder}/ as-is`);
    return fs
      .readdirSync(path.join(ROOT, folder), { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => path.relative(ROOT, path.join(d.parentPath || d.path, d.name)));
  }
}

function copyFile(rel, destDir) {
  const dest = path.join(destDir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(ROOT, rel), dest);
}

async function buildTarget(target) {
  const [platform, arch] = target.split('-');
  const name = `spx-gc-${pkgJson.version}-${target}`;
  const outDir = path.join(OUT_ROOT, name);
  const exe = path.join(outDir, platform === 'win' ? 'spx-gc.exe' : 'spx-gc');

  console.log(`\n=== ${name} ===`);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  // --no-bytecode/--public ship plain JS (the project is MIT licensed). This
  // avoids running the target's Node binary at build time, so every target
  // can be cross-built from any host.
  const { exec } = require('@yao-pkg/pkg');
  await exec([
    ROOT,
    '--target', `${NODE_RANGE}-${platform}-${arch}`,
    '--output', exe,
    '--no-bytecode',
    '--public',
    '--public-packages', '*',
  ]);

  for (const folder of RUNTIME_FOLDERS) {
    const files = listFiles(folder);
    files.forEach((f) => copyFile(f, outDir));
    console.log(`  copied ${files.length} files from ${folder}/`);
  }
  fs.mkdirSync(path.join(outDir, 'LOG'), { recursive: true });
  EXTRA_FILES.forEach((f) => copyFile(f, outDir));
  if (platform === 'win') WINDOWS_ONLY_FILES.forEach((f) => copyFile(f, outDir));

  console.log(`  -> ${path.relative(ROOT, outDir)}`);
}

async function main() {
  const targets = parseTargets(process.argv.slice(2));
  console.log(`Building SPX-GC ${pkgJson.version} for: ${targets.join(', ')}`);
  for (const t of targets) await buildTarget(t);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
