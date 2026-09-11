// Build step (chained after `vite build`): emit .gz and .br companions for
// every servable file in dist/ so server/core.ts serves precompressed static
// responses with zero runtime CPU. Plain Node + zlib only — no new deps.
// Already-compressed formats (images, video, woff2) are skipped: re-compressing
// them wastes build time and yields nothing.
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const distRoot = path.resolve(__dirname, '..', 'dist')
const skippedExtensions = new Set(['.gz', '.br', '.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.ico', '.mp4', '.webm', '.mov', '.mkv', '.woff', '.woff2'])

if (!fs.existsSync(distRoot)) {
  console.error('compress-dist: dist/ is missing — run vite build first.')
  process.exit(1)
}

let fileCount = 0
let rawBytes = 0
let gzipBytes = 0
let brotliBytes = 0

const walk = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      walk(full)
      continue
    }
    if (skippedExtensions.has(path.extname(entry.name).toLowerCase())) continue
    const raw = fs.readFileSync(full)
    // level 9 / brotli quality 11: build-time cost only, smallest wire size.
    const gzip = zlib.gzipSync(raw, { level: 9 })
    const brotli = zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } })
    fs.writeFileSync(`${full}.gz`, gzip)
    fs.writeFileSync(`${full}.br`, brotli)
    fileCount += 1
    rawBytes += raw.length
    gzipBytes += gzip.length
    brotliBytes += brotli.length
  }
}

try {
  walk(distRoot)
} catch (error) {
  console.error(`compress-dist: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`
console.log(`compress-dist: ${fileCount} files → .gz + .br companions (${kb(rawBytes)} raw → ${kb(gzipBytes)} gzip, ${kb(brotliBytes)} brotli)`)
