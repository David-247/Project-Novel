import { registerContextMenuItems, type ContextMenuContext, type MenuItem } from '@/features/editor'
import { lockedAtSelection } from '@/features/rewrite'
import { notifyCommandStateChanged, registerCommands, type Command } from '@/shared/commands'
import { useStore } from '@/shared/store'
import { SPELLCHECK_CONTROLS as C } from './controls'
import { addWord, ignoreOnce } from './dictionary'
import { findingsIn, removeUnderline, spellcheckKey, type SpellSpec } from './extension'

/** A dictionary word for flagged text: without a possessive ('s or ’s), which Rust ignores anyway. */
const dictionaryForm = (text: string) => text.replace(/['’]s$/i, '')

/** Where the underline of `spec` is now, or null when it is gone. */
function locate(ctx: ContextMenuContext, spec: SpellSpec) {
  const st = spellcheckKey.getState(ctx.editor.state)
  const d = st?.set.find(undefined, undefined, (s: { spell?: SpellSpec }) => s.spell === spec)[0]
  return d ? { from: d.from, to: d.to } : null
}

/**
 * The spell check's part of the manuscript's context menu (Word's order): the suggestions (bold),
 * then Ignore Once and, for a spelling, Add to Dictionary. Only on an underline.
 */
export function spellcheckMenuItems(ctx: ContextMenuContext): MenuItem[] {
  const hit = findingsIn(ctx.editor.state, ctx.pos, ctx.pos)
  // A spelling before a grammar finding over the same place (Word shows the spelling first).
  const at = hit.find((h) => h.spec.finding.kind === 'spelling') ?? hit[0]
  if (!at) return []
  const { spec } = at
  const { editor } = ctx
  const spelling = spec.finding.kind === 'spelling'
  // A passage in re-write is read-only in the manuscript (its changes are made in the re-write view).
  const locked = lockedAtSelection(editor.state) !== null
  const canReplace = spec.contiguous && editor.isEditable && !locked

  const apply = (replacement: string) => {
    const r = locate(ctx, spec)
    const { state } = editor.view
    // Only what was flagged, where it is now (an edit since then makes it a different text).
    if (!r || state.doc.textBetween(r.from, r.to) !== spec.text) return
    const tr = replacement ? state.tr.insertText(replacement, r.from, r.to) : state.tr.delete(r.from, r.to)
    editor.view.dispatch(removeUnderline(tr.scrollIntoView(), spec))
  }

  const items: MenuItem[] = spec.finding.suggestions.map((s, i) => ({
    id: C.suggestion.id,
    label: s === '' ? '(Delete)' : s,
    group: 'suggestions',
    order: i,
    emphasis: true,
    disabled: !canReplace,
    // The control's own line first (the tooltip audit checks it), then what this one does.
    copy: {
      title: s === '' ? 'Delete' : s,
      description: [
        C.suggestion.description,
        locked
          ? 'Not here: this passage is in re-write, so change it in the re-write view.'
          : !spec.contiguous
            ? 'Not here: the text runs across a tracked change or a footnote, so edit it by hand.'
          : s === ''
            ? `“${spec.text}” is deleted.`
            : `“${spec.text}” becomes “${s}”.`,
        spec.finding.message,
      ]
        .filter(Boolean)
        .join(' '),
    },
    run: () => apply(s),
  }))
  if (items.length === 0) {
    items.push({
      id: C.noSuggestions.id,
      label: spelling ? '(No Spelling Suggestions)' : '(No Grammar Suggestions)',
      group: 'suggestions',
      order: 0,
      disabled: true,
      copy: { title: C.noSuggestions.label, description: [C.noSuggestions.description, spec.finding.message].filter(Boolean).join(' ') },
      run: () => {},
    })
  }
  items.push({
    id: C.ignoreOnce.id,
    label: C.ignoreOnce.label,
    group: 'proofing',
    order: 100,
    run: () => {
      ignoreOnce(spec.blockKey, spec.finding)
      editor.view.dispatch(removeUnderline(editor.view.state.tr, spec).setMeta('addToHistory', false))
    },
  })
  if (spelling) {
    items.push({
      id: C.addToDictionary.id,
      label: C.addToDictionary.label,
      group: 'proofing',
      order: 110,
      // The store change clears the word's underlines everywhere (extension.ts).
      run: () => void addWord(dictionaryForm(spec.text), 'user'),
    })
  }
  return items
}

/** Add the spell check's items to the manuscript's context menu. Returns unregister. */
export function registerSpellcheckMenu(): () => void {
  return registerContextMenuItems(spellcheckMenuItems)
}

const isOn = () => useStore.getState().preferences.spellcheck.enabled !== false

/** View ▸ Spelling & Grammar: the underlines on or off (preferences.json `spellcheck.enabled`). */
export function toggleSpellcheck(): void {
  const s = useStore.getState()
  s.preferencesActions.set('spellcheck', { ...s.preferences.spellcheck, enabled: !isOn() })
}

export function spellcheckCommands(): Command[] {
  return [
    {
      id: C.toggle.id,
      label: C.toggle.label,
      description: C.toggle.description,
      // After Navigation Pane (30) and Comments Panel (40): what the View menu shows over the pages.
      menu: { id: 'view', group: 'panels', order: 50 },
      // Word's Review ▸ Proofing starts with Spelling & Grammar, before Word Count (10).
      ribbon: { group: 'review.proofing', order: 5 },
      guard: 'modal',
      isChecked: isOn,
      run: toggleSpellcheck,
    },
  ]
}

/** Register View ▸ Spelling & Grammar and keep its check mark fresh. Returns unregister. */
export function registerSpellcheckCommands(): () => void {
  const off = registerCommands(spellcheckCommands())
  const offStore = useStore.subscribe((s, p) => {
    if (s.preferences.spellcheck.enabled !== p.preferences.spellcheck.enabled) notifyCommandStateChanged()
  })
  return () => {
    offStore()
    off()
  }
}
