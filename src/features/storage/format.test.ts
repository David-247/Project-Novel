import { describe, expect, it } from 'vitest'
import {
  baseName,
  isDocJSON,
  joinPath,
  newProjectMeta,
  parseManuscript,
  parseProjectMeta,
  PROJECT_SCHEMA_VERSION,
  ProjectError,
  serializeManuscript,
  serializeProjectMeta,
} from './format'

function expectProjectError(fn: () => unknown, code: string) {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(ProjectError)
    expect((e as ProjectError).code).toBe(code)
    expect((e as ProjectError).message.length).toBeGreaterThan(10)
    return
  }
  throw new Error('expected a ProjectError')
}

describe('project.json', () => {
  const meta = newProjectMeta('My Novel', new Date('2026-01-02T03:04:05Z'), 'id-1')

  it('round-trips', () => {
    expect(parseProjectMeta(serializeProjectMeta(meta))).toEqual(meta)
    expect(meta).toMatchObject({ format: 'novel-project', schemaVersion: PROJECT_SCHEMA_VERSION })
  })

  it('a project.json without an author (every older project) reads it as an empty string; an author round-trips', () => {
    expect(meta.author).toBe('')
    const { author: _a, ...older } = meta
    void _a
    expect(parseProjectMeta(JSON.stringify(older)).author).toBe('')
    expect(parseProjectMeta(JSON.stringify({ ...meta, author: 7 })).author).toBe('')
    const withAuthor = { ...meta, author: 'Ada Quill' }
    expect(parseProjectMeta(serializeProjectMeta(withAuthor)).author).toBe('Ada Quill')
  })

  it('rejects invalid JSON as corrupt', () => {
    expectProjectError(() => parseProjectMeta('{"format": "novel-pro'), 'corrupt-file')
  })

  it('rejects files that are not Novel projects', () => {
    expectProjectError(() => parseProjectMeta('{"hello": 1}'), 'not-a-project')
    expectProjectError(() => parseProjectMeta('[]'), 'not-a-project')
    expectProjectError(() => parseProjectMeta('null'), 'not-a-project')
  })

  it('checks the schema version', () => {
    const bump = (v: unknown) => JSON.stringify({ ...meta, schemaVersion: v })
    expectProjectError(() => parseProjectMeta(bump(PROJECT_SCHEMA_VERSION + 1)), 'unsupported-version')
    expectProjectError(() => parseProjectMeta(bump(0)), 'corrupt-file')
    expectProjectError(() => parseProjectMeta(bump('1')), 'corrupt-file')
    expectProjectError(() => parseProjectMeta(bump(1.5)), 'corrupt-file')
  })

  it('schema version 2 is current; a version 1 file is migrated (no-op) and written back as 2', () => {
    expect(PROJECT_SCHEMA_VERSION).toBe(2)
    const v1 = { ...meta, schemaVersion: 1 }
    const read = parseProjectMeta(JSON.stringify(v1))
    expect(read).toEqual({ ...meta, schemaVersion: 2 })
    expect(JSON.parse(serializeProjectMeta(read)).schemaVersion).toBe(2)
  })

  it('keeps unknown top-level keys and writes them back (what a newer Novel adds survives)', () => {
    const extra = { series: { name: 'Roads', book: 2 }, language: 'en-GB' }
    const read = parseProjectMeta(JSON.stringify({ ...meta, ...extra }))
    expect(read.extra).toEqual(extra)
    const written = JSON.parse(serializeProjectMeta({ ...read, title: 'Renamed' }))
    expect(written).toEqual({ ...meta, title: 'Renamed', ...extra })
    // Known keys always come from the typed fields, never from `extra`.
    const sneaky = JSON.parse(serializeProjectMeta({ ...meta, extra: { id: 'other', title: 'x' } }))
    expect(sneaky).toMatchObject({ id: meta.id, title: meta.title })
    // No unknown keys: no `extra` field at all (the file is unchanged in shape).
    expect('extra' in parseProjectMeta(serializeProjectMeta(meta))).toBe(false)
    expect(Object.keys(JSON.parse(serializeProjectMeta(meta)))).toEqual(['format', 'schemaVersion', 'id', 'title', 'author', 'createdAt', 'updatedAt'])
  })

  it('requires the metadata fields', () => {
    const { title: _t, ...noTitle } = meta
    void _t
    expectProjectError(() => parseProjectMeta(JSON.stringify(noTitle)), 'corrupt-file')
  })
})

describe('manuscript.json', () => {
  const doc = {
    type: 'doc' as const,
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Hello', marks: [{ type: 'bold' }] }] },
      { type: 'heading', attrs: { level: 1 } },
    ],
  }

  it('round-trips', () => {
    expect(parseManuscript(serializeManuscript(doc))).toEqual(doc)
  })

  it('reports corrupt JSON instead of throwing a SyntaxError', () => {
    expectProjectError(() => parseManuscript('{"type":"doc","content":[{"type":"para'), 'corrupt-file')
    expectProjectError(() => parseManuscript(''), 'corrupt-file')
  })

  it('rejects JSON that is not a doc', () => {
    expectProjectError(() => parseManuscript('{"type":"paragraph"}'), 'corrupt-file')
    expectProjectError(() => parseManuscript('{"type":"doc","content":{}}'), 'corrupt-file')
    expectProjectError(() => parseManuscript('{"type":"doc","content":[{"text":"no type"}]}'), 'corrupt-file')
    expectProjectError(() => parseManuscript('{"type":"doc","content":[{"type":"text","text":5}]}'), 'corrupt-file')
  })

  it('isDocJSON accepts a minimal doc', () => {
    expect(isDocJSON({ type: 'doc' })).toBe(true)
    expect(isDocJSON({ type: 'doc', content: [] })).toBe(true)
  })
})

describe('paths', () => {
  it('joins with the folder separator', () => {
    expect(joinPath('C:\\Books\\Novel', 'project.json')).toBe('C:\\Books\\Novel\\project.json')
    expect(joinPath('C:\\Books\\Novel\\', 'project.json')).toBe('C:\\Books\\Novel\\project.json')
    expect(joinPath('/home/a/novel/', 'manuscript.json')).toBe('/home/a/novel/manuscript.json')
    expect(joinPath('/', 'x.json')).toBe('/x.json')
  })

  it('takes the base name', () => {
    expect(baseName('C:\\Books\\My Novel\\')).toBe('My Novel')
    expect(baseName('/home/a/novel')).toBe('novel')
  })
})
