import type { Page } from '@playwright/test'

/**
 * Where keyboard focus is, in a form that reads in a CI log:
 * `BUTTON[data-control-id=pagination.zoomIn][aria-label=Zoom in]`, or `BODY` when nothing is focused.
 * Runs in the page.
 */
export function describeActiveElement(): string {
  const el = document.activeElement
  if (!el) return '(none)'
  const attrs = ['data-control-id', 'data-testid', 'aria-label', 'role', 'contenteditable']
    .map((a) => (el.hasAttribute(a) ? `[${a}=${el.getAttribute(a)!.slice(0, 40)}]` : ''))
    .join('')
  const id = el.id ? `#${el.id}` : ''
  return `${el.tagName}${id}${attrs}`
}

/**
 * Wrap the body of an `expect(...).toPass()` retry block: when an attempt fails, log which element has
 * focus before rethrowing, so a real focus steal (macOS Chromium has shown late focus returns) is
 * visible in the CI log instead of being absorbed silently by the retry. `log` is for tests.
 */
export function logFocusOnRetry(
  page: Pick<Page, 'evaluate'>,
  label: string,
  body: () => Promise<void>,
  log: (line: string) => void = (line) => console.info(line),
): () => Promise<void> {
  let attempt = 0
  return async () => {
    attempt++
    try {
      await body()
    } catch (e) {
      const active = await page.evaluate(describeActiveElement).catch((err: unknown) => `(unavailable: ${String(err).slice(0, 80)})`)
      log(`[focus] ${label}: attempt ${attempt} failed; document.activeElement = ${active}`)
      throw e
    }
  }
}
