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

/**
 * After a Save that left something unsaved (`detail` says which file and why): stay (Cancel), or go on
 * with the changes kept only in the crash-recovery backup (`continueLabel`).
 */
export async function askLeftUnsaved(detail: string, continueLabel: string): Promise<'continue' | 'cancel'> {
  const result = await message(
    `${detail} Your other changes were saved. If you go on now, the unsaved changes are kept only in the automatic backup, which Novel offers to restore the next time you open the project.`,
    { title: 'Some changes were not saved', kind: 'warning', buttons: { ok: continueLabel, cancel: 'Cancel' } },
  )
  return result === continueLabel || result === 'Ok' ? 'continue' : 'cancel'
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
