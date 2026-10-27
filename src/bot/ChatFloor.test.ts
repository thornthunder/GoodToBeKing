import { describe, expect, it } from 'vitest'
import type { ChatEvent } from '../ai/Brain'
import { ChatFloor } from './ChatFloor'

const line = (from: string, message: string): ChatEvent => ({
  from,
  message,
  kind: 'chat',
  receivedAt: Date.now(),
})

function court(...online: string[]) {
  const floor = new ChatFloor(['Merlin', 'Festaris', 'Bruce', 'Dyke', 'Henry', 'George'])
  for (const b of online) floor.setOnline(b, true)
  return floor
}

describe('ChatFloor', () => {
  it('lets the bot named in the line answer, spelling forgiven', () => {
    const floor = court('Merlin', 'Bruce', 'Dyke')
    expect(floor.responder(line('Kid', 'Bruce follow me'))).toBe('Bruce')
    expect(floor.responder(line('Kid', 'hello Marlon'))).toBe('Merlin')
  })

  it('picks the first bot named when several are', () => {
    const floor = court('Merlin', 'Bruce', 'Dyke')
    expect(floor.responder(line('Kid', 'Dyke and Bruce, come here'))).toBe('Dyke')
  })

  it('keeps the conversation with the bot that last answered that player', () => {
    const floor = court('Merlin', 'Bruce')
    floor.replied('Bruce', 'Kid')
    expect(floor.responder(line('Kid', 'what do you think?'))).toBe('Bruce')
    expect(floor.responder(line('Other', 'what do you think?'))).toBe('Merlin')
  })

  it('falls back to the herald: the most senior bot online', () => {
    const floor = court('Bruce', 'Festaris')
    expect(floor.responder(line('Kid', 'hello everyone'))).toBe('Festaris')
    expect(floor.isHerald('Festaris')).toBe(true)
    floor.setOnline('Merlin', true)
    expect(floor.herald()).toBe('Merlin')
  })

  it('has a different herald for guests (the Castellan welcomes visitors)', () => {
    const floor = new ChatFloor(['Merlin', 'Festaris'], ['Festaris', 'Merlin'])
    floor.setOnline('Merlin', true)
    floor.setOnline('Festaris', true)
    expect(floor.responder(line('Princess', 'hello'))).toBe('Merlin')
    expect(floor.responder(line('Visitor', 'hello'), true)).toBe('Festaris')
    expect(floor.isHerald('Festaris', true)).toBe(true)
  })

  it('gives every bot the same answer for the same line', () => {
    const floor = court('Merlin', 'Bruce')
    const event = line('Kid', 'hi there')
    const first = floor.responder(event)
    floor.replied('Bruce', 'Kid') // a reply lands between two bots asking
    expect(floor.responder(event)).toBe(first)
  })
})
