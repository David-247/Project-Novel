// Real-app smoke test (Windows; also works on Linux with WebKitWebDriver).
// macOS has no WKWebView WebDriver, so the cross-platform suite is Playwright (e2e/).
//
// Usage: node e2e-tauri/smoke.mjs <path to built app binary> [--mode tauri-driver|attach|auto]
//
//  - tauri-driver (default on Linux): `tauri-driver` (cargo install tauri-driver) on PATH starts
//    the app through the native driver: msedgedriver on Windows (matching the installed WebView2
//    runtime; on PATH, or its path or folder in EDGEWEBDRIVER / NATIVE_DRIVER).
//  - attach (Windows): start the app ourselves with a DevTools port for its WebView2
//    (WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=N) and attach msedgedriver to
//    it (ms:edgeOptions.debuggerAddress), Microsoft's documented way to drive a running WebView2 app.
//  - auto (default on Windows): tauri-driver, then attach when the session cannot be created.
//    Both pass on a Windows desktop. On GitHub's Windows runners both fail: WebView2 there ignores
//    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS (and the AdditionalBrowserArguments policy), so no DevTools
//    port opens; msedgedriver reports "DevToolsActivePort file doesn't exist". CI keeps it non-blocking.
//
// Plain WebDriver over HTTP (no client library). Exit code 0 = pass.
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const modeAt = args.indexOf('--mode')
const MODE = modeAt >= 0 ? args.splice(modeAt, 2)[1] : process.platform === 'win32' ? 'auto' : 'tauri-driver'
const app = resolve(args[0] ?? 'src-tauri/target/release/novel.exe')
if (!existsSync(app)) {
  console.error(`smoke: app binary not found: ${app}`)
  process.exit(2)
}
const DRIVER_PORT = Number(process.env.TAURI_DRIVER_PORT ?? 4444)
const EDGE_PORT = Number(process.env.EDGEDRIVER_PORT ?? 4445)
const DEVTOOLS_PORT = Number(process.env.WEBVIEW2_DEVTOOLS_PORT ?? 9229)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function nativeDriver() {
  let p = process.env.NATIVE_DRIVER ?? process.env.EDGEWEBDRIVER
  if (!p) return null
  // GitHub's Windows images set EDGEWEBDRIVER to the folder that holds msedgedriver.exe.
  if (statSync(p).isDirectory()) p = join(p, process.platform === 'win32' ? 'msedgedriver.exe' : 'WebKitWebDriver')
  return p
}

/** Processes to stop at the end. */
const children = []
function start(cmd, argv, opts = {}) {
  const child = spawn(cmd, argv, { stdio: ['ignore', 'inherit', 'inherit'], ...opts })
  child.on('error', (e) => console.error(`smoke: could not start ${cmd}: ${e.message}`))
  children.push(child)
  return child
}

function webdriver(base) {
  return async function wd(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json.value ?? json).slice(0, 400)}`)
    return json.value
  }
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

/** tauri-driver launches the app through the native driver. */
async function viaTauriDriver() {
  const native = nativeDriver()
  start(process.env.TAURI_DRIVER ?? 'tauri-driver', ['--port', String(DRIVER_PORT), ...(native ? ['--native-driver', native] : [])])
  const base = `http://127.0.0.1:${DRIVER_PORT}`
  await waitFor(async () => (await fetch(`${base}/status`)).ok, 'tauri-driver')
  const wd = webdriver(base)
  const created = await wd('POST', '/session', {
    capabilities: { alwaysMatch: { browserName: 'wry', 'tauri:options': { application: app } } },
  })
  return { wd, session: created.sessionId }
}

/** Start the app with a WebView2 DevTools port and attach msedgedriver to it. */
async function viaAttach() {
  const native = nativeDriver() ?? 'msedgedriver'
  start(app, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${DEVTOOLS_PORT}` },
  })
  const version = await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json/version`)
    return r.ok ? r.json() : null
  }, `the app's WebView2 DevTools port ${DEVTOOLS_PORT}`)
  console.log(`smoke: WebView2 DevTools endpoint up (${version.Browser ?? 'unknown browser'})`)
  start(native, [`--port=${EDGE_PORT}`])
  const base = `http://127.0.0.1:${EDGE_PORT}`
  await waitFor(async () => (await fetch(`${base}/status`)).ok, 'msedgedriver')
  const wd = webdriver(base)
  const created = await wd('POST', '/session', {
    capabilities: { alwaysMatch: { browserName: 'webview2', 'ms:edgeOptions': { debuggerAddress: `127.0.0.1:${DEVTOOLS_PORT}` } } },
  })
  return { wd, session: created.sessionId }
}

function stopAll() {
  while (children.length) children.pop().kill()
}

// The W3C WebDriver element reference key.
const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf'

async function checks(wd, session) {
  const find = (css) => wd('POST', `/session/${session}/element`, { using: 'css selector', value: css })
  const list = [
    ['app controls', 'header[aria-label="App controls"]'],
    ['formatting toolbar', '[role="toolbar"][aria-label="Formatting"]'],
    ['bold button', '[data-control-id="toolbar.bold"]'],
    ['editor', 'main [contenteditable="true"][aria-label="Manuscript"]'],
    ['status bar', 'footer[aria-label="Status bar"] [role="status"]'],
    // Phase 2: the paginated view draws page frames; the book layout picker is in the toolbar.
    ['page frame', '.nv-frames .nv-page'],
    ['trim size picker', '[data-control-id="book.trimSize"]'],
  ]
  for (const [name, css] of list) {
    const el = await waitFor(() => find(css), name)
    // (Legacy JSON-wire drivers answer { ELEMENT }.)
    const id = el[ELEMENT] ?? el.ELEMENT
    if (!id) throw new Error(`${name}: unexpected element reference ${JSON.stringify(el)}`)
    const shown = await wd('GET', `/session/${session}/element/${id}/displayed`)
    if (!shown) throw new Error(`${name} is not displayed`)
    console.log(`smoke: ${name} rendered`)
  }
  return wd('GET', `/session/${session}/title`)
}

const modes = MODE === 'auto' ? ['tauri-driver', 'attach'] : [MODE]
let passed = false
for (const mode of modes) {
  let s
  try {
    console.log(`smoke: mode ${mode}`)
    s = mode === 'attach' ? await viaAttach() : await viaTauriDriver()
    const title = await checks(s.wd, s.session)
    console.log(`smoke: window title "${title}"; PASS (${mode})`)
    passed = true
  } catch (e) {
    console.error(`smoke: ${mode}: FAIL: ${e.message}`)
  } finally {
    if (s) await s.wd('DELETE', `/session/${s.session}`).catch((e) => console.warn('smoke: closing session:', e.message))
    stopAll()
    await sleep(500)
  }
  if (passed) break
}
process.exit(passed ? 0 : 1)
