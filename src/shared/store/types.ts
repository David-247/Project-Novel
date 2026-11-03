import type { StateCreator } from 'zustand'
import type { AppSlice } from './app-slice'

/**
 * Compose the full store state here: `RootState = AppSlice & EditorSlice & ...`.
 * Each slice adds one line here and one spread in index.ts.
 */
export type RootState = AppSlice

/** A slice creator contributes state + named actions to the single store. */
export type SliceCreator<S> = StateCreator<RootState, [], [], S>
