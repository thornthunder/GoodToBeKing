import { escapeRegExp } from '../util'

/** A model that has nothing to say replies with exactly this token. */
export const SILENT_TOKEN = '[silent]'

const ELLIPSIS = '…'

/** Remove `<think>...</think>` blocks that some reasoning models emit inline (including an unterminated one). */
export function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .trim()
}

/**
 * Normalise a model reply into something that can go straight into game chat.
 * `otherLabels` are extra speaker labels (player names, titles) the model sometimes echoes
 * at the start of a reply, as in "Princess: ...".
 */
export function cleanChatReply(text: string, botName: string, otherLabels: string[] = []): string {
  let out = stripThinking(text)
  out = out.replace(/[*_`#]/g, '')
  out = out.replace(/\s+/g, ' ').trim()
  if (out.length > 1 && /^["'“”]/.test(out) && /["'“”]$/.test(out)) {
    out = out.slice(1, -1).trim()
  }
  const name = escapeRegExp(botName)
  out = out.replace(new RegExp(`^(?:<${name}>|${name}\\s*[:>-])\\s*`, 'i'), '')
  const labels = otherLabels.filter(Boolean).map(escapeRegExp).join('|')
  if (labels) {
    out = out.replace(
      new RegExp(`^(?:the\\s+)?(?:${labels})(?:\\s*\\([^)]*\\))?\\s*:\\s*`, 'i'),
      ''
    )
  }
  return out.trim()
}

/** True when `message` contains `name` as a whole word, case-insensitively. */
export function mentionsName(message: string, name: string): boolean {
  const pattern = new RegExp(`(^|[^a-z0-9_])${escapeRegExp(name.toLowerCase())}(?=[^a-z0-9_]|$)`)
  return pattern.test(message.toLowerCase())
}

/** Edit distance between two short strings. */
export function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1))
      diagonal = above
    }
  }
  return row[b.length]
}

/**
 * Like mentionsName, but tolerant of voice-typing and spelling slips ("Marlon", "Merlyn",
 * "Merlin's"). Only for names of five letters or more, where a near miss is unlikely to be a
 * different word.
 */
export function mentionsNameLoosely(message: string, name: string): boolean {
  if (mentionsName(message, name)) return true
  const target = name.toLowerCase()
  if (target.length < 5) return false
  const words = message.toLowerCase().match(/[a-z]+/g) ?? []
  return words.some((word) => {
    const base = word.endsWith('s') && word.length > target.length ? word.slice(0, -1) : word
    return Math.abs(base.length - target.length) <= 1 && levenshtein(base, target) <= 2
  })
}

/**
 * Split a reply into chat-sized parts, preferring sentence boundaries.
 * Anything beyond `maxParts` is dropped and the last part gets an ellipsis.
 */
export function splitChatMessage(text: string, maxLen = 200, maxParts = 2): string[] {
  const trimmed = text.trim()
  if (trimmed.length <= maxLen) return trimmed ? [trimmed] : []

  const sentences = trimmed.split(/(?<=[.!?])\s+/)
  const parts: string[] = []
  let current = ''

  for (const sentence of sentences) {
    if (sentence.length > maxLen) {
      // A single oversized sentence: flush what we have, then hard-wrap on spaces.
      if (current) parts.push(current)
      let rest = sentence
      while (rest.length > maxLen) {
        const cut = rest.lastIndexOf(' ', maxLen)
        const at = cut > maxLen / 2 ? cut : maxLen
        parts.push(rest.slice(0, at).trim())
        rest = rest.slice(at).trim()
      }
      current = rest
      continue
    }
    const candidate = current ? `${current} ${sentence}` : sentence
    if (candidate.length <= maxLen) {
      current = candidate
    } else {
      if (current) parts.push(current)
      current = sentence
    }
  }
  if (current) parts.push(current)

  if (parts.length > maxParts) {
    const kept = parts.slice(0, maxParts)
    kept[maxParts - 1] = `${kept[maxParts - 1].slice(0, maxLen - 1)}${ELLIPSIS}`
    return kept
  }
  return parts
}
