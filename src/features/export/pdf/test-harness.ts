/**
 * TEST-ONLY (Node): renders the bundled manuscript template with the real Typst sidecar, the way Rust
 * does it (src-tauri/src/export/render.rs: private temp dir, empty package folders, a dead proxy,
 * bundled fonts only), and reads the PDF back with pdfjs-dist. The sidecar and fonts come from
 * `pnpm fetch:typst`; without them the tests that use this skip, unless NOVEL_REQUIRE_TYPST=1 (CI's
 * Rust and e2e jobs, which fetch them) makes a missing sidecar a failure. Also used by the Phase 4
 * acceptance e2e, which renders the request the app sent to the (fake) Rust command for real.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// import.meta.url, not __dirname: Playwright (e2e/phase4-acceptance.spec.ts) loads this file as an ES module.
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
export const TEMPLATE_PATH = join(ROOT, 'src-tauri', 'templates', 'manuscript.typ')
export const FONTS_DIR = join(ROOT, 'src-tauri', 'resources', 'fonts')

/** The fetched sidecar for this host (src-tauri/binaries/typst-<triple>[.exe]), or null. */
export function findSidecar(): string | null {
  const dir = join(ROOT, 'src-tauri', 'binaries')
  if (!existsSync(dir) || !existsSync(join(FONTS_DIR, 'LiberationSerif-Regular.ttf'))) return null
  const exe = readdirSync(dir).find((f) => f.startsWith('typst-') && (process.platform === 'win32' ? f.endsWith('.exe') : !f.includes('.')))
  return exe ? join(dir, exe) : null
}

export const SIDECAR = findSidecar()
export const REQUIRE_TYPST = process.env.NOVEL_REQUIRE_TYPST === '1'

const BUNDLED = { serif: 'Liberation Serif', mono: 'Liberation Mono' } as const

export interface SidecarRender {
  pdf: Uint8Array
  ms: number
  stderr: string
}

/** Render `data` (the template's data.json) with the bundled `font` role; rejects on a compile error. */
export function renderWithSidecar(data: unknown, font: 'serif' | 'mono' = 'serif', template = readFileSync(TEMPLATE_PATH, 'utf8')): Promise<SidecarRender> {
  if (!SIDECAR) throw new Error('The Typst sidecar is missing: run `pnpm fetch:typst`.')
  const dir = mkdtempSync(join(tmpdir(), 'novel-typst-test-'))
  writeFileSync(join(dir, 'main.typ'), template)
  writeFileSync(join(dir, 'data.json'), typeof data === 'string' ? data : JSON.stringify(data))
  mkdirSync(join(dir, 'packages'))
  mkdirSync(join(dir, 'package-cache'))
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) env[k] = 'http://127.0.0.1:9'
  for (const k of ['NO_PROXY', 'no_proxy', 'TYPST_ROOT', 'TYPST_FONT_PATHS', 'TYPST_PACKAGE_PATH', 'TYPST_PACKAGE_CACHE_PATH', 'SOURCE_DATE_EPOCH']) delete env[k]
  // DUPLICATES the Typst command line Rust builds (src-tauri/src/export/render.rs, `command()` and
  // `offline_env()`, with the inputs of mod.rs `run_job`). Keep the two in step when either changes.
  const args = [
    'compile',
    '--root', dir,
    '--package-path', join(dir, 'packages'),
    '--package-cache-path', join(dir, 'package-cache'),
    '--ignore-embedded-fonts',
    '--ignore-system-fonts',
    '--font-path', FONTS_DIR,
    '--diagnostic-format', 'short',
    '--input', `font=${BUNDLED[font]}`,
    '--input', `font-fallback=${BUNDLED[font]}`,
    join(dir, 'main.typ'),
    join(dir, 'out.pdf'),
  ]
  const started = performance.now()
  return new Promise((res, rej) => {
    execFile(SIDECAR, args, { env, cwd: dir, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (err, _stdout, stderr) => {
      const ms = Math.round(performance.now() - started)
      try {
        if (err) return rej(new Error(`typst failed: ${stderr || err.message}`))
        res({ pdf: new Uint8Array(readFileSync(join(dir, 'out.pdf'))), ms, stderr })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
}

export interface TextItem {
  str: string
  x: number
  /** Baseline, pt from the bottom edge (PDF space). */
  y: number
  width: number
  /** Font size, pt (superscripts are smaller). */
  size: number
  font: string
}

export interface PdfPage {
  number: number
  width: number
  height: number
  items: TextItem[]
  /** Lines: items grouped by baseline (top to bottom), each line's text joined. */
  lines: { y: number; x: number; text: string }[]
  text: string
}

export interface ReadPdf {
  pages: PdfPage[]
  info: Record<string, unknown>
  /** Font names the PDF embeds (pdfjs `loadedName`s are internal; these are the BaseFont names). */
  fonts: string[]
}

/** Lines of full-size text (superscript footnote numbers are left out: they sit off the baseline). */
function lineGroups(items: TextItem[]): PdfPage['lines'] {
  const byY = new Map<number, TextItem[]>()
  const full = Math.max(0, ...items.map((i) => i.size))
  for (const it of items) {
    if (it.size < full - 0.5) continue
    const key = Math.round(it.y * 10) / 10
    const row = [...byY.keys()].find((k) => Math.abs(k - key) < 0.6)
    const list = byY.get(row ?? key) ?? []
    list.push(it)
    byY.set(row ?? key, list)
  }
  return [...byY.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([y, row]) => {
      row.sort((a, b) => a.x - b.x)
      return { y, x: row[0].x, text: row.map((r) => r.str).join('') }
    })
}

/** Text of each page with positions, and the document info, via pdfjs-dist. */
export async function readPdf(pdf: Uint8Array): Promise<ReadPdf> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await getDocument({ data: pdf.slice(), verbosity: 0, useSystemFonts: false }).promise
  const pages: PdfPage[] = []
  const fonts = new Set<string>()
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n)
    const [, , width, height] = page.view
    const tc = await page.getTextContent()
    const items: TextItem[] = []
    for (const raw of tc.items) {
      if (!('str' in raw) || raw.str === '') continue
      items.push({ str: raw.str, x: raw.transform[4], y: raw.transform[5], width: raw.width, size: Math.hypot(raw.transform[0], raw.transform[1]), font: raw.fontName })
    }
    const lines = lineGroups(items)
    pages.push({ number: n, width, height, items, lines, text: lines.map((l) => l.text).join('\n') })
  }
  const meta = await doc.getMetadata()
  const raw = new TextDecoder('latin1').decode(pdf)
  for (const m of raw.matchAll(/\/BaseFont\s*\/(?:[A-Z]{6}\+)?([^\s/[\]<>()]+)/g)) fonts.add(m[1].replace(/-Identity-H$/, ''))
  await doc.destroy()
  return { pages, info: (meta.info ?? {}) as Record<string, unknown>, fonts: [...fonts].sort() }
}
