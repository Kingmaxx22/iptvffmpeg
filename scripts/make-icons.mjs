// Generates the app icon set (PNG + ICO) with no image tooling installed.
//
// The icon is a Fluent-style dark rounded tile with the accent-blue play glyph
// and a progress-bar underline. Run with: node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'icons')

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** @param {number} size @returns {Buffer} RGBA pixel buffer */
function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4)
  const r = size * 0.22 // corner radius
  const set = (x, y, [cr, cg, cb, ca]) => {
    const i = (y * size + x) * 4
    const a = ca / 255
    px[i] = Math.round(px[i] * (1 - a) + cr * a)
    px[i + 1] = Math.round(px[i + 1] * (1 - a) + cg * a)
    px[i + 2] = Math.round(px[i + 2] * (1 - a) + cb * a)
    px[i + 3] = Math.max(px[i + 3], ca)
  }

  // Rounded tile with a vertical mica gradient.
  const inside = (x, y) => {
    const cx = Math.min(Math.max(x, r), size - r)
    const cy = Math.min(Math.max(y, r), size - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
  }
  for (let y = 0; y < size; y++) {
    const t = y / (size - 1)
    const bg = [
      Math.round(0x0f + (0x28 - 0x0f) * t),
      Math.round(0x11 + (0x2c - 0x11) * t),
      Math.round(0x15 + (0x35 - 0x15) * t),
    ]
    for (let x = 0; x < size; x++) {
      if (!inside(x, y)) continue
      set(x, y, [...bg, 255])
    }
  }

  // Play triangle, optically centred.
  const cx = size * 0.5
  const cy = size * 0.47
  const triW = size * 0.2
  const triH = size * 0.24
  const left = cx - triW * 0.45
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - left
      const dy = y - cy
      // Triangle pointing right: |dx| grows as |dy| shrinks.
      if (dx >= -1 && dx <= triW && Math.abs(dy) <= (triH / 2) * (1 - dx / triW)) {
        set(x, y, [0x60, 0xcd, 0xff, 255])
      }
    }
  }

  // Accent progress underline.
  const barY = Math.round(size * 0.76)
  const barH = Math.max(2, Math.round(size * 0.045))
  const barX = Math.round(size * 0.3)
  const barW = Math.round(size * 0.4)
  for (let y = barY; y < Math.min(size, barY + barH); y++) {
    for (let x = barX; x < barX + barW; x++) {
      if (inside(x, y)) set(x, y, [0x60, 0xcd, 0xff, 255])
    }
  }

  return px
}

function encodePng(px, size) {
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * ICO with classic BMP entries.
 *
 * Windows' resource compiler (rc.exe) rejects PNG-compressed icons with
 * "not in 3.00 format", so every entry is a BITMAPINFOHEADER + BGRA pixels +
 * AND mask, stored bottom-up.
 */
function encodeIcoBmp(sizes) {
  const entries = []
  const payloads = []
  let offset = 6 + sizes.length * 16

  for (const size of sizes) {
    const px = drawIcon(size)
    const rowBytes = size * 4
    const maskRow = ((size + 31) >> 5) << 2
    const xorSize = rowBytes * size
    const andSize = maskRow * size

    const dib = Buffer.alloc(40)
    dib.writeUInt32LE(40, 0) // header size
    dib.writeInt32LE(size, 4) // width
    dib.writeInt32LE(size * 2, 8) // height: XOR + AND mask
    dib.writeUInt16LE(1, 12) // planes
    dib.writeUInt16LE(32, 14) // bits per pixel
    dib.writeUInt32LE(0, 16) // BI_RGB
    dib.writeUInt32LE(xorSize + andSize, 20)

    // BGRA, bottom-up.
    const xor = Buffer.alloc(xorSize)
    for (let y = 0; y < size; y++) {
      const src = (size - 1 - y) * rowBytes
      for (let x = 0; x < size; x++) {
        const si = src + x * 4
        const di = y * rowBytes + x * 4
        xor[di] = px[si + 2] // B
        xor[di + 1] = px[si + 1] // G
        xor[di + 2] = px[si] // R
        xor[di + 3] = px[si + 3] // A
      }
    }

    const payload = Buffer.concat([dib, xor, Buffer.alloc(andSize)])

    const entry = Buffer.alloc(16)
    entry[0] = size >= 256 ? 0 : size
    entry[1] = size >= 256 ? 0 : size
    entry[2] = 0 // palette size
    entry[3] = 0 // reserved
    entry.writeUInt16LE(1, 4) // colour planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(payload.length, 8)
    entry.writeUInt32LE(offset, 12)

    entries.push(entry)
    payloads.push(payload)
    offset += payload.length
  }

  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved (must be 0 for format 3.00)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(sizes.length, 4)
  return Buffer.concat([header, ...entries, ...payloads])
}

mkdirSync(OUT_DIR, { recursive: true })

const sizes = [16, 32, 48, 64, 128, 256]
const pngs = sizes.map((size) => ({ size, png: encodePng(drawIcon(size), size) }))

writeFileSync(join(OUT_DIR, '32x32.png'), pngs.find((p) => p.size === 32).png)
writeFileSync(join(OUT_DIR, '128x128.png'), pngs.find((p) => p.size === 128).png)
writeFileSync(join(OUT_DIR, '128x128@2x.png'), pngs.find((p) => p.size === 256).png)
writeFileSync(join(OUT_DIR, 'icon.png'), pngs.find((p) => p.size === 256).png)
writeFileSync(join(OUT_DIR, 'icon.ico'), encodeIcoBmp([16, 32, 48, 256]))

console.log(`wrote icons to ${OUT_DIR}`)