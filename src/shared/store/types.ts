import type { StateCreator } from 'zustand'
import type { AppSlice } from './app-slice'
import type { EditorSlice } from './editor-slice'
import type { ProjectSlice } from './project-slice'
import type { FindSlice } from './find-slice'
import type { BookSlice } from './book-slice'
import type { LayoutSlice } from './layout-slice'
import type { PreferencesSlice } from './preferences-slice'
import type { CommentsSlice } from './comments-slice'
import type { TrackChangesSlice } from './track-changes-slice'
import type { RewriteSlice } from './rewrite-slice'
import type { WordCountSlice } from './word-count-slice'
import type { TutorConnectionsSlice } from './tutor-connections-slice'
import type { SpellcheckSlice } from './spellcheck-slice'

/**
 * Compose the full store state here: `RootState = AppSlice & EditorSlice & ...`.
 * Each slice adds one line here and one spread in index.ts.
 */
export type RootState = AppSlice &
  EditorSlice &
  ProjectSlice &
  FindSlice &
  BookSlice &
  LayoutSlice &
  PreferencesSlice &
  CommentsSlice &
  TrackChangesSlice &
  RewriteSlice &
  WordCountSlice &
  TutorConnectionsSlice &
  SpellcheckSlice

/** A slice creator contributes state + named actions to the single store. */
export type SliceCreator<S> = StateCreator<RootState, [], [], S>
