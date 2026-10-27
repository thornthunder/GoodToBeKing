/**
 * Paints classic 64x64 skins (the standard player shape, no custom geometry) for the court:
 * the royal guards Bruce and Dyke in steel and red livery with the golden crown, Festaris the
 * Castellan in a green robe with his chain of office, and the apprentices Henry and George in
 * work tunics and leather aprons. Pixel art in code so it can be tweaked and rebuilt.
 *
 *   tsx scripts/make-court-skins.ts [preview-dir]
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

class Canvas {
  readonly png: PNG
  constructor(width: number, height: number) {
    this.png = new PNG({ width, height })
    this.png.data.fill(0)
  }
  px(x: number, y: number, c: RGBA): void {
    const i = (y * this.png.width + x) * 4
    this.png.data.set(c, i)
  }
  fill(x: number, y: number, w: number, h: number, c: RGBA): void {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.px(i, j, c)
  }
  get(x: number, y: number): RGBA {
    const i = (y * this.png.width + x) * 4
    return [this.png.data[i], this.png.data[i + 1], this.png.data[i + 2], this.png.data[i + 3]]
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

/** The six faces of a w x h x d box whose UV origin is (u, v), as laid out in a skin. */
function faces(
  u: number,
  v: number,
  w: number,
  h: number,
  d: number
): Record<'top' | 'bottom' | 'right' | 'front' | 'left' | 'back', Rect> {
  return {
    top: { x: u + d, y: v, w, h: d },
    bottom: { x: u + d + w, y: v, w, h: d },
    right: { x: u, y: v + d, w: d, h },
    front: { x: u + d, y: v + d, w, h },
    left: { x: u + d + w, y: v + d, w: d, h },
    back: { x: u + 2 * d + w, y: v + d, w, h },
  }
}

/** Classic 64x64 layout: base box and overlay box of each part. */
const PARTS = {
  head: { base: faces(0, 0, 8, 8, 8), over: faces(32, 0, 8, 8, 8) },
  body: { base: faces(16, 16, 8, 12, 4), over: faces(16, 32, 8, 12, 4) },
  rightArm: { base: faces(40, 16, 4, 12, 4), over: faces(40, 32, 4, 12, 4) },
  leftArm: { base: faces(32, 48, 4, 12, 4), over: faces(48, 48, 4, 12, 4) },
  rightLeg: { base: faces(0, 16, 4, 12, 4), over: faces(0, 32, 4, 12, 4) },
  leftLeg: { base: faces(16, 48, 4, 12, 4), over: faces(0, 48, 4, 12, 4) },
}

const all = (f: Record<string, Rect>) => Object.values(f)
const sides = (f: Record<string, Rect>) => [f.front, f.right, f.left, f.back]
const paint = (cv: Canvas, rects: Rect[], c: RGBA) =>
  rects.forEach((r) => cv.fill(r.x, r.y, r.w, r.h, c))
/** A horizontal band from row `from` (inclusive) for `rows` rows on the given faces. */
const band = (cv: Canvas, rects: Rect[], from: number, rows: number, c: RGBA) =>
  rects.forEach((r) => cv.fill(r.x, r.y + from, r.w, Math.min(rows, r.h - from), c))

interface Look {
  skin: RGBA
  skinShade: RGBA
  hair: RGBA
  hairShade: RGBA
  eyes: RGBA
  /** Face rows 5 to 7: beard, moustache or bare chin. */
  chin: 'beard' | 'moustache' | 'bare'
  beard?: RGBA
  freckles?: boolean
}

function face(cv: Canvas, look: Look): void {
  const h = PARTS.head.base
  paint(cv, all(h), look.hair)
  // Skin on the sides below the hair line, with an ear.
  for (const s of [h.right, h.left]) cv.fill(s.x, s.y + 3, s.w, 5, look.skin)
  cv.fill(h.right.x + 5, h.right.y + 4, 1, 2, look.skinShade)
  cv.fill(h.left.x + 2, h.left.y + 4, 1, 2, look.skinShade)
  paint(cv, [h.bottom], look.skin)
  const { x, y } = h.front
  const S = look.skin
  const D = look.skinShade
  const H = look.hair
  const W = hex('#ffffff')
  const E = look.eyes
  const B = look.beard ?? look.hair
  const rows: RGBA[][] = [
    [H, H, H, H, H, H, H, H],
    [H, H, S, S, S, S, H, H],
    [S, S, S, S, S, S, S, S],
    [S, W, E, S, S, E, W, S],
    [S, S, S, D, D, S, S, S],
    [S, S, S, S, S, S, S, S],
    [S, S, D, D, D, D, S, S],
    [S, S, S, S, S, S, S, S],
  ]
  if (look.chin === 'moustache') rows[5] = [S, S, B, B, B, B, S, S]
  if (look.chin === 'beard') {
    rows[5] = [B, S, B, B, B, B, S, B]
    rows[6] = [B, B, B, D, D, B, B, B]
    rows[7] = [S, B, B, B, B, B, B, S]
  }
  if (look.freckles) {
    rows[4][1] = D
    rows[4][6] = D
  }
  rows.forEach((row, j) => row.forEach((c, i) => cv.px(x + i, y + j, c)))
}

