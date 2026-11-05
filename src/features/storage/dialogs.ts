import { message } from '@tauri-apps/plugin-dialog'
import { ProjectError } from './format'

/** Show an error dialog for any failure; ProjectErrors keep their friendly text. */
export async function showError(title: string, err: unknown): Promise<void> {
  const text =
    err instanceof ProjectError
      ? err.message
      : 'Something went wrong. Your work has not been lost; please try again.'
  if (!(err instanceof ProjectError)) console.error(err)
  try {
    await message(text, { title, kind: 'error' })
  } catch (e) {
    // The dialog itself failed (e.g. not running in Tauri): never crash.
    console.error(title, text, e)
  }
}

/** An information message (e.g. what Save a Copy left out). Never throws. */
export async function showNotice(title: string, text: string): Promise<void> {
  try {
    await message(text, { title, kind: 'info' })
  } catch (e) {
    console.warn(title, text, e)
  }
}

export type UnsavedChoice = 'save' | 'discard' | 'cancel'

/** Three-way unsaved-changes prompt. */
export async function askUnsavedChanges(projectTitle: string | null, action: string): Promise<UnsavedChoice> {
  const what = projectTitle ? `"${projectTitle}" has unsaved changes.` : 'You have unsaved changes.'
  const result = await message(`${what} Do you want to save them before ${action}?`, {
    title: 'Unsaved changes',
    kind: 'warning',
    buttons: { yes: 'Save', no: "Don't Save", cancel: 'Cancel' },
  })
  if (result === 'Yes' || result === 'Save') return 'save'
  if (result === 'No' || result === "Don't Save") return 'discard'
  return 'cancel'
}
