/**
 * "Connect a Provider…": opens Settings ▸ AI Tutor. The settings slice is wired in by the composition
 * root (setTutorConnectAction), so this slice never imports it (Task 10's AI Tutor page will import
 * this one). TODO(Task 10): open the AI Tutor page itself once openSettings takes a page id.
 */
let action: (() => void) | null = null

export function setTutorConnectAction(fn: (() => void) | null): void {
  action = fn
}

export function connectProvider(): void {
  action?.()
}
