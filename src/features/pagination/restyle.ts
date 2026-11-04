import { chapterRoles, chapterRoleSignature, type ResolvedStyles } from '@/shared/book'

/**
 * Style ids whose blocks a style-sheet edit must re-measure:
 * - every style whose resolved definition changed;
 * - every style whose chapter role changed with an unchanged definition (a style based on a copy of
 *   Chapter Title stops being a chapter title when the copy is re-pointed: it loses the number + title
 *   heading group, so its break and space before come back);
 * - when any role changed, every chapter number and chapter title style, old and new (the group's
 *   "no space before" and break depend on the pair, so the partner moves too).
 * O(styles).
 */
export function restyledIds(before: ResolvedStyles, after: ResolvedStyles): Set<string> {
  const ids = new Set<string>()
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    if (JSON.stringify(before.get(id)) !== JSON.stringify(after.get(id))) ids.add(id)
  }
  if (chapterRoleSignature(before) !== chapterRoleSignature(after)) {
    for (const id of chapterRoles(before).keys()) ids.add(id)
    for (const id of chapterRoles(after).keys()) ids.add(id)
  }
  return ids
}