/** Boots and trousers on both legs. */
function legs(cv: Canvas, trousers: RGBA, boots: RGBA, shade: RGBA): void {
  for (const leg of [PARTS.rightLeg.base, PARTS.leftLeg.base]) {
    paint(cv, all(leg), trousers)
    band(cv, sides(leg), 9, 3, boots)
    paint(cv, [leg.bottom], boots)
    cv.fill(leg.front.x + 1, leg.front.y, 1, 9, shade)
  }
}

/** Sleeves (and hands at the cuff) on both arms. */
function arms(cv: Canvas, sleeve: RGBA, hand: RGBA, cuff?: RGBA): void {
  for (const arm of [PARTS.rightArm.base, PARTS.leftArm.base]) {
    paint(cv, all(arm), sleeve)
    band(cv, sides(arm), 10, 2, hand)
    paint(cv, [arm.bottom], hand)
    if (cuff) band(cv, sides(arm), 9, 1, cuff)
  }
}

function crown(cv: Canvas, r: Rect, gold: RGBA): void {
  // A small crown in the middle of a tabard (5 wide, 3 tall).
  const cx = r.x + Math.floor(r.w / 2) - 2
  const cy = r.y + 3
  for (const i of [0, 2, 4]) cv.px(cx + i, cy, gold)
  cv.fill(cx, cy + 1, 5, 2, gold)
}

function guard(look: Look, plume: RGBA | null): Canvas {
  const cv = new Canvas(64, 64)
  const steel = hex('#9aa3ad')
  const steelShade = hex('#6f7882')
  const steelDark = hex('#4f565e')
  const red = hex('#b3202a')
  const redShade = hex('#8a1820')
  const gold = hex('#e3b341')
  face(cv, look)
  // Helmet (head overlay): a steel cap with a nose guard, open face.
  const o = PARTS.head.over
  paint(cv, [o.top], steel)
  band(cv, sides(o), 0, 2, steel)
  band(cv, [o.right, o.left, o.back], 2, 4, steel)
  cv.fill(o.front.x + 3, o.front.y + 2, 2, 3, steelShade)
  band(cv, sides(o), 1, 1, steelShade)
  if (plume) cv.fill(o.top.x + 3, o.top.y, 2, 8, plume)
  // Mail under a red tabard with the crown, a belt.
  const b = PARTS.body.base
  paint(cv, all(b), steelShade)
  for (const r of [b.front, b.back]) {
    cv.fill(r.x + 1, r.y, r.w - 2, r.h, red)
    cv.fill(r.x + 1, r.y + r.h - 1, r.w - 2, 1, redShade)
    cv.fill(r.x + 1, r.y, 1, r.h, redShade)
  }
  crown(cv, b.front, gold)
  band(cv, sides(b), 7, 1, hex('#4a2c14'))
  cv.px(b.front.x + 3, b.front.y + 7, gold)
  // Shoulder plates on the overlay of the arms, steel sleeves, leather gloves.
  arms(cv, steel, hex('#5a3a1f'), steelDark)
  for (const arm of [PARTS.rightArm.over, PARTS.leftArm.over]) {
    paint(cv, [arm.top], steel)
    band(cv, sides(arm), 0, 3, steel)
    band(cv, sides(arm), 2, 1, steelShade)
  }
  legs(cv, steelDark, hex('#2a2a2a'), steelShade)
  return cv
}

function castellan(): Canvas {
  const cv = new Canvas(64, 64)
  const look: Look = {
    skin: hex('#e2b192'),
    skinShade: hex('#c6957a'),
    hair: hex('#b8b8b8'),
    hairShade: hex('#8f8f8f'),
    eyes: hex('#4b6b3a'),
    chin: 'beard',
    beard: hex('#c9c9c9'),
  }
  face(cv, look)
  const green = hex('#2f5d34')
  const greenShade = hex('#244a29')
  const gold = hex('#e3b341')
  const b = PARTS.body.base
  paint(cv, all(b), green)
  cv.fill(b.front.x + 3, b.front.y, 2, 12, greenShade)
  // The chain of office: a gold chain over the shoulders with a medallion.
  cv.fill(b.front.x, b.front.y, 1, 3, gold)
  cv.fill(b.front.x + 7, b.front.y, 1, 3, gold)
  cv.fill(b.front.x + 1, b.front.y + 3, 1, 1, gold)
  cv.fill(b.front.x + 6, b.front.y + 3, 1, 1, gold)
  cv.fill(b.front.x + 2, b.front.y + 4, 4, 1, gold)
  cv.fill(b.front.x + 3, b.front.y + 5, 2, 2, hex('#f6d36b'))
  paint(cv, [b.top], gold)
  band(cv, sides(b), 8, 1, hex('#5a3a1f'))
  cv.px(b.front.x + 6, b.front.y + 9, gold) // keys at the belt
  cv.px(b.front.x + 6, b.front.y + 10, gold)
  // A long robe: the overlay of the legs carries the skirt.
  arms(cv, green, look.skin, gold)
  legs(cv, hex('#2a2a35'), hex('#1e1e1e'), greenShade)
  for (const leg of [PARTS.rightLeg.over, PARTS.leftLeg.over]) band(cv, sides(leg), 0, 8, green)
  return cv
}

