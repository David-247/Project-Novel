// Provider isolation gate (run by `pnpm lint`): provider-specific code lives in two places only,
// the webview adapters under src/features/ai-tutor/providers/ and Rust's src-tauri/src/ai/providers.rs.
//
// The rule is deliberately narrow, so it catches real provider-specific code and not the id union
// ('anthropic' | 'openai' | ... in connections/types.ts, the fake core, UI labels), which is plain data:
//   1. No SDK provider import (`@ai-sdk/<name>`) outside providers/. The provider-neutral packages
//      `@ai-sdk/provider` and `@ai-sdk/provider-utils` are fine. Test files (*.test.ts[x]) and
//      src/test-utils are exempt, since they only build a model to drive the code under test.
//   2. No provider API host outside those two places: a request target baked in elsewhere would
//      bypass the descriptor table (and the CSP-closed proxy's host rules). Tests (and Rust `#[cfg(test)]`
//      modules) are exempt here too; they may name a host as test data.
//
//   node scripts/check-provider-isolation.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Places allowed to be provider-specific (posix paths relative to the repo root). */
export const ALLOWED_PREFIXES = [
  'src/features/ai-tutor/providers/',
  'src-tauri/src/ai/providers.rs',
  // Dev-only Task 1 spike, deleted in Task 9 (then drop this line).
  'src/features/ai-tutor/spike.ts',
]

const SDK_IMPORT = /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)['"]@ai-sdk\/(?!provider(?:-utils)?['"/])[\w.-]+/
const HOSTS =
  /api\.anthropic\.com|api\.openai\.com|chatgpt\.com\/backend-api|api\.x\.ai|api\.deepseek\.com|open\.bigmodel\.cn|dashscope[\w.-]*\.aliyuncs\.com|openrouter\.ai\/api/i

const isTest = (p) => /\.test\.tsx?$/.test(p) || p.startsWith('src/test-utils/')

/** The violations in one file's text: [{ line, rule }]. */
export function violations(path, text) {
  if (ALLOWED_PREFIXES.some((a) => path.startsWith(a))) return []
  if (isTest(path)) return []
  // Rust unit tests sit at the end of a file after `#[cfg(test)]`; their hosts are test data.
  if (path.endsWith('.rs')) text = text.split('#[cfg(test)]')[0]
  const out = []
  text.split('\n').forEach((line, i) => {
    if (SDK_IMPORT.test(line)) out.push({ line: i + 1, rule: 'SDK provider package import outside providers/' })
    if (HOSTS.test(line)) out.push({ line: i + 1, rule: 'provider API host outside providers/ and providers.rs' })
  })
  return out
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'target', 'dist', 'gen'].includes(name)) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (/\.(ts|tsx|mjs|js|rs)$/.test(name)) yield full
  }
}

export function check(root = ROOT) {
  const found = []
  for (const base of ['src', 'src-tauri/src']) {
    for (const file of walk(join(root, base))) {
      const rel = relative(root, file).split(sep).join('/')
      for (const v of violations(rel, readFileSync(file, 'utf8'))) found.push(`${rel}:${v.line}: ${v.rule}`)
    }
  }
  return found
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const found = check()
  if (found.length) {
    console.error(`Provider isolation: ${found.length} violation(s)\n${found.join('\n')}`)
    process.exit(1)
  }
  console.log('Provider isolation: ok')
}
