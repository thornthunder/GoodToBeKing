import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'

export interface SkinConfig {
  /** Skin texture PNG: 64x64 (classic layout) or 128x128. */
  texture: string
  /** Bedrock geometry JSON (format 1.12.0); without it the classic humanoid shape is used. */
  geometry?: string
  /** Cape texture PNG, 64x32. */
  cape?: string
}

const SKIN_SIZES = new Set(['64x64', '128x128', '64x32'])
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64')

function readPng(file: string): PNG {
  return PNG.sync.read(fs.readFileSync(path.resolve(file)))
}

/** Identifier of the first geometry in a geometry file, e.g. "geometry.merlin.wizard". */
export function geometryName(geometryJson: string): string {
  const parsed = JSON.parse(geometryJson) as {
    'minecraft:geometry'?: Array<{ description?: { identifier?: string } }>
  }
  const id = parsed['minecraft:geometry']?.[0]?.description?.identifier
  if (!id) throw new Error('geometry file has no minecraft:geometry[0].description.identifier')
  return id
}

/**
 * The skin fields of the login's client data, replacing the default persona skin with a classic
 * skin (and optional custom geometry and cape). Passed to bedrock-protocol as `skinData`.
 */
export function loadSkin(cfg: SkinConfig, botName: string): Record<string, unknown> {
  const texture = readPng(cfg.texture)
  const size = `${texture.width}x${texture.height}`
  if (!SKIN_SIZES.has(size)) throw new Error(`${cfg.texture}: unsupported skin size ${size}`)
  const geometry = cfg.geometry ? fs.readFileSync(path.resolve(cfg.geometry), 'utf8') : ''
  const geometryId = geometry ? geometryName(geometry) : 'geometry.humanoid.custom'
  const skinBytes = Buffer.from(texture.data)
  // A stable id per look, so clients can cache it.
  const hash = crypto
    .createHash('sha1')
    .update(skinBytes)
    .update(geometry)
    .digest('hex')
    .slice(0, 12)

  const skin: Record<string, unknown> = {
    SkinId: `${botName.toLowerCase()}-${hash}`,
    SkinData: skinBytes.toString('base64'),
    SkinImageWidth: texture.width,
    SkinImageHeight: texture.height,
    SkinResourcePatch: b64(JSON.stringify({ geometry: { default: geometryId } })),
    SkinGeometryData: geometry ? b64(geometry) : '',
    SkinGeometryDataEngineVersion: b64('1.14.0'),
    SkinAnimationData: '',
    AnimatedImageData: [],
    PersonaSkin: false,
    PersonaPieces: [],
    PieceTintColors: [],
    PremiumSkin: false,
    ArmSize: 'wide',
    SkinColor: '#0',
    CapeId: '',
    CapeData: '',
    CapeImageWidth: 0,
    CapeImageHeight: 0,
    CapeOnClassicSkin: false,
  }
  if (cfg.cape) {
    const cape = readPng(cfg.cape)
    const capeBytes = Buffer.from(cape.data)
    skin.CapeId = `${botName.toLowerCase()}-cape-${crypto.createHash('sha1').update(capeBytes).digest('hex').slice(0, 12)}`
    skin.CapeData = capeBytes.toString('base64')
    skin.CapeImageWidth = cape.width
    skin.CapeImageHeight = cape.height
    skin.CapeOnClassicSkin = true
  }
  return skin
}
