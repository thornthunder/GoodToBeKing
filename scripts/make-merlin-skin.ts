/**
 * Paints Merlin's wizard skin (64x64, for config/skins/merlin.geo.json), his cape (64x32) and,
 * optionally, a front/back preview image. Pixel art in code so it can be tweaked and rebuilt.
 *
 *   tsx scripts/make-merlin-skin.ts [preview.png]
 */
import fs from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'

type RGBA = [number, number, number, number]
const hex = (h: string): RGBA => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
  255,
]

const C = {
  skin: hex('#e8b998'),
  skinShade: hex('#cf9c7a'),
  nose: hex('#c48b69'),
  hair: hex('#f4f4f4'),
  hairShade: hex('#d4d4d4'),
  eyeWhite: hex('#ffffff'),
  iris: hex('#3a6fd8'),
  robe: hex('#2c2a7a'),
  robeShade: hex('#232163'),
  robeDark: hex('#1a1850'),
  gold: hex('#e3b341'),
  goldDark: hex('#b8892a'),
  star: hex('#fff2a8'),
  belt: hex('#6b3f1d'),
  hat: hex('#2a2470'),
  hatShade: hex('#1f1a58'),
  shoe: hex('#3b2a1a'),
  cape: hex('#4b2a7a'),
  capeShade: hex('#3b2063'),
}

class Canvas {
  readonly png: PNG
  constructor(width: number, height: number) {
    this.png = new PNG({ width, height })
    this.png.data.fill(0)
  }
  px(x: number, y: number, c: RGBA): void {
    const i = (y * this.png.width + x) * 4
    this.png.data[i] = c[0]
    this.png.data[i + 1] = c[1]
    this.png.data[i + 2] = c[2]
    this.png.data[i + 3] = c[3]
  }
  fill(x: number, y: number, w: number, h: number, c: RGBA): void {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.px(i, j, c)
  }
  save(file: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, PNG.sync.write(this.png))
  }
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Bedrock box UV: the six faces of a w x h x d cube whose UV origin is (u, v). */
function faces(u: number, v: number, w: number, h: number, d: number) {
  return {
    top: { x: u + d, y: v, w, h: d },
    bottom: { x: u + d + w, y: v, w, h: d },
    right: { x: u, y: v + d, w: d, h },
    front: { x: u + d, y: v + d, w, h },
    left: { x: u + d + w, y: v + d, w: d, h },
    back: { x: u + 2 * d + w, y: v + d, w, h },
  }
}

const fillRect = (cv: Canvas, r: Rect, c: RGBA) => cv.fill(r.x, r.y, r.w, r.h, c)

function head(cv: Canvas): void {
  const f = faces(0, 0, 8, 8, 8)
  fillRect(cv, f.top, C.hair)
  fillRect(cv, f.bottom, C.hair)
  fillRect(cv, f.back, C.hair)
  cv.fill(f.back.x, f.back.y + 6, 8, 2, C.hairShade)
  // Sides: white hair with skin at the temples next to the face, and an ear.
  fillRect(cv, f.right, C.hair)
  cv.fill(f.right.x + 6, f.right.y + 2, 2, 3, C.skin)
  cv.fill(f.right.x + 4, f.right.y + 3, 1, 2, C.skinShade)
  fillRect(cv, f.left, C.hair)
  cv.fill(f.left.x, f.left.y + 2, 2, 3, C.skin)
  cv.fill(f.left.x + 3, f.left.y + 3, 1, 2, C.skinShade)
  // Face: hairline, bushy brows, kind blue eyes, nose, moustache, long beard.
  const { x, y } = f.front
  const H = C.hair,
    S = C.skin,
    W = C.eyeWhite,
    I = C.iris,
    N = C.nose,
    D = C.hairShade
  const face: RGBA[][] = [
    [H, H, H, H, H, H, H, H],
    [H, S, S, S, S, S, S, H],
    [H, H, H, S, S, H, H, H],
    [S, W, I, S, S, I, W, S],
    [S, S, S, N, N, S, S, S],
    [H, H, H, D, D, H, H, H],
    [H, H, H, D, H, H, H, H],
    [D, H, H, H, H, H, H, D],
  ]
  face.forEach((row, j) => row.forEach((c, i) => cv.px(x + i, y + j, c)))

  // Head overlay (slightly bigger): the hat's band and a bushier beard.
  const o = faces(32, 0, 8, 8, 8)
  fillRect(cv, o.top, C.hat)
  for (const side of [o.front, o.right, o.left, o.back]) cv.fill(side.x, side.y, side.w, 1, C.gold)
  cv.fill(o.front.x, o.front.y + 6, 8, 2, C.hair)
  cv.fill(o.right.x + 6, o.right.y + 6, 2, 2, C.hair)
  cv.fill(o.left.x, o.left.y + 6, 2, 2, C.hair)
}

