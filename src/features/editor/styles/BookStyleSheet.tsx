import { useMemo } from 'react'
import { buildStyleSheetCSS } from '@/shared/book'
import { useResolvedStyles } from './resolved'

/** The manuscript's content element; generated style rules are scoped under it. */
export const STYLE_SCOPE = '.novel-editor-content'

/**
 * The generated paragraph/chapter stylesheet as one `<style>` element. A style edit re-renders only
 * this element (O(number of styles)); the document and its DOM are untouched, the browser restyles.
 */
export function BookStyleSheet({ scope = STYLE_SCOPE }: { scope?: string }) {
  const styles = useResolvedStyles()
  const css = useMemo(() => buildStyleSheetCSS(styles, scope), [styles, scope])
  return <style data-testid="book-styles">{css}</style>
}
