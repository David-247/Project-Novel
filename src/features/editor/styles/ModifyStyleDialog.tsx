import { useId, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import {
  chapterRole,
  DEFAULT_STYLE_ID,
  resolveStyleSheet,
  STYLE_IDS,
  writeStyle,
  type ResolvedStyle,
  type StyleDef,
  type StyleFormat,
} from '@/shared/book'
import { useStore } from '@/shared/store'
import { Button, cn, Dialog, Select, TextInput, Tooltip } from '@/shared/ui'
import type { SelectOption } from '@/shared/ui'
import { countStyleUses, getStyleDefinition, ownDef, resetStyle, saveStyle } from './actions'
import { STYLE_DIALOG_CONTROLS as C } from './controls'
import type { StyleDialogControlKey } from './controls'
import { useResolvedStyles } from './resolved'
import { StyleProof } from './StyleProof'

type Draft = Omit<StyleDef, 'builtIn'>
type NumKey = 'fontSize' | 'letterSpacing' | 'lineHeight' | 'spaceBefore' | 'spaceAfter' | 'firstLineIndent' | 'indentLeft' | 'indentRight'
const NUM_KEYS: readonly NumKey[] = ['fontSize', 'letterSpacing', 'lineHeight', 'spaceBefore', 'spaceAfter', 'firstLineIndent', 'indentLeft', 'indentRight']
const NUM_STEP: Record<NumKey, string> = {
  fontSize: '0.5', letterSpacing: '0.01', lineHeight: '0.05', spaceBefore: '1', spaceAfter: '1',
  firstLineIndent: '0.25', indentLeft: '0.25', indentRight: '0.25',
}

const ALIGN_LABEL = { left: 'Left', center: 'Center', right: 'Right', justify: 'Justify' } as const
const CASE_LABEL = { none: 'As typed', uppercase: 'Capitals', lowercase: 'Lowercase', capitalize: 'Title Case', 'small-caps': 'Small capitals' } as const
const BREAK_LABEL = { none: 'Same page', page: 'New page', recto: 'New right-hand page' } as const
const WEIGHT_LABEL: Record<number, string> = { 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semibold', 700: 'Bold' }

const fmtNum = (n: number | undefined) => (n === undefined ? '' : String(+n.toFixed(3)))

export interface ModifyStyleDialogProps {
  /** Style being edited; null = closed. */
  styleId: string | null
  onClose: () => void
  /** Sample text for the preview (e.g. the current paragraph). */
  sample?: string
}

/** "Modify style": edits one definition with a live preview. Saving restyles the whole manuscript. */
export function ModifyStyleDialog({ styleId, onClose, sample }: ModifyStyleDialogProps) {
  const def = styleId ? getStyleDefinition(styleId) : undefined
  return (
    <Dialog
      open={!!styleId && !!def}
      onOpenChange={(open) => !open && onClose()}
      title={def ? `Modify style: ${def.name}` : 'Modify style'}
      description="Changes apply to every paragraph that uses this style, across the whole manuscript."
      className="sm:max-w-3xl"
    >
      {styleId && def ? <ModifyStyleForm key={styleId} styleId={styleId} initial={def} onClose={onClose} sample={sample} /> : null}
    </Dialog>
  )
}

function ModifyStyleForm({ styleId, initial, onClose, sample }: { styleId: string; initial: StyleDef; onClose: () => void; sample?: string }) {
  const stored = useStore((s) => s.book.styles)
  const styles = useResolvedStyles()
  const [draft, setDraft] = useState<Draft>(() => ownDef(initial))
  const [texts, setTexts] = useState<Record<NumKey, string>>(
    () => Object.fromEntries(NUM_KEYS.map((k) => [k, fmtNum(initial[k])])) as Record<NumKey, string>,
  )
  const formId = useId()
  // Blocks of a chapter style are headings and of a paragraph style paragraphs, so the kind of a
  // style in use stays fixed (duplicate it, or move its paragraphs first). Counted once, O(document).
  const [uses] = useState(() => (initial.builtIn ? 0 : countStyleUses(styleId)))

  const invalid = useMemo(() => {
    const bad = new Set<NumKey>()
    for (const k of NUM_KEYS) if (texts[k].trim() !== '' && !Number.isFinite(Number(texts[k]))) bad.add(k)
    return bad
  }, [texts])
  const nameMissing = !draft.name.trim()

  // The draft resolved exactly as it would be after saving (same code path as the manuscript).
  const preview = useMemo(() => {
    const sheet = resolveStyleSheet(writeStyle(stored, styleId, draft))
    const self = sheet.get(styleId)!
    return {
      self,
      role: chapterRole(sheet, styleId),
      context: sheet.get(DEFAULT_STYLE_ID)!,
      next: sheet.get(self.nextStyle ?? styleId) ?? self,
      parent: self.basedOn ? sheet.get(self.basedOn) : undefined,
    }
  }, [stored, styleId, draft])

  const set = <K extends keyof Draft>(k: K, v: Draft[K] | undefined) =>
    setDraft((d) => {
      const n = { ...d }
      if (v === undefined) delete n[k]
      else n[k] = v
      return n
    })

  const setNum = (k: NumKey, text: string) => {
    setTexts((t) => ({ ...t, [k]: text }))
    const n = Number(text)
    if (text.trim() === '') set(k, undefined)
    else if (Number.isFinite(n)) set(k, n)
  }

  // A style may not be based on itself or on a style that is (indirectly) based on it.
  const basedOnOptions = useMemo(() => {
    const descendsFrom = (id: string): boolean => {
      for (let s = styles.get(id), guard = 0; s && guard < 64; s = s.basedOn ? styles.get(s.basedOn) : undefined, guard++) {
        if (s.id === styleId) return true
      }
      return false
    }
    return [...styles.values()].filter((s) => !descendsFrom(s.id)).map((s) => ({ value: s.id, label: s.name }))
  }, [styles, styleId])

  const parent = preview.parent
  /** "Inherit" option label: shows what the parent gives. */
  const inheritLabel = (shown: string | undefined) =>
    parent ? `From ${parent.name}${shown ? ` (${shown})` : ''}` : 'Default'

  // A chapter heading made from scratch (or re-pointed away from Chapter Title) does not open chapters
  // (the rule: docs/design.md, Chapters). Say so where it is decided, next to Kind and Based on.
  const chapterHint =
    draft.kind !== 'chapter'
      ? undefined
      : preview.role === 'title'
        ? `Opens a chapter (based on ${styles.get(STYLE_IDS.chapterTitle)?.name ?? 'Chapter Title'}).`
        : preview.role === 'number'
          ? `Numbers the chapter whose title follows it (based on ${styles.get(STYLE_IDS.chapterNumber)?.name ?? 'Chapter Number'}).`
          : (preview.self.outlineLevel ?? 1) !== 1
            ? `A level ${preview.self.outlineLevel} heading: it won't start chapters.`
            : "Won't start chapters: base it on Chapter Title to open a chapter."

  const save = () => {
    if (nameMissing || invalid.size) return
    saveStyle(styleId, { ...draft, name: draft.name.trim() })
    onClose()
  }

  const field = (
    key: StyleDialogControlKey,
    control: (p: { id: string; 'data-control-id': string; 'aria-describedby'?: string }) => ReactElement,
    wide = false,
    hint?: string,
  ) => {
    const id = `${formId}-${key}`
    const hintId = `${id}-hint`
    return (
      <div className={cn('flex min-w-0 flex-col gap-1', wide && 'col-span-2')}>
        <label htmlFor={id} className="text-ui-xs font-medium text-text-muted">
          {C[key].label}
        </label>
        <Tooltip>{control({ id, 'data-control-id': C[key].id, ...(hint ? { 'aria-describedby': hintId } : {}) })}</Tooltip>
        {hint ? (
          <p id={hintId} className="m-0 text-ui-xs text-text-muted" data-testid={`hint-${key}`}>
            {hint}
          </p>
        ) : null}
      </div>
    )
  }

  const num = (key: NumKey) =>
    field(key, (p) => (
      <TextInput
        {...p}
        type="number"
        inputMode="decimal"
        step={NUM_STEP[key]}
        value={texts[key]}
        aria-invalid={invalid.has(key) || undefined}
        placeholder={parent && parent[key] !== undefined ? `${fmtNum(parent[key])} (inherited)` : ''}
        onChange={(e) => setNum(key, e.target.value)}
      />
    ))

  const choice = <K extends keyof StyleFormat>(key: K & StyleDialogControlKey, options: SelectOption[], parse: (v: string) => StyleFormat[K], current: string) =>
    field(key, (p) => (
      <Select {...p} options={options} value={current} wrapperClassName="w-full" onChange={(e) => set(key, (e.target.value === '' ? undefined : parse(e.target.value)) as Draft[K] | undefined)} />
    ))

  const inheritOpt = (label: string | undefined): SelectOption => ({ value: '', label: inheritLabel(label) })

  return (
    <form
      id={formId}
      className="grid gap-5 pb-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      <div className="flex min-w-0 flex-col gap-4">
        <fieldset className="grid grid-cols-2 gap-3">
          <legend className="mb-2 text-ui-sm font-semibold text-text">Style</legend>
          {initial.builtIn ? (
            <p className="col-span-2 m-0 text-ui-sm text-text-muted">
              {initial.name} is a built-in {initial.kind === 'chapter' ? 'chapter' : 'paragraph'} style
              {parent ? `, based on ${parent.name}` : ''}.
            </p>
          ) : (
            <>
              {field('name', (p) => (
                <TextInput {...p} value={draft.name} maxLength={80} aria-invalid={nameMissing || undefined} onChange={(e) => set('name', e.target.value)} />
              ), true)}
              {field('kind', (p) => (
                <Select
                  {...p}
                  wrapperClassName="w-full"
                  value={draft.kind}
                  disabled={uses > 0}
                  options={[{ value: 'paragraph', label: 'Paragraph' }, { value: 'chapter', label: 'Chapter heading' }]}
                  onChange={(e) => set('kind', e.target.value === 'chapter' ? 'chapter' : 'paragraph')}
                />
              ), false, uses > 0 ? `Fixed while ${uses} ${uses === 1 ? 'paragraph uses' : 'paragraphs use'} this style.` : undefined)}
              {field('basedOn', (p) => (
                <Select {...p} wrapperClassName="w-full" value={draft.basedOn ?? ''} options={[{ value: '', label: 'Nothing' }, ...basedOnOptions]} onChange={(e) => set('basedOn', e.target.value || undefined)} />
              ), false, chapterHint)}
            </>
          )}
          {field('nextStyle', (p) => (
            <Select
              {...p}
              wrapperClassName="w-full"
              value={draft.nextStyle ?? ''}
              options={[{ value: '', label: 'Same style' }, ...[...styles.values()].filter((s) => s.id !== styleId).map((s) => ({ value: s.id, label: s.name }))]}
              onChange={(e) => set('nextStyle', e.target.value || undefined)}
            />
          ), initial.builtIn)}
        </fieldset>

        <fieldset className="grid grid-cols-2 gap-3">
          <legend className="mb-2 text-ui-sm font-semibold text-text">Type</legend>
          {field('fontFamily', (p) => (
            <TextInput {...p} value={draft.fontFamily ?? ''} placeholder={inheritLabel(parent?.fontFamily ?? 'manuscript font')} onChange={(e) => set('fontFamily', e.target.value.trim() ? e.target.value : undefined)} />
          ), true)}
          {num('fontSize')}
          {choice('fontWeight', [inheritOpt(parent?.fontWeight ? WEIGHT_LABEL[parent.fontWeight] ?? String(parent.fontWeight) : undefined), ...[300, 400, 500, 600, 700].map((w) => ({ value: String(w), label: WEIGHT_LABEL[w] }))], Number, draft.fontWeight === undefined ? '' : String(draft.fontWeight))}
          {choice('italic', [inheritOpt(parent?.italic === undefined ? undefined : parent.italic ? 'Italic' : 'Upright'), { value: 'false', label: 'Upright' }, { value: 'true', label: 'Italic' }], (v) => v === 'true', draft.italic === undefined ? '' : String(draft.italic))}
          {choice('textTransform', [inheritOpt(parent?.textTransform ? CASE_LABEL[parent.textTransform] : undefined), ...Object.entries(CASE_LABEL).map(([value, label]) => ({ value, label }))], (v) => v as StyleFormat['textTransform'], draft.textTransform ?? '')}
          {num('letterSpacing')}
        </fieldset>

        <fieldset className="grid grid-cols-2 gap-3">
          <legend className="mb-2 text-ui-sm font-semibold text-text">Paragraph</legend>
          {choice('align', [inheritOpt(parent?.align ? ALIGN_LABEL[parent.align] : undefined), ...Object.entries(ALIGN_LABEL).map(([value, label]) => ({ value, label }))], (v) => v as StyleFormat['align'], draft.align ?? '')}
          {num('lineHeight')}
          {num('spaceBefore')}
          {num('spaceAfter')}
          {num('firstLineIndent')}
          {choice('breakBefore', [inheritOpt(parent?.breakBefore ? BREAK_LABEL[parent.breakBefore] : undefined), ...Object.entries(BREAK_LABEL).map(([value, label]) => ({ value, label }))], (v) => v as StyleFormat['breakBefore'], draft.breakBefore ?? '')}
          {num('indentLeft')}
          {num('indentRight')}
        </fieldset>
      </div>

      <div className="flex min-w-0 flex-col gap-3 md:sticky md:top-0 md:self-start">
        <StyleProof style={preview.self as ResolvedStyle} context={preview.context} next={preview.next} sample={sample} />
        <p className="m-0 text-ui-xs text-text-muted">
          Empty fields follow {parent ? parent.name : 'the manuscript defaults'}. Formatting you applied directly to a paragraph
          still wins over its style.
        </p>
        <div className="mt-auto flex flex-wrap justify-end gap-2 pt-2">
          {initial.builtIn && styleId in stored ? (
            <Tooltip>
              <Button
                data-control-id={C.modifyReset.id}
                variant="ghost"
                className="mr-auto"
                onClick={() => {
                  resetStyle(styleId)
                  onClose()
                }}
              >
                {C.modifyReset.label}
              </Button>
            </Tooltip>
          ) : null}
          <Tooltip>
            <Button data-control-id={C.modifyCancel.id} onClick={onClose}>
              {C.modifyCancel.label}
            </Button>
          </Tooltip>
          <Tooltip>
            <Button type="submit" variant="primary" data-control-id={C.modifySave.id} disabled={nameMissing || invalid.size > 0}>
              {C.modifySave.label}
            </Button>
          </Tooltip>
        </div>
      </div>
    </form>
  )
}