function body(cv: Canvas): void {
  const f = faces(16, 16, 8, 12, 4)
  fillRect(cv, f.top, C.robe)
  fillRect(cv, f.bottom, C.robeDark)
  fillRect(cv, f.right, C.robe)
  cv.fill(f.right.x, f.right.y, 1, 12, C.robeShade)
  cv.px(f.right.x + 2, f.right.y + 4, C.star)
  fillRect(cv, f.left, C.robe)
  cv.fill(f.left.x + 3, f.left.y, 1, 12, C.robeShade)
  cv.px(f.left.x + 1, f.left.y + 7, C.star)
  fillRect(cv, f.back, C.robe)
  for (const [i, j] of [
    [2, 3],
    [5, 8],
    [3, 10],
  ])
    cv.px(f.back.x + i, f.back.y + j, C.star)

  const { x, y } = f.front
  fillRect(cv, f.front, C.robe)
  cv.px(x, y, C.gold)
  cv.px(x + 7, y, C.gold)
  // The beard flows down the chest, narrowing to a point.
  cv.fill(x + 1, y, 6, 2, C.hair)
  cv.px(x + 1, y + 1, C.hairShade)
  cv.px(x + 6, y + 1, C.hairShade)
  cv.fill(x + 2, y + 2, 4, 2, C.hair)
  cv.fill(x + 3, y + 4, 2, 1, C.hair)
  cv.fill(x + 3, y + 5, 2, 1, C.hairShade)
  // Gold trim down the front, a belt with a buckle, a sprinkle of stars.
  cv.fill(x + 3, y + 6, 2, 6, C.gold)
  cv.fill(x, y + 7, 8, 1, C.belt)
  cv.fill(x + 3, y + 7, 2, 1, C.goldDark)
  for (const [i, j] of [
    [0, 4],
    [6, 5],
    [1, 9],
    [6, 10],
  ])
    cv.px(x + i, y + j, C.star)
}

function arm(cv: Canvas, u: number, v: number): void {
  const f = faces(u, v, 4, 12, 4)
  fillRect(cv, f.top, C.robe)
  fillRect(cv, f.bottom, C.skin)
  for (const side of [f.right, f.front, f.left, f.back]) {
    cv.fill(side.x, side.y, 4, 9, C.robe)
    cv.fill(side.x, side.y + 9, 4, 1, C.gold)
    cv.fill(side.x, side.y + 10, 4, 2, C.skin)
  }
  cv.fill(f.back.x, f.back.y, 4, 9, C.robeShade)
  cv.px(f.front.x + 1, f.front.y + 4, C.star)
}

function leg(cv: Canvas, u: number, v: number, trimColumn: number): void {
  const f = faces(u, v, 4, 12, 4)
  fillRect(cv, f.top, C.robe)
  fillRect(cv, f.bottom, C.shoe)
  for (const side of [f.right, f.front, f.left, f.back]) {
    cv.fill(side.x, side.y, 4, 9, C.robe)
    cv.fill(side.x, side.y + 9, 4, 1, C.gold)
    cv.fill(side.x, side.y + 10, 4, 1, C.robeDark)
    cv.fill(side.x, side.y + 11, 4, 1, C.shoe)
  }
  cv.fill(f.back.x, f.back.y, 4, 9, C.robeShade)
  // The robe's front trim continues down the middle, between the legs.
  cv.fill(f.front.x + trimColumn, f.front.y, 1, 9, C.gold)
  cv.px(f.front.x + (trimColumn === 0 ? 2 : 1), f.front.y + 4, C.star)
}

function wizardHat(cv: Canvas): void {
  // Brim 10x1x10.
  const brim = faces(0, 32, 10, 1, 10)
  fillRect(cv, brim.top, C.hat)
  fillRect(cv, brim.bottom, C.hatShade)
  for (const side of [brim.right, brim.front, brim.left, brim.back]) fillRect(cv, side, C.gold)
  // Lower cone 6x3x6 with a gold band and a star.
  const c1 = faces(40, 32, 6, 3, 6)
  fillRect(cv, c1.top, C.hat)
  fillRect(cv, c1.bottom, C.hatShade)
  for (const side of [c1.right, c1.front, c1.left, c1.back]) {
    fillRect(cv, side, C.hat)
    cv.fill(side.x, side.y + 1, side.w, 1, C.gold)
  }
  cv.px(c1.front.x + 2, c1.front.y, C.star)
  cv.px(c1.back.x + 4, c1.back.y + 2, C.star)
  // Middle cone 4x3x4.
  const c2 = faces(0, 48, 4, 3, 4)
  fillRect(cv, c2.top, C.hat)
  fillRect(cv, c2.bottom, C.hatShade)
  for (const side of [c2.right, c2.front, c2.left, c2.back]) fillRect(cv, side, C.hat)
  cv.px(c2.front.x + 1, c2.front.y + 1, C.star)
  cv.px(c2.right.x + 2, c2.right.y, C.star)
  // Upper cone 2x3x2 and a golden tip.
  const c3 = faces(48, 48, 2, 3, 2)
  for (const r of Object.values(c3)) fillRect(cv, r, C.hat)
  const tip = faces(56, 48, 1, 2, 1)
  for (const r of Object.values(tip)) fillRect(cv, r, C.gold)
}

