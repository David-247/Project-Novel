import { Extension } from '@tiptap/core'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { useStore } from '@/shared/store'
import { closeFind, openFind } from './engine'
import type { MatchRange } from './search'

export const MATCH_CLASS = 'nv-find-match'
export const CURRENT_CLASS = 'nv-find-match-current'

/**
 * Two decoration plugins so moving the "current" match only rebuilds one decoration, never the
 * (possibly huge) set of all matches. Both sets are replaced via transaction meta by the find
 * engine and are cheaply mapped through edits in between scans (no re-scan per keystroke).
 */
export const findMatchesKey = new PluginKey<DecorationSet>('novelFindMatches')
export const findCurrentKey = new PluginKey<DecorationSet>('novelFindCurrent')

function decorationPlugin(key: PluginKey<DecorationSet>) {
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        const next = tr.getMeta(key) as DecorationSet | undefined
        if (next) return next
        return tr.docChanged ? set.map(tr.mapping, tr.doc) : set
      },
    },
    props: {
      decorations(state) {
        return key.getState(state)
      },
    },
  })
}

export function buildMatchDecorations(state: EditorState, matches: readonly MatchRange[]): DecorationSet {
  if (matches.length === 0) return DecorationSet.empty
  const decos = matches.map((m) => Decoration.inline(m.from, m.to, { class: MATCH_CLASS }))
  return DecorationSet.create(state.doc, decos)
}

export function buildCurrentDecoration(state: EditorState, match: MatchRange | undefined): DecorationSet {
  if (!match) return DecorationSet.empty
  return DecorationSet.create(state.doc, [
    Decoration.inline(match.from, match.to, { class: CURRENT_CLASS, 'aria-current': 'true' }),
  ])
}

/** Attach new decoration sets to a transaction (never added to undo history). */
export function setFindDecorations(
  tr: Transaction,
  sets: { matches?: DecorationSet; current?: DecorationSet },
): Transaction {
  if (sets.matches) tr.setMeta(findMatchesKey, sets.matches)
  if (sets.current) tr.setMeta(findCurrentKey, sets.current)
  return tr.setMeta('addToHistory', false)
}

/**
 * Drop all find highlights as part of an editing transaction (e.g. replace all). Avoids mapping
 * N decorations through N replace steps (O(N^2)); the engine re-scans right after.
 * Does not touch `addToHistory`, so the edit itself stays undoable.
 */
export function clearFindDecorations(tr: Transaction): Transaction {
  return tr.setMeta(findMatchesKey, DecorationSet.empty).setMeta(findCurrentKey, DecorationSet.empty)
}

/**
 * Find highlighting + editor shortcuts:
 * - Mod-f: open the find panel (pre-filled from a short single-block selection) and focus it.
 * - Escape: close the panel when it is open (otherwise not handled).
 */
export const FindHighlight = Extension.create({
  name: 'novelFind',

  addProseMirrorPlugins() {
    return [decorationPlugin(findMatchesKey), decorationPlugin(findCurrentKey)]
  },

  addKeyboardShortcuts() {
    return {
      'Mod-f': () => {
        openFind()
        return true
      },
      Escape: () => {
        if (!useStore.getState().find.open) return false
        closeFind({ focusEditor: false })
        return true
      },
    }
  },
})
