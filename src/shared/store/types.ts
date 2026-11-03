import type { StateCreator } from 'zustand'
import type { AppSlice } from './app-slice'
import type { EditorSlice } from './editor-slice'
import type { ProjectSlice } from './project-slice'

/**
 * Compose the full store state here: `RootState = AppSlice & EditorSlice & ...`.
 * Each slice adds one line here and one spread in index.ts.
 */
export type RootState = AppSlice & EditorSlice & ProjectSlice

/** A slice creator contributes state + named actions to the single store. */
export type SliceCreator<S> = StateCreator<RootState, [], [], S>