function cape(): Canvas {
  const cv = new Canvas(64, 32)
  const f = faces(0, 0, 10, 16, 1)
  for (const r of Object.values(f)) fillRect(cv, r, C.cape)
  for (const side of [f.front, f.back]) {
    cv.fill(side.x, side.y, 1, 16, C.gold)
    cv.fill(side.x + 9, side.y, 1, 16, C.gold)
    cv.fill(side.x, side.y + 15, 10, 1, C.gold)
    cv.fill(side.x + 1, side.y, 8, 1, C.capeShade)
    for (const [i, j] of [
      [3, 3],
      [6, 5],
      [2, 8],
      [7, 10],
      [4, 12],
    ])
      cv.px(side.x + i, side.y + j, C.star)
  }
  return cv
}

/** Front and back views side by side, scaled up, for humans to look at. */
function preview(skin: Canvas, capeCanvas: Canvas, file: string): void {
  const S = 10
  const W = 16,
    H = 44,
    GAP = 6
  const out = new Canvas((W * 2 + GAP * 3) * S, (H + GAP * 2) * S)
  out.fill(0, 0, out.png.width, out.png.height, hex('#dfe6ee'))
  const blit = (src: Canvas, r: Rect, dx: number, dy: number) => {
    for (let j = 0; j < r.h; j++)
      for (let i = 0; i < r.w; i++) {
        const k = ((r.y + j) * src.png.width + (r.x + i)) * 4
        const a = src.png.data[k + 3]
        if (!a) continue
        const c: RGBA = [src.png.data[k], src.png.data[k + 1], src.png.data[k + 2], 255]
        out.fill((dx + i) * S, (dy + j) * S, S, S, c)
      }
  }
  const views = [
    { side: 'front' as const, ox: GAP, rightArm: [44, 20], leftArm: [36, 52] },
    { side: 'back' as const, ox: GAP * 2 + W, rightArm: [52, 20], leftArm: [44, 52] },
  ]
  for (const view of views) {
    const ox = view.ox,
      oy = GAP
    const F = (u: number, v: number, w: number, h: number, d: number) =>
      faces(u, v, w, h, d)[view.side]
    const back = view.side === 'back'
    // Viewed from behind, left and right swap places.
    blit(skin, F(0, 16, 4, 12, 4), ox + (back ? 8 : 4), oy + 32)
    blit(skin, F(16, 48, 4, 12, 4), ox + (back ? 4 : 8), oy + 32)
    blit(skin, F(16, 16, 8, 12, 4), ox + 4, oy + 20)
    blit(skin, F(40, 16, 4, 12, 4), ox + (back ? 12 : 0), oy + 20)
    blit(skin, F(32, 48, 4, 12, 4), ox + (back ? 0 : 12), oy + 20)
    blit(skin, F(0, 0, 8, 8, 8), ox + 4, oy + 12)
    blit(skin, F(32, 0, 8, 8, 8), ox + 4, oy + 12)
    blit(skin, F(0, 32, 10, 1, 10), ox + 3, oy + 11)
    blit(skin, F(40, 32, 6, 3, 6), ox + 5, oy + 8)
    blit(skin, F(0, 48, 4, 3, 4), ox + 6, oy + 5)
    blit(skin, F(48, 48, 2, 3, 2), ox + 7, oy + 2)
    blit(skin, F(56, 48, 1, 2, 1), ox + 7, oy + 0)
    if (back) blit(capeCanvas, faces(0, 0, 10, 16, 1).front, ox + 3, oy + 20)
  }
  out.save(file)
}

const skin = new Canvas(64, 64)
head(skin)
body(skin)
arm(skin, 40, 16) // right arm
arm(skin, 32, 48) // left arm
leg(skin, 0, 16, 3) // right leg: trim on its inner (left) edge
leg(skin, 16, 48, 0) // left leg: trim on its inner (right) edge
wizardHat(skin)
const capeCanvas = cape()

const dir = path.resolve('config/skins')
skin.save(path.join(dir, 'merlin.png'))
capeCanvas.save(path.join(dir, 'merlin-cape.png'))
console.log(`wrote ${path.join(dir, 'merlin.png')} and merlin-cape.png`)
if (process.argv[2]) {
  preview(skin, capeCanvas, path.resolve(process.argv[2]))
  console.log(`wrote preview ${path.resolve(process.argv[2])}`)
}
