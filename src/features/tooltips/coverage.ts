import type { TooltipCopy } from '@/shared/ui'
import { getTooltipCopy, TOOLTIP_REGISTRY } from './registry'

/**
 * Opt-out for a control's hidden helper element (aria-hidden, tabindex -1) that another control
 * drives, e.g. the colour input behind Settings > Author colour. Use on nothing a user can reach.
 */
export const TOOLTIP_PROXY_ATTR = 'data-tooltip-proxy'

/** Everything a user can operate: native controls plus ARIA widget roles. */
export const CONTROL_SELECTOR = [
  'button',
  'select',
  'textarea',
  'input:not([type="hidden"])',
  'a[href]',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="combobox"]',
  '[role="textbox"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="option"]',
].join(', ')

export type CoverageReason =
  /** The control has no `data-control-id`, so no tooltip can be looked up for it. */
  | 'missing-id'
  /** Its id has no entry in the registry. */
  | 'unregistered'
  /** Registered, but not wrapped in `<Tooltip>` (no description linked via aria-describedby). */
  | 'not-wired'

export interface CoverageProblem {
  element: Element
  controlId: string | null
  reason: CoverageReason
  /** Short human-readable pointer for assertion messages. */
  label: string
}

function describe(el: Element): string {
  const name = el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? ''
  return `<${el.tagName.toLowerCase()}${el.getAttribute('role') ? ` role="${el.getAttribute('role')}"` : ''}> "${name}"`
}

function describedByText(el: Element): string {
  const ids = el.getAttribute('aria-describedby')?.split(/\s+/).filter(Boolean) ?? []
  const doc = el.ownerDocument
  return ids.map((id) => doc.getElementById(id)?.textContent ?? '').join(' ')
}

/**
 * Lists every interactive control under `root` that would show no tooltip. The manuscript itself
 * (the contenteditable writing surface) is the document, not a control, and is skipped, as is an
 * element marked `data-tooltip-proxy` (hidden, out of the tab order, driven by a real control).
 */
export function auditTooltipCoverage(
  root: ParentNode,
  registry: Readonly<Record<string, TooltipCopy>> = TOOLTIP_REGISTRY,
): CoverageProblem[] {
  const problems: CoverageProblem[] = []
  for (const el of Array.from(root.querySelectorAll(CONTROL_SELECTOR))) {
    if (el.getAttribute('contenteditable') === 'true') continue
    // An explicit proxy no one operates directly (the colour input the Author colour button opens):
    // the control that drives it carries the tooltip.
    if (el.hasAttribute(TOOLTIP_PROXY_ATTR)) continue
    const controlId = el.getAttribute('data-control-id')
    const label = describe(el)
    if (!controlId) {
      problems.push({ element: el, controlId, reason: 'missing-id', label })
      continue
    }
    // The app's registry includes copy derived from registered commands (menu items).
    const copy =
      registry === TOOLTIP_REGISTRY
        ? getTooltipCopy(controlId)
        : Object.prototype.hasOwnProperty.call(registry, controlId)
          ? registry[controlId]
          : undefined
    if (!copy) {
      problems.push({ element: el, controlId, reason: 'unregistered', label })
      continue
    }
    const expected = copy.description ?? copy.title
    if (!describedByText(el).includes(expected)) {
      problems.push({ element: el, controlId, reason: 'not-wired', label })
    }
  }
  return problems
}

/** Formats problems for a test failure message. */
export function formatCoverageProblems(problems: CoverageProblem[]): string {
  return problems.map((p) => `${p.reason}: ${p.label}${p.controlId ? ` [${p.controlId}]` : ''}`).join('\n')
}
