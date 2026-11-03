import type { ReactElement } from 'react'
import type { PaperSurface } from '@/shared/book'
import { useStore } from '@/shared/store'
import { cn, controlBase, Tooltip } from '@/shared/ui'
import { SURFACE_CONTROLS, SURFACE_OPTIONS } from './surface'
import './surface-picker.css'

export interface SurfacePickerProps {
  /**
   * Wraps each option's control (already inside its Tooltip) so the host can make it part of a
   * roving-focus toolbar: `(el) => <ToolbarItem>{el}</ToolbarItem>`. Defaults to no wrapping.
   */
  wrap?: (control: ReactElement, option: { value: PaperSurface }) => ReactElement
  className?: string
}

/** A miniature page (or open spread) painted with the real tokens of one surface. */
function Page({ surface, scheme }: { surface: 'white' | 'dark' | 'book'; scheme: 'light' | 'dark' }) {
  const lines = (
    <>
      <i />
      <i />
      <i />
    </>
  )
  return (
    <span className="nv-surface-preview nv-swatch-desk" data-surface={surface} data-theme={scheme} aria-hidden="true">
      {surface === 'book' ? (
        <>
          <span className="nv-page nv-page--verso nv-swatch-page">{lines}</span>
          <span className="nv-page nv-page--recto nv-swatch-page">{lines}</span>
        </>
      ) : (
        <span className="nv-page nv-swatch-page">{lines}</span>
      )}
    </span>
  )
}

function Swatch({ value, scheme }: { value: PaperSurface; scheme: 'light' | 'dark' }) {
  if (value === 'auto') {
    // Auto is two papers, split on the diagonal: white for light mode, dark for dark mode.
    return (
      <span className="nv-swatch nv-swatch-auto" aria-hidden="true">
        <Page surface="white" scheme={scheme} />
        <Page surface="dark" scheme={scheme} />
      </span>
    )
  }
  return (
    <span className="nv-swatch" aria-hidden="true">
      <Page surface={value} scheme={scheme} />
    </span>
  )
}

/**
 * Paper picker: a segmented radio group with a small swatch of each paper. Choosing one writes
 * `book.surface`; the page repaints at once (colours only, nothing reflows). Same control ids and
 * tooltips as everywhere: the group is `book.surface`, each option `book.surface.<value>`.
 */
export function SurfacePicker({ wrap = (c) => c, className }: SurfacePickerProps) {
  const surface = useStore((s) => s.book.surface)
  const scheme = useStore((s) => s.app.colorScheme)
  const setSurface = useStore((s) => s.bookActions.setSurface)
  return (
    <div
      role="radiogroup"
      aria-label={SURFACE_CONTROLS.group.label}
      data-control-id={SURFACE_CONTROLS.group.id}
      className={cn('inline-flex items-center gap-0.5 rounded-panel bg-surface-hover/60 p-0.5', className)}
    >
      {SURFACE_OPTIONS.map((o) => {
        const checked = surface === o.value
        return wrap(
          <Tooltip key={o.id}>
            <button
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={o.label}
              data-control-id={o.id}
              data-state={checked ? 'on' : 'off'}
              onClick={() => setSurface(o.value)}
              className={cn(
                controlBase,
                'relative gap-1.5 px-1.5',
                checked
                  ? 'bg-accent-soft text-accent after:absolute after:inset-x-2 after:bottom-0.5 after:h-0.5 after:rounded-full after:bg-accent'
                  : 'text-text-muted hover:bg-surface-hover hover:text-text',
              )}
            >
              <Swatch value={o.value} scheme={scheme} />
              <span className="hidden lg:inline">{o.label}</span>
            </button>
          </Tooltip>,
          { value: o.value },
        )
      })}
    </div>
  )
}
