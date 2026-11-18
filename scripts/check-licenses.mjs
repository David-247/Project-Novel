// License gate for JS dependencies (production and dev): fails on any license that is not on the
// MIT-compatible allowlist. Rust crates are checked by cargo-deny (src-tauri/deny.toml).
//
//   pnpm licenses list --json > licenses.json && node scripts/check-licenses.mjs licenses.json
//   (or: node scripts/check-licenses.mjs, which runs pnpm itself)
//
// pnpm groups packages by their declared license expression. An SPDX expression passes when it is
// satisfiable with allowlisted licenses: "A OR B" needs one side, "A AND B" needs both.
// MPL-2.0 is file-level copyleft: fine to use unmodified (see README "Licenses").
// It also checks the bundled non-package files (Typst sidecar, fonts): see BUNDLED below.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { TYPST_VERSION } from './fetch-typst.mjs'

export const ALLOWED = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Apache-2.0',
  'MPL-2.0',
  'CC0-1.0',
  'CC-BY-4.0', // data/docs only (e.g. caniuse-lite)
  'Unlicense',
  'BlueOak-1.0.0',
])

/** True when the SPDX expression can be satisfied with allowlisted licenses. */
export function allowedExpression(expr, allowed = ALLOWED) {
  const tokens = String(expr).replace(/[()]/g, (p) => ` ${p} `).trim().split(/\s+/).filter(Boolean)
  let i = 0
  // or := and ('OR' and)* ; and := atom ('AND' atom)* ; atom := LICENSE ['WITH' EXC] | '(' or ')'
  const atom = () => {
    const t = tokens[i++]
    if (t === '(') {
      const v = or()
      i++ // ')'
      return v
    }
    if (tokens[i] === 'WITH') i += 2
    return allowed.has(t?.replace(/\+$/, ''))
  }
  const and = () => {
    let v = atom()
    while (tokens[i] === 'AND') {
      i++
      v = atom() && v
    }
    return v
  }
  const or = () => {
    let v = and()
    while (tokens[i] === 'OR') {
      i++
      v = and() || v
    }
    return v
  }
  return tokens.length > 0 && or() && i === tokens.length
}

/**
 * Third-party files shipped in the app that are neither npm packages nor crates: the Typst sidecar
 * (bundle.externalBin) and the bundled fonts (bundle.resources). Each must have an allowlisted
 * licence, its licence text in src-tauri/resources/licenses (shipped with the app), and an entry in
 * THIRD_PARTY_LICENSES.md.
 */
export const BUNDLED = [
  {
    name: 'Typst CLI',
    version: TYPST_VERSION,
    // LPPL-1.3c: data inside the binary (translation tables adapted from Babel/Cleveref, per Typst's
    // NOTICE), redistributed unmodified. Licence decision logged by the Phase 4 controller.
    license: 'Apache-2.0 AND LPPL-1.3c',
    note: 'LPPL-1.3c covers embedded language data, shipped unmodified',
    externalBin: 'binaries/typst',
    texts: ['typst-LICENSE.txt', 'typst-NOTICE.txt'],
  },
  {
    name: 'Liberation Fonts',
    version: '2.1.5',
    license: 'OFL-1.1',
    resources: 'resources/fonts/',
    texts: ['liberation-fonts-LICENSE.txt'],
  },
]

/**
 * Bundled files may also be under the SIL Open Font License (fonts: constraint "OFL or similar") and
 * the LaTeX Project Public License 1.3c (OSI-approved; only for data shipped unmodified inside the
 * Typst binary). Neither is allowed for npm packages or crates.
 */
export const BUNDLED_ALLOWED = new Set([...ALLOWED, 'OFL-1.1', 'LPPL-1.3c'])

/** Problems with the bundled assets (empty = OK). `root` is the repo root. */
export function checkBundled(root, bundled = BUNDLED) {
  const problems = []
  const conf = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'))
  const notices = readFileSync(join(root, 'THIRD_PARTY_LICENSES.md'), 'utf8')
  for (const b of bundled) {
    if (!allowedExpression(b.license, BUNDLED_ALLOWED)) problems.push(`${b.name}: licence ${b.license} is not allowed`)
    for (const t of b.texts) {
      if (!existsSync(join(root, 'src-tauri', 'resources', 'licenses', t))) problems.push(`${b.name}: missing licence text ${t}`)
    }
    if (!notices.includes(`${b.name} ${b.version}`)) problems.push(`${b.name} ${b.version} is not in THIRD_PARTY_LICENSES.md`)
    else if (!notices.includes(`\`${b.license}\``)) problems.push(`${b.name}: licence \`${b.license}\` is not stated in THIRD_PARTY_LICENSES.md`)
  }
  // Nothing may be bundled without an entry above.
  for (const bin of conf.bundle?.externalBin ?? []) {
    if (!bundled.some((b) => b.externalBin === bin)) problems.push(`externalBin ${bin} has no licence entry`)
  }
  for (const res of Object.keys(conf.bundle?.resources ?? {})) {
    if (res !== 'resources/licenses/' && !bundled.some((b) => b.resources === res)) {
      problems.push(`resource ${res} has no licence entry`)
    }
  }
  return problems
}

function main() {
  const bundledProblems = checkBundled(join(dirname(fileURLToPath(import.meta.url)), '..'))
  if (bundledProblems.length) {
    console.error(`check-licenses: bundled third-party files:\n  ${bundledProblems.join('\n  ')}`)
    process.exit(1)
  }
  console.log(`check-licenses: bundled OK (${BUNDLED.map((b) => `${b.name} ${b.version}: ${b.license}`).join('; ')})`)
  const file = process.argv[2]
  const json = file
    ? readFileSync(file, 'utf8')
    : execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['licenses', 'list', '--json'], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        shell: process.platform === 'win32',
      })
  const groups = JSON.parse(json)
  const bad = []
  let count = 0
  for (const [license, pkgs] of Object.entries(groups)) {
    count += pkgs.length
    if (allowedExpression(license)) continue
    for (const p of pkgs) bad.push(`${p.name}@${(p.versions ?? [p.version]).join(',')}: ${license}`)
  }
  if (bad.length) {
    console.error(`check-licenses: ${bad.length} package(s) with a license outside the allowlist:\n  ${bad.join('\n  ')}`)
    process.exit(1)
  }
  console.log(`check-licenses: OK (${count} packages; licenses: ${Object.keys(groups).sort().join(', ')})`)
  const mpl = Object.entries(groups)
    .filter(([license]) => license.includes('MPL'))
    .flatMap(([, pkgs]) => pkgs.map((p) => p.name))
  if (mpl.length) console.log(`check-licenses: MPL-2.0 (file-level copyleft, used unmodified): ${mpl.join(', ')}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
