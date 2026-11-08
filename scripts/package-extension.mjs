#!/usr/bin/env node
// Packs packages/extension/dist — and only it — into the zip the Chrome Web Store takes.
//
// Reproducible on purpose: the extension is rebuilt first, entries are sorted, every timestamp is
// the commit date of HEAD (UTC), and deflate is used only where it helps, so one commit always
// gives the same bytes. Zero dependencies: zlib compresses, the container is written below (the
// same rules as Corsen AI WebMCP Explorer's Store packer). A release package comes from a clean
// tree; `--allow-dirty` exists to try the script and produces a package that is not a release.
//
//   node scripts/package-extension.mjs [--allow-dirty] [--no-build]
//   → release/universal-ai-agent-connector-<version>.zip  (+ .sha256)
//
// Then read it back independently: node scripts/verify-extension-zip.mjs

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateRawSync } from 'node:zlib'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DIST = join(ROOT, 'packages', 'extension', 'dist')
const OUT_DIR = join(ROOT, 'release')
const args = new Set(process.argv.slice(2))
const allowDirty = args.has('--allow-dirty')

function fail(message) {
  console.error(`package-extension: ${message}`)
  process.exit(1)
}

function git(gitArgs) {
  return execFileSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

// 1. A release is a commit: refuse uncommitted changes, stamp entries with the commit date.
let commit = 'uncommitted'
let stamp = new Date(Date.UTC(2026, 0, 1))
try {
  const dirty = git(['status', '--porcelain'])
  if (dirty !== '' && !allowDirty) fail(`uncommitted changes:\n${dirty}\nCommit them first, or pass --allow-dirty for a trial package.`)
  commit = git(['rev-parse', '--short=12', 'HEAD'])
  stamp = new Date(git(['log', '-1', '--format=%cI']))
  if (dirty !== '') commit += '-dirty'
} catch (error) {
  if (!allowDirty) fail(`a release package needs a git commit (${String(error.message).split('\n')[0]})`)
}

// 2. Build, so the package is this commit's build and not a leftover dist/.
if (!args.has('--no-build')) {
  const windows = process.platform === 'win32'
  execFileSync(windows ? 'pnpm.cmd' : 'pnpm', ['--filter', '@corsen-ai/extension', 'run', 'build'], { cwd: ROOT, stdio: 'inherit', shell: windows })
}
if (!existsSync(join(DIST, 'manifest.json'))) fail('packages/extension/dist/manifest.json is missing: run pnpm build')

const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'))
const packageVersion = JSON.parse(readFileSync(join(ROOT, 'packages', 'extension', 'package.json'), 'utf8')).version
if (manifest.version !== packageVersion) fail(`manifest version ${manifest.version} differs from packages/extension/package.json (${packageVersion})`)

// 3. Files, with forward slashes and a byte-order sort (stable on every platform).
function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else out.push(path)
  }
  return out
}
const files = walk(DIST)
  .map((path) => ({ name: relative(DIST, path).split(sep).join('/'), data: readFileSync(path) }))
  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
for (const file of files) {
  if (file.name.split('/').some((part) => part.startsWith('.'))) fail(`hidden file in dist/: ${file.name}`)
}

// 4. The zip container: local headers, central directory, end record. MS-DOS time in UTC.
function dosDateTime(date) {
  const year = Math.max(1980, date.getUTCFullYear())
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    day: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  }
}
const u16 = (n) => {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n)
  return b
}
const u32 = (n) => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n >>> 0)
  return b
}

const { time, day } = dosDateTime(stamp)
const locals = []
const centrals = []
let offset = 0
for (const file of files) {
  const compressed = deflateRawSync(file.data, { level: 9 })
  const deflate = compressed.length < file.data.length
  const body = deflate ? compressed : file.data
  const method = deflate ? 8 : 0
  const crc = crc32(file.data) >>> 0
  const name = Buffer.from(file.name, 'utf8')
  // Flag 0x0800: names are UTF-8. Version 2.0, no extra fields, no attributes.
  const local = Buffer.concat([
    u32(0x04034b50), u16(20), u16(0x0800), u16(method), u16(time), u16(day),
    u32(crc), u32(body.length), u32(file.data.length), u16(name.length), u16(0), name, body,
  ])
  const central = Buffer.concat([
    u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(method), u16(time), u16(day),
    u32(crc), u32(body.length), u32(file.data.length), u16(name.length), u16(0), u16(0),
    u16(0), u16(0), u32(0), u32(offset), name,
  ])
  locals.push(local)
  centrals.push(central)
  offset += local.length
}
const centralSize = centrals.reduce((sum, buffer) => sum + buffer.length, 0)
const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(centrals.length), u16(centrals.length), u32(centralSize), u32(offset), u16(0)])
const zip = Buffer.concat([...locals, ...centrals, end])

// 5. Write the archive and its checksum.
mkdirSync(OUT_DIR, { recursive: true })
const zipName = `universal-ai-agent-connector-${manifest.version}.zip`
const zipPath = join(OUT_DIR, zipName)
writeFileSync(zipPath, zip)
const sha256 = createHash('sha256').update(zip).digest('hex')
writeFileSync(`${zipPath}.sha256`, `${sha256}  ${zipName}\n`)
console.log(`release/${zipName}`)
console.log(`  ${files.length} files · ${zip.length} bytes · commit ${commit} · entries dated ${stamp.toISOString()}`)
console.log(`  sha256 ${sha256}`)
if (commit.endsWith('-dirty') || commit === 'uncommitted') console.log('  trial package (uncommitted tree): not a release')
