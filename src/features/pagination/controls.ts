/**
 * Stable identities and accessible names of the pagination controls (status bar). The tooltips
 * registry derives titles from here and adds descriptions. Same shape as the editor slice's
 * ToolbarControlMeta.
 */
export interface PaginationControlMeta {
  id: string
  label: string
  shortcut?: string | readonly string[]
}

export const PAGINATION_CONTROLS = {
  zoomOut: { id: 'pagination.zoomOut', label: 'Zoom out', shortcut: 'Mod--' },
  zoom: { id: 'pagination.zoom', label: 'Zoom' },
  zoomIn: { id: 'pagination.zoomIn', label: 'Zoom in', shortcut: 'Mod-=' },
  spreadView: { id: 'pagination.spreadView', label: 'Two-page spread' },
  // Book mode's page-turn controls on the desk edges (the View menu's commands share these ids).
  previousSpread: { id: 'pagination.previousSpread', label: 'Previous pages' },
  nextSpread: { id: 'pagination.nextSpread', label: 'Next pages' },
  // The status bar's page indicator: a button that opens Edit > Go to Page.
  pageIndicator: { id: 'pagination.pageIndicator', label: 'Go to page', shortcut: 'Mod-Alt-g' },
} as const satisfies Record<string, PaginationControlMeta>

export type PaginationControlKey = keyof typeof PAGINATION_CONTROLS
