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
  zoomOut: { id: 'pagination.zoomOut', label: 'Zoom out' },
  zoom: { id: 'pagination.zoom', label: 'Zoom' },
  zoomIn: { id: 'pagination.zoomIn', label: 'Zoom in' },
  spreadView: { id: 'pagination.spreadView', label: 'Two-page spread' },
} as const satisfies Record<string, PaginationControlMeta>

export type PaginationControlKey = keyof typeof PAGINATION_CONTROLS