function apprentice(look: Look, tunic: RGBA, tunicShade: RGBA, apron: RGBA): Canvas {
  const cv = new Canvas(64, 64)
  face(cv, look)
  const b = PARTS.body.base
  paint(cv, all(b), tunic)
  band(cv, sides(b), 0, 1, tunicShade)
  // Leather apron on the front with a pocket and its strings round the back.
  cv.fill(b.front.x + 1, b.front.y + 2, 6, 10, apron)
  cv.fill(b.front.x + 2, b.front.y + 7, 3, 2, hex('#5e3b1c'))
  cv.fill(b.back.x, b.back.y + 7, b.back.w, 1, apron)
  // Rolled-up sleeves: forearms bare.
  arms(cv, tunic, look.skin)
  for (const arm of [PARTS.rightArm.base, PARTS.leftArm.base]) {
    band(cv, sides(arm), 5, 5, look.skin)
    band(cv, sides(arm), 4, 1, tunicShade)
  }
  legs(cv, hex('#5b4632'), hex('#3a2a1a'), hex('#4a3828'))
  return cv
}

const crew: Record<string, Canvas> = {
  bruce: guard(
    {
      skin: hex('#d9a27e'),
      skinShade: hex('#bf8865'),
      hair: hex('#3a2a1c'),
      hairShade: hex('#2a1e14'),
      eyes: hex('#4a3020'),
      chin: 'beard',
      beard: hex('#3a2a1c'),
    },
    null
  ),
  dyke: guard(
    {
      skin: hex('#f0c6a8'),
      skinShade: hex('#d8a888'),
      hair: hex('#b5562a'),
      hairShade: hex('#8c3f1e'),
      eyes: hex('#3d7a3a'),
      chin: 'moustache',
      beard: hex('#b5562a'),
    },
    hex('#d22a2a')
  ),
  festaris: castellan(),
  henry: apprentice(
    {
      skin: hex('#e8b998'),
      skinShade: hex('#cf9c7a'),
      hair: hex('#6b4423'),
      hairShade: hex('#4f3219'),
      eyes: hex('#3a6fd8'),
      chin: 'bare',
    },
    hex('#2e5fa8'),
    hex('#244b85'),
    hex('#8b5a2b')
  ),
  george: apprentice(
    {
      skin: hex('#f2c9a9'),
      skinShade: hex('#d9ab8a'),
      hair: hex('#e3c25a'),
      hairShade: hex('#c4a243'),
      eyes: hex('#5a7d9a'),
      chin: 'bare',
      freckles: true,
    },
    hex('#a8542a'),
    hex('#874221'),
    hex('#d8c8a0')
  ),
}

for (const [name, cv] of Object.entries(crew)) {
  const file = path.resolve('config/skins', `${name}.png`)
  cv.save(file)
  console.log(`wrote ${file}`)
}

/** Optional preview: each skin's front (head, body, arms, legs) scaled up side by side. */
const previewDir = process.argv[2]
if (previewDir) {
  const scale = 8
  const sheet = new Canvas(Object.keys(crew).length * 18 * scale, 34 * scale)
  Object.values(crew).forEach((cv, n) => {
    const ox = n * 18 * scale + scale
    const blit = (r: Rect, dx: number, dy: number) => {
      for (let j = 0; j < r.h; j++)
        for (let i = 0; i < r.w; i++) {
          const c = cv.get(r.x + i, r.y + j)
          if (c[3] === 0) continue
          sheet.fill(ox + (dx + i) * scale, (dy + j) * scale + scale, scale, scale, c)
        }
    }
    blit(PARTS.head.base.front, 4, 0)
    blit(PARTS.head.over.front, 4, 0)
    blit(PARTS.body.base.front, 4, 8)
    blit(PARTS.rightArm.base.front, 0, 8)
    blit(PARTS.leftArm.base.front, 12, 8)
    blit(PARTS.rightArm.over.front, 0, 8)
    blit(PARTS.leftArm.over.front, 12, 8)
    blit(PARTS.rightLeg.base.front, 4, 20)
    blit(PARTS.leftLeg.base.front, 8, 20)
    blit(PARTS.rightLeg.over.front, 4, 20)
    blit(PARTS.leftLeg.over.front, 8, 20)
  })
  const file = path.resolve(previewDir, 'court-skins-preview.png')
  sheet.save(file)
  console.log(`wrote ${file}`)
}
