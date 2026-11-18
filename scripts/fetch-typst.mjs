// Downloads the pinned Typst CLI (the PDF export sidecar) and the bundled fallback fonts, verifies
// their SHA-256 checksums, and puts them where Tauri expects them:
//
//   src-tauri/binaries/typst-<target-triple>[.exe]   (bundle.externalBin "binaries/typst")
//   src-tauri/resources/fonts/*.ttf                   (bundle.resources -> <resources>/fonts)
//
//   node scripts/fetch-typst.mjs                                  host target (from `rustc -vV`)
//   node scripts/fetch-typst.mjs --target x86_64-pc-windows-msvc  a given target
//   node scripts/fetch-typst.mjs --target universal-apple-darwin  both macOS archs + a lipo'd
//                                                                 universal binary (macOS only)
//
// Both are needed before any `cargo build`/`cargo test`/`tauri build`: tauri-build copies the
// sidecar and the resources at compile time and fails if they are missing. Archives are cached in
// .cache/sidecar (CI caches that folder, keyed on this file); a cached archive is used only if its
// checksum still matches. Nothing here runs at app runtime: export itself is fully offline.
//
// Licences: Typst is Apache-2.0 (its LICENSE and NOTICE ship in src-tauri/resources/licenses);
// Liberation fonts 2.1.5 are SIL OFL 1.1. See THIRD_PARTY_LICENSES.md and scripts/check-licenses.mjs.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const TYPST_VERSION = '0.15.1'

/** Release assets of Typst v0.15.1 (SHA-256 from the GitHub release's asset digests). */
export const TYPST_ASSETS = {
  'x86_64-pc-windows-msvc': {
    file: 'typst-x86_64-pc-windows-msvc.zip',
    sha256: '19ce3551153c2fe7ee9fa2f95208310c8f4d3209fedb699e0333faf8913f6736',
  },
  'aarch64-pc-windows-msvc': {
    file: 'typst-aarch64-pc-windows-msvc.zip',
    sha256: '4ab28e1b71ec3184d38d580ab797f499b6770d952b6b19167be5cea5c2662e14',
  },
  'aarch64-apple-darwin': {
    file: 'typst-aarch64-apple-darwin.tar.xz',
    sha256: '48f62ed034aa3a7978309579ac6ca00045e2ef0da73114e8af27cfd8e74dc05a',
  },
  'x86_64-apple-darwin': {
    file: 'typst-x86_64-apple-darwin.tar.xz',
    sha256: '7f9fdd9584866245de9a79e0add8f9236fae6f40a8a45e2c4771ccc14db4e0fa',
  },
  // Linux is a dev convenience only (no Linux release); the static musl build runs on gnu hosts.
  'x86_64-unknown-linux-gnu': {
    file: 'typst-x86_64-unknown-linux-musl.tar.xz',
    sha256: 'a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c',
  },
}

/** Liberation fonts 2.1.5 (SIL OFL 1.1): metric-compatible with Times New Roman and Courier New. */
export const FONTS = {
  url: 'https://github.com/liberationfonts/liberation-fonts/files/7261482/liberation-fonts-ttf-2.1.5.tar.gz',
  file: 'liberation-fonts-ttf-2.1.5.tar.gz',
  sha256: '7191c669bf38899f73a2094ed00f7b800553364f90e2637010a69c0e268f25d0',
  dir: 'liberation-fonts-ttf-2.1.5',
  files: [
    'LiberationSerif-Regular.ttf',
    'LiberationSerif-Bold.ttf',
    'LiberationSerif-Italic.ttf',
    'LiberationSerif-BoldItalic.ttf',
    'LiberationMono-Regular.ttf',
    'LiberationMono-Bold.ttf',
    'LiberationMono-Italic.ttf',
    'LiberationMono-BoldItalic.ttf',
  ],
}

const CACHE = process.env.NOVEL_SIDECAR_CACHE ?? join(ROOT, '.cache', 'sidecar')
const BIN_DIR = join(ROOT, 'src-tauri', 'binaries')
const FONT_DIR = join(ROOT, 'src-tauri', 'resources', 'fonts')

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

