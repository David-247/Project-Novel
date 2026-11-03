// Real-app smoke test (Windows; also works on Linux with WebKitWebDriver) via tauri-driver.
// macOS has no WKWebView WebDriver, so the cross-platform suite is Playwright (e2e/).
//
// Usage: node e2e-tauri/smoke.mjs <path to built app binary>
// Needs `tauri-driver` (cargo install tauri-driver) on PATH and, on Windows, msedgedriver
// matching the installed WebView2 runtime: on PATH, or its path in EDGEWEBDRIVER / NATIVE_DRIVER.
// Plain WebDriver over HTTP (no client library). Exit code 0 = pass.
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const app = resolve(process.argv[2] ?? 'src-tauri/target/release/novel.exe')
if (!existsSync(app)) {
  console.error(`smoke: app binary not found: ${app}`)
  process.exit(2)
}
const PORT = Number(process.env.TAURI_DRIVER_PORT ?? 4444)
const base = `http://127.0.0.1:${PORT}`

function nativeDriverArgs() {
  let p = process.env.NATIVE_DRIVER ?? process.env.EDGEWEBDRIVER
  if (!p) return []
  // GitHub's Windows images set EDGEWEBDRIVER to the folder that holds msedgedriver.exe.
  if (statSync(p).isDirectory()) p = join(p, process.platform === 'win32' ? 'msedgedriver.exe' : 'WebKitWebDriver')
  return ['--native-driver', p]
}

const driver = spawn(process.env.TAURI_DRIVER ?? 'tauri-driver', ['--port', String(PORT), ...nativeDriverArgs()], {
  stdio: ['ignore', 'inherit', 'inherit'],
})
driver.on('error', (e) => {
  console.error('smoke: could not start tauri-driver:', e.message)
  process.exit(2)
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function wd(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json.value ?? json)}`)
  return json.value
}

async function waitFor(fn, what, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs
  let last
  while (Date.now() < end) {
    try {
      const v = await fn()
      if (v) return v
    } catch (e) {
      last = e
    }
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`)
}

const ELEMENT = 'element-6066-11e4-a52f-4a6563f4d6b6'
let session
let failed = false
try {
  await waitFor(async () => (await fetch(`${base}/status`)).ok, 'tauri-driver')
  const created = await wd('POST', '/session', {
    capabilities: { alwaysMatch: { browserName: 'wry', 'tauri:options': { application: app } } },
  })
  session = created.sessionId
  const find = (css) => wd('POST', `/session/${session}/element`, { using: 'css selector', value: css })
  const checks = [
    ['toolbar', 'header[aria-label="Toolbar"]'],
    ['formatting toolbar', '[role="toolbar"][aria-label="Formatting"]'],
    ['bold button', '[data-control-id="toolbar.bold"]'],
    ['editor', 'main [contenteditable="true"][aria-label="Manuscript"]'],
    ['status bar', 'footer[aria-label="Status bar"] [role="status"]'],
  ]
  for (const [name, css] of checks) {
    const el = await waitFor(() => find(css), name)
    const shown = await wd('GET', `/session/${session}/element/${el[ELEMENT]}/displayed`)
    if (!shown) throw new Error(`${name} is not displayed`)
    console.log(`smoke: ${name} rendered`)
  }
  const title = await wd('GET', `/session/${session}/title`)
  console.log(`smoke: window title "${title}"; PASS`)
} catch (e) {
  failed = true
  console.error('smoke: FAIL:', e.message)
} finally {
  if (session) await wd('DELETE', `/session/${session}`).catch((e) => console.warn('smoke: closing session:', e.message))
  driver.kill()
}
process.exit(failed ? 1 : 0)
