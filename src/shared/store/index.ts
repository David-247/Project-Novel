import { create } from 'zustand'
import { createAppSlice } from './app-slice'
import { createEditorSlice } from './editor-slice'
import { createProjectSlice } from './project-slice'
import { createFindSlice } from './find-slice'
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
}))

export { useColorSchemeSync } from './use-color-scheme-sync'
export type { AppSlice, ColorScheme } from './app-slice'
export type { EditorSlice } from './editor-slice'
export type { ProjectSlice, ProjectState, RecentProject, RecoveryPrompt, SaveStatus } from './project-slice'
export type { FindSlice } from './find-slice'
export type { RootState, SliceCreator } from './types'
