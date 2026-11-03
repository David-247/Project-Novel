// jsdom lacks layout APIs ProseMirror touches when scrolling the selection into view.
const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) }

export function installLayoutPolyfills() {
  const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  if (!Range.prototype.getClientRects) Range.prototype.getClientRects = emptyRects
  if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => rect as DOMRect
  Element.prototype.getClientRects ??= emptyRects
  if (!document.elementFromPoint) document.elementFromPoint = () => null
}
