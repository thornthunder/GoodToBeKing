import { describe, expect, it } from 'vitest'
import { geometryName, loadSkin } from './skin'

const merlin = {
  texture: 'config/skins/merlin.png',
  geometry: 'config/skins/merlin.geo.json',
  cape: 'config/skins/merlin-cape.png',
}

const fromB64 = (value: unknown) => Buffer.from(String(value), 'base64')

describe('loadSkin', () => {
  it("builds a classic skin with Merlin's custom geometry and cape", () => {
    const skin = loadSkin(merlin, 'Merlin')
    expect(skin.SkinImageWidth).toBe(64)
    expect(skin.SkinImageHeight).toBe(64)
    expect(fromB64(skin.SkinData)).toHaveLength(64 * 64 * 4)
    expect(JSON.parse(fromB64(skin.SkinResourcePatch).toString())).toEqual({
      geometry: { default: 'geometry.merlin.wizard' },
    })
    expect(JSON.parse(fromB64(skin.SkinGeometryData).toString())['format_version']).toBe('1.12.0')
    expect(skin.PersonaSkin).toBe(false)
    expect(skin.AnimatedImageData).toEqual([])
    expect(skin.CapeImageWidth).toBe(64)
    expect(skin.CapeImageHeight).toBe(32)
    expect(fromB64(skin.CapeData)).toHaveLength(64 * 32 * 4)
    expect(skin.CapeOnClassicSkin).toBe(true)
    expect(String(skin.SkinId)).toMatch(/^merlin-[0-9a-f]{12}$/)
  })

  it('falls back to the classic humanoid shape and no cape', () => {
    const skin = loadSkin({ texture: merlin.texture }, 'Merlin')
    expect(JSON.parse(fromB64(skin.SkinResourcePatch).toString()).geometry.default).toBe(
      'geometry.humanoid.custom'
    )
    expect(skin.SkinGeometryData).toBe('')
    expect(skin.CapeData).toBe('')
    expect(skin.CapeOnClassicSkin).toBe(false)
  })

  it('reads the geometry identifier', () => {
    expect(() => geometryName('{}')).toThrow(/identifier/)
  })
})
