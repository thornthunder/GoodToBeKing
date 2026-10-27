import minecraftData from 'minecraft-data'

/** Version whose language table is used until a connection reports its own. */
const DEFAULT_VERSION = '1.26.51'

let strings: Record<string, string> | undefined

/** Load the English language table for a Bedrock version (e.g. "1.26.51"). */
export function useLanguage(version: string): void {
  try {
    const data = minecraftData(`bedrock_${version}`)
    if (data?.language) strings = data.language
  } catch {
    // Unknown version: keep whatever table is loaded.
  }
}

function table(): Record<string, string> {
  if (!strings) useLanguage(DEFAULT_VERSION)
  return strings ?? {}
}

/** Fill `%s` and `%1$s` placeholders. */
export function formatTemplate(template: string, params: string[]): string {
  let i = 0
  return template.replace(/%(\d+)\$s|%s/g, (_m, index?: string) => {
    const value = index ? params[Number(index) - 1] : params[i++]
    return value ?? ''
  })
}

/** A parameter can itself be a key, as in "%entity.zombie.name". */
export function translateParam(param: string): string {
  if (!param.startsWith('%')) return param
  const template = table()[param.slice(1)]
  return template ?? param
}

/**
 * Translate a `text` packet translation message: either a key ("chat.type.sleeping",
 * "%multiplayer.player.joined") or a literal template ("%1$s was slain by %2$s").
 */
export function translate(message: string, params: string[] = []): string {
  const resolved = params.map(translateParam)
  const template = table()[message.replace(/^%/, '')]
  return formatTemplate(template ?? message, resolved)
}
