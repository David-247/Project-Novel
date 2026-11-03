// License gate for JS dependencies (production and dev): fails on any license that is not on the
// MIT-compatible allowlist. Rust crates are checked by cargo-deny (src-tauri/deny.toml).
//
//   pnpm licenses list --json > licenses.json && node scripts/check-licenses.mjs licenses.json
//   (or: node scripts/check-licenses.mjs, which runs pnpm itself)
//
// pnpm groups packages by their declared license expression. An SPDX expression passes when it is
// satisfiable with allowlisted licenses: "A OR B" needs one side, "A AND B" needs both.
// MPL-2.0 is file-level copyleft: fine to use unmodified (see README "Licenses").
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

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
export function allowedExpression(expr) {
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
    return ALLOWED.has(t?.replace(/\+$/, ''))
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

function main() {
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
