import { create } from 'zustand'
import { createAppSlice } from './app-slice'
import { createEditorSlice } from './editor-slice'
import { createProjectSlice } from './project-slice'
import { createFindSlice } from './find-slice'
import { createBookSlice } from './book-slice'
import { createLayoutSlice } from './layout-slice'
import { createPreferencesSlice } from './preferences-slice'
import { createCommentsSlice } from './comments-slice'
import { createTrackChangesSlice } from './track-changes-slice'
import { createRewriteSlice } from './rewrite-slice'
import type { RootState } from './types'

/**
 * The single flux-style store, composed from slice creators.
 * To add a slice: (1) write `createXSlice: SliceCreator<XSlice>` in
 * `x-slice.ts` (state object + `xActions` object of named actions),
 * (2) add `& XSlice` to RootState in types.ts, (3) spread it below.
 * Components read with `useStore(selector)` and mutate ONLY via named actions.
 */
export const useStore = create<RootState>()((...a) => ({
  ...createAppSlice(...a),
  ...createEditorSlice(...a),
  ...createProjectSlice(...a),
  ...createFindSlice(...a),
  ...createBookSlice(...a),
  ...createLayoutSlice(...a),
  ...createPreferencesSlice(...a),
  ...createCommentsSlice(...a),
  ...createTrackChangesSlice(...a),
  ...createRewriteSlice(...a),
}))

export { useColorSchemeSync } from './use-color-scheme-sync'
export type { AppSlice, ColorScheme } from './app-slice'
export type { EditorSlice } from './editor-slice'
export type { ProjectSlice, ProjectState, RecentProject, RecoveryPrompt, SaveStatus } from './project-slice'
export type { FindSlice } from './find-slice'
export type { BookSlice } from './book-slice'
export type { LayoutSlice, PageInfo, PageSide, VisibleSpread, ZoomMode } from './layout-slice'
export type { PreferencesSlice, Preferences, PreferenceValues, PageNavigation, ReduceMotion } from './preferences-slice'
export {
  parsePreferences,
  serializePreferences,
  defaultPreferenceValues,
  PREFERENCES_VERSION,
  MAX_AUTHOR_NAME,
  PAPER_SURFACES,
} from './preferences-file'
export type { ParsedPreferences } from './preferences-file'
export { setSystemAuthorName } from './preferences-slice'
export type { CommentsSlice, CommentThread, CommentMessage } from './comments-slice'
export type { TrackChangesSlice } from './track-changes-slice'
export type { RewriteSlice, RewriteRecord, RewriteVersion, RewriteStatus, RewriteNotice, RewriteLocation } from './rewrite-slice'
export type { RootState, SliceCreator } from './types'
