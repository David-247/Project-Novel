// Public interface of the "outline" slice (Phase 4: the navigation pane). Other slices import ONLY from here.
//
// View ▸ Navigation Pane, modelled on Word's Navigation Pane (Headings): a tree of Front matter, the
// chapters (number and title, or "Untitled chapter N") and their subheadings (outline level 2), each
// with its word count (the store's `wordCount`) and page range (the store's `layout`), the total at the
// foot. Click, Enter or tap goes to the heading (both navigation modes) and gives the focus back to the
// manuscript. The current heading follows the caret and the spread in view. See docs/design.md,
// "Navigation pane".
//
// Wiring (composition root):
// - <NavigationPane /> as AppShell's `navigation` (docked left; floats over the pages in a narrow window).
// - registerOutlineCommands(): View ▸ Navigation Pane (Ctrl/Cmd+Shift+O; ribbon View ▸ Show). Returns unregister.
// - OUTLINE_CONTROLS: tooltip copy (the tooltips registry reads it).
// Open state and width: preferences.json (`navigationPane`, `navigationPaneWidth`; shared store).
export { NavigationPane } from './NavigationPane'
export { registerOutlineCommands } from './commands'
export { OUTLINE_CONTROLS } from './controls'
export { outlineDebug } from './use-outline'