/** The cached archive, downloaded if missing or stale; throws on a checksum mismatch. */
async function fetchVerified(url, file, expected) {
  mkdirSync(CACHE, { recursive: true })
  const path = join(CACHE, file)
  if (existsSync(path) && sha256(path) === expected) return path
  console.log(`fetch-typst: downloading ${url}`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`fetch-typst: ${url}: HTTP ${res.status}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  const got = createHash('sha256').update(bytes).digest('hex')
  if (got !== expected) throw new Error(`fetch-typst: checksum mismatch for ${file}: expected ${expected}, got ${got}`)
  writeFileSync(path, bytes)
  return path
}

/** Extract `archive` into a fresh folder (after its checksum was verified) and return the folder. */
function extract(archive, name) {
  const out = join(CACHE, `x-${name}`)
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  if (archive.endsWith('.zip') && process.platform !== 'win32') {
    execFileSync('unzip', ['-q', archive, '-d', out], { stdio: 'inherit' })
  } else {
    // bsdtar (Windows 10+, macOS) reads zip, tar.gz and tar.xz; GNU tar reads the tarballs. On
    // Windows use System32's bsdtar: Git's GNU tar (often first on PATH) reads `F:\...` as a host.
    const tar =
      process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
    execFileSync(tar, ['-xf', archive, '-C', out], { stdio: 'inherit' })
  }
  return out
}

function findFile(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      const hit = findFile(p, name)
      if (hit) return hit
    } else if (entry.name === name) return p
  }
  return null
}

/** Sidecar file name Tauri looks for: binaries/typst-<triple>[.exe]. */
export const sidecarName = (triple) => `typst-${triple}${triple.includes('windows') ? '.exe' : ''}`

async function fetchTypst(triple) {
  const asset = TYPST_ASSETS[triple]
  if (!asset) throw new Error(`fetch-typst: no Typst ${TYPST_VERSION} build pinned for ${triple}`)
  const url = `https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/${asset.file}`
  const dir = extract(await fetchVerified(url, asset.file, asset.sha256), triple)
  const exe = findFile(dir, triple.includes('windows') ? 'typst.exe' : 'typst')
  if (!exe) throw new Error(`fetch-typst: typst binary not found in ${asset.file}`)
  mkdirSync(BIN_DIR, { recursive: true })
  const target = join(BIN_DIR, sidecarName(triple))
  copyFileSync(exe, target)
  if (process.platform !== 'win32') chmodSync(target, 0o755)
  rmSync(dir, { recursive: true, force: true })
  console.log(`fetch-typst: typst ${TYPST_VERSION} -> ${target}`)
  return target
}

async function fetchFonts() {
  const dir = extract(await fetchVerified(FONTS.url, FONTS.file, FONTS.sha256), 'fonts')
  mkdirSync(FONT_DIR, { recursive: true })
  for (const f of FONTS.files) copyFileSync(join(dir, FONTS.dir, f), join(FONT_DIR, f))
  rmSync(dir, { recursive: true, force: true })
  console.log(`fetch-typst: ${FONTS.files.length} Liberation fonts -> ${FONT_DIR}`)
}

function hostTriple() {
  try {
    const host = /^host: (\S+)$/m.exec(execFileSync('rustc', ['-vV'], { encoding: 'utf8' }))
    if (host) return host[1]
  } catch {
    // No rustc: fall back to the platform.
  }
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  if (process.platform === 'win32') return `${arch}-pc-windows-msvc`
  if (process.platform === 'darwin') return `${arch}-apple-darwin`
  return `${arch}-unknown-linux-gnu`
}

async function main() {
  const i = process.argv.indexOf('--target')
  const target = i > 0 ? process.argv[i + 1] : hostTriple()
  if (target === 'universal-apple-darwin') {
    // tauri-build copies the per-arch sidecar while cargo builds each arch, and the bundler wants
    // the universal one for the universal app.
    const arm = await fetchTypst('aarch64-apple-darwin')
    const intel = await fetchTypst('x86_64-apple-darwin')
    const universal = join(BIN_DIR, sidecarName('universal-apple-darwin'))
    execFileSync('lipo', ['-create', '-output', universal, arm, intel], { stdio: 'inherit' })
    chmodSync(universal, 0o755)
    console.log(`fetch-typst: lipo -> ${universal}`)
  } else {
    await fetchTypst(target)
  }
  await fetchFonts()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
