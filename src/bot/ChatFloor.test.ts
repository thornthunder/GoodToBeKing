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

  it('gives a routed line to its bot, whoever else is named', () => {
    const floor = new ChatFloor(['Festaris', 'Merlin', 'Bruce'], undefined, (e) =>
      e.message.startsWith('GMH') && e.from === 'King' ? 'Merlin' : undefined
    )
    for (const b of ['Festaris', 'Merlin', 'Bruce']) floor.setOnline(b, true)
    floor.replied('Bruce', 'King')
    expect(floor.responder(line('King', 'GMH'))).toBe('Merlin')
    expect(floor.responder(line('King', 'Bruce, hello'))).toBe('Bruce')
    expect(floor.responder(line('Kid', 'GMH'))).toBe('Festaris')
    // The bot routed to is not online: the usual rules.
    floor.setOnline('Merlin', false)
    expect(floor.responder(line('King', 'GMH!'))).toBe('Bruce')
  })
})
