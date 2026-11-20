/**
 * "Connect a Provider…": opens Settings ▸ AI Tutor. The settings slice is wired in by the composition
 * root (setTutorConnectAction(() => openSettings(AI_SETTINGS_PAGE_ID))), so this slice never imports it.
 */
let action: (() => void) | null = null

export function setTutorConnectAction(fn: (() => void) | null): void {
  action = fn
}

export function connectProvider(): void {
  action?.()
}
