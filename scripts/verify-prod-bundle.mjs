// Fails if a production bundle (default dist/) contains the e2e-only fake Tauri backend.
// Run after `pnpm build`. The markers exist only in src/test-utils/e2e-backend.ts.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MARKERS = ['nv-e2e-fake-fs', '__nvE2E', '[e2e-backend]', 'installE2EBackend']
const root = process.argv[2] ?? 'dist'

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else yield p
  }
}

let files = 0
const hits = []
for (const file of walk(root)) {
  if (!/\.(js|mjs|html|map)$/.test(file)) continue
  files++
  const text = readFileSync(file, 'utf8')
  for (const m of MARKERS) if (text.includes(m)) hits.push(`${file}: ${m}`)
}
if (files === 0) {
  console.error(`verify-prod-bundle: no JS/HTML files under ${root}; run the build first`)
  process.exit(2)
}
if (hits.length) {
  console.error('verify-prod-bundle: e2e fake backend found in the bundle:\n' + hits.join('\n'))
  process.exit(1)
}
console.log(`verify-prod-bundle: OK (${files} files in ${root}, no e2e backend markers)`)
