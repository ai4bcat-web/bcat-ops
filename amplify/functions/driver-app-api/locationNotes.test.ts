import { describe, it, expect } from 'vitest'
import { parseDriverNotes, ownNoteIndex, withNoteText, withoutNote } from './locationNotes'

const notes = [
  { at: '2026-10-19T15:00:00Z', driverId: 'd1', by: 'Jason', text: 'lunch 12-1' },
  { at: '2026-10-19T16:00:00Z', driverId: 'd2', by: 'Zak', text: 'dock 4' },
]

describe('location notes', () => {
  it('reads notes stored as a list or as JSON text, dropping junk', () => {
    expect(parseDriverNotes(notes)).toHaveLength(2)
    expect(parseDriverNotes(JSON.stringify(notes))).toHaveLength(2)
    expect(parseDriverNotes('not json')).toEqual([])
    expect(parseDriverNotes([{ at: 'x' }, null, 'str'])).toEqual([])
  })
  it('finds only the driver\'s own note by its stamp', () => {
    expect(ownNoteIndex(notes, 'd1', '2026-10-19T15:00:00Z')).toBe(0)
    expect(ownNoteIndex(notes, 'd1', '2026-10-19T16:00:00Z')).toBe(-1)   // Zak's
    expect(ownNoteIndex(notes, 'd2', '2026-10-19T16:00:00Z')).toBe(1)
  })
  it('edits or removes one note and leaves the rest untouched', () => {
    expect(withNoteText(notes, 0, 'lunch 12 to 1, check in at the office')[0].text).toBe('lunch 12 to 1, check in at the office')
    expect(withNoteText(notes, 0, 'x')[1]).toEqual(notes[1])
    expect(withoutNote(notes, 0)).toEqual([notes[1]])
  })
})
