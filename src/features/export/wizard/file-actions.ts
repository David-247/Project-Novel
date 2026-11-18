import { ExportPlatformError } from '../platform'

/**
 * What Open file / Show in folder says when it fails (the file was moved or deleted since the export,
 * or the system could not start the program), shown by the file it is about.
 */
export function fileActionProblem(e: unknown, what: 'open' | 'show', name: string): string {
  const verb = what === 'open' ? 'open' : 'show'
  if (e instanceof ExportPlatformError && e.kind === 'not_exported') {
    return `Novel could not ${verb} ${name}: it is no longer where it was exported (moved, renamed or deleted).`
  }
  const message = e instanceof Error ? e.message : String(e)
  return `Novel could not ${verb} ${name}: ${message}`
}
