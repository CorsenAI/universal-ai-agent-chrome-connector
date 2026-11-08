#!/usr/bin/env node
// Reads the Store zip back, independently of the code that wrote it, and checks it the way a
// reviewer would. Every entry must equal packages/extension/dist byte for byte; nothing may sit
// outside the file allowlist; the manifest must be valid for the Store (version, locales, name and
// description lengths, no Google trademark in the name, icons of the declared sizes, the frozen
// permission set, a CSP without eval or remote script); no script may evaluate strings, load
// remote code, point to a source map or carry a path of the machine that built it.
//
//   node scripts/verify-extension-zip.mjs [release/universal-ai-agent-connector-<version>.zip]
//
// Exit 0 only when every check passes.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, inflateRawSync } from 'node:zlib'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DIST = join(ROOT, 'packages', 'extension', 'dist')
const packageVersion = JSON.parse(readFileSync(join(ROOT, 'packages', 'extension', 'package.json'), 'utf8')).version
const zipPath = process.argv[2] ?? join(ROOT, 'release', `universal-ai-agent-connector-${packageVersion}.zip`)

const ALLOWED_FILES = [
  /^manifest\.json$/,
  /^background\.js$/,
  /^(popup|sidepanel)\.html$/,
  /^assets\/[\w.-]+\.(js|css)$/,
  /^icons\/(icon-(16|32|48|128)|mark)\.png$/,
  /^_locales\/(en|fr)\/messages\.json$/,
]
const ALLOWED_KEYS = new Set([
  'manifest_version', 'name', 'short_name', 'version', 'description', 'default_locale', 'homepage_url', 'minimum_chrome_version',
  'incognito', 'icons', 'action', 'side_panel', 'background', 'permissions', 'content_security_policy',
])
// Frozen permission set (docs/DECISIONS.md D-005): adding one is a decision, never a side effect.
const PERMISSIONS = ['activeTab', 'alarms', 'debugger', 'scripting', 'sidePanel', 'storage', 'tabs']
const LIMITS = { name: 45, description: 132 }

const problems = []
const problem = (message) => problems.push(message)
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

if (!existsSync(zipPath)) {
  console.error(`no such zip: ${zipPath} (run node scripts/package-extension.mjs)`)
  process.exit(2)
}
const zip = readFileSync(zipPath)

// ---- 1. Read the archive through its central directory ------------------------------------
let eocd = -1
for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i -= 1) {
  if (zip.readUInt32LE(i) === 0x06054b50) {
    eocd = i
    break
  }
}
if (eocd < 0) {
  console.error('not a zip: no end-of-central-directory record')
  process.exit(2)
}
const entryCount = zip.readUInt16LE(eocd + 10)
const centralOffset = zip.readUInt32LE(eocd + 16)
const entries = new Map()
let cursor = centralOffset
for (let n = 0; n < entryCount; n += 1) {
  if (zip.readUInt32LE(cursor) !== 0x02014b50) {
    console.error(`central directory entry ${n} is corrupt`)
    process.exit(2)
  }
  const flags = zip.readUInt16LE(cursor + 8)
  const method = zip.readUInt16LE(cursor + 10)
  const crc = zip.readUInt32LE(cursor + 16)
  const compressedSize = zip.readUInt32LE(cursor + 20)
  const size = zip.readUInt32LE(cursor + 24)
  const nameLength = zip.readUInt16LE(cursor + 28)
  const extraLength = zip.readUInt16LE(cursor + 30)
  const commentLength = zip.readUInt16LE(cursor + 32)
  const localOffset = zip.readUInt32LE(cursor + 42)
  const name = zip.toString('utf8', cursor + 46, cursor + 46 + nameLength)
  cursor += 46 + nameLength + extraLength + commentLength
  if ((flags & 0x1) !== 0) problem(`${name}: encrypted entry`)
  if (zip.readUInt32LE(localOffset) !== 0x04034b50) {
    console.error(`local header of ${name} is corrupt`)
    process.exit(2)
  }
  const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28)
  const raw = zip.subarray(dataStart, dataStart + compressedSize)
  let data
  if (method === 0) data = raw
  else if (method === 8) data = inflateRawSync(raw)
  else {
    console.error(`${name}: unsupported compression method ${method}`)
    process.exit(2)
  }
  if (data.length !== size) problem(`${name}: inflated to ${data.length} bytes, header says ${size}`)
  if ((crc32(data) >>> 0) !== crc) problem(`${name}: CRC mismatch`)
  if (entries.has(name)) problem(`${name}: duplicate entry`)
  entries.set(name, data)
}

// ---- 2. Exactly dist/, byte for byte -------------------------------------------------------
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else out.push(path)
  }
  return out
}
if (existsSync(DIST)) {
  const sources = new Map(walk(DIST).map((file) => [relative(DIST, file).split(sep).join('/'), readFileSync(file)]))
  for (const [name, buffer] of sources) {
    const entry = entries.get(name)
    if (entry === undefined) problem(`missing from the zip: ${name}`)
    else if (sha256(entry) !== sha256(buffer)) problem(`differs from dist/: ${name}`)
  }
  for (const name of entries.keys()) if (!sources.has(name)) problem(`in the zip but not in dist/: ${name}`)
} else {
  problem('packages/extension/dist is missing: the byte-for-byte comparison could not run')
}

const sidecar = `${zipPath}.sha256`
if (existsSync(sidecar)) {
  const recorded = readFileSync(sidecar, 'utf8').split(/\s+/)[0]
  if (recorded !== sha256(zip)) problem(`${basename(sidecar)} records ${recorded}, the zip hashes to ${sha256(zip)}`)
}

// ---- 3. Allowlist ---------------------------------------------------------------------------
for (const name of entries.keys()) {
  if (!ALLOWED_FILES.some((pattern) => pattern.test(name))) problem(`not on the file allowlist: ${name}`)
}

// ---- 4. Manifest ----------------------------------------------------------------------------
const text = (name) => entries.get(name)?.toString('utf8')
let manifest = {}
try {
  manifest = JSON.parse(text('manifest.json') ?? 'null') ?? {}
} catch (error) {
  problem(`manifest.json does not parse: ${error.message}`)
}
if (!entries.has('manifest.json')) problem('manifest.json is not at the root of the zip')
if (manifest.manifest_version !== 3) problem(`manifest_version is ${manifest.manifest_version}, expected 3`)
if (manifest.version !== packageVersion) problem(`manifest version ${manifest.version}, packages/extension/package.json says ${packageVersion}`)
if (!/^\d+(\.\d+){0,3}$/.test(String(manifest.version)) || String(manifest.version).split('.').some((part) => Number(part) > 65535)) problem(`version ${manifest.version} is not 1 to 4 integers of at most 65535`)
if (!basename(zipPath).includes(`-${manifest.version}.zip`)) problem(`the file name ${basename(zipPath)} does not carry version ${manifest.version}`)
for (const key of Object.keys(manifest)) if (!ALLOWED_KEYS.has(key)) problem(`unexpected manifest key: ${key}`)
const permissions = [...(manifest.permissions ?? [])].sort()
if (JSON.stringify(permissions) !== JSON.stringify(PERMISSIONS)) problem(`permissions ${JSON.stringify(permissions)} differ from the frozen set ${JSON.stringify(PERMISSIONS)}`)
const csp = manifest.content_security_policy?.extension_pages ?? ''
const scriptSrc = /script-src([^;]*)/.exec(csp)?.[1] ?? ''
if (/unsafe-eval|unsafe-inline|https?:/.test(scriptSrc)) problem(`extension_pages script-src allows more than the package: ${scriptSrc.trim()}`)
for (const path of [manifest.background?.service_worker, manifest.action?.default_popup, manifest.side_panel?.default_path]) {
  if (typeof path !== 'string' || !entries.has(path)) problem(`manifest points to a missing file: ${path}`)
}

// Localized name and description, per shipped locale.
const locales = [...entries.keys()].filter((name) => name.startsWith('_locales/')).map((name) => name.split('/')[1])
if (!locales.includes(manifest.default_locale)) problem(`default_locale ${manifest.default_locale} has no messages.json`)
for (const locale of locales) {
  let messages = {}
  try {
    messages = JSON.parse(text(`_locales/${locale}/messages.json`) ?? '{}')
  } catch (error) {
    problem(`_locales/${locale}/messages.json does not parse: ${error.message}`)
  }
  const resolve = (value) => String(value ?? '').replace(/__MSG_(\w+)__/g, (_, key) => messages[key]?.message ?? `<missing ${key}>`)
  const name = resolve(manifest.name)
  const description = resolve(manifest.description)
  for (const [field, value] of [['name', name], ['description', description]]) {
    if (value.includes('<missing')) problem(`${locale}: ${field} uses a message that does not exist`)
    if ([...value].length > LIMITS[field]) problem(`${locale}: ${field} is ${[...value].length} characters, the Store allows ${LIMITS[field]}`)
  }
  if (/\b(chrome|google)\b/i.test(name)) problem(`${locale}: the name "${name}" uses a Google trademark (Store branding guidelines)`)
}

// Icons: declared sizes exist and are PNGs of exactly that size.
for (const [size, path] of Object.entries(manifest.icons ?? {})) {
  const png = entries.get(path)
  if (png === undefined) {
    problem(`icon ${size}: ${path} is missing`)
    continue
  }
  const signature = png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
  const width = signature ? png.readUInt32BE(16) : 0
  const height = signature ? png.readUInt32BE(20) : 0
  if (!signature || width !== Number(size) || height !== Number(size)) problem(`icon ${size}: ${path} is ${signature ? `${width}x${height}` : 'not a PNG'}`)
}
if (manifest.icons?.['128'] === undefined) problem('no 128x128 icon: the Store icon comes from it')

// ---- 5. Scripts and pages -------------------------------------------------------------------
const FORBIDDEN = [
  [/\beval\s*\(/, 'eval('],
  [/\bnew\s+Function\s*\(/, 'new Function('],
  [/<script[^>]+src=["']?https?:/i, 'a remote <script>'],
  [/\bimport\s*\(\s*["'`]https?:/, 'a remote import()'],
  [/\bimportScripts\s*\(/, 'importScripts('],
  [/sourceMappingURL=/, 'a source map reference'],
  [/(?:\/home\/[\w.-]+\/|\/Users\/[\w.-]+\/|[A-Za-z]:\\\\Users\\\\)/, 'a local filesystem path'],
]
for (const [name, data] of entries) {
  if (!/\.(js|html|css|json)$/.test(name)) continue
  const source = data.toString('utf8')
  for (const [pattern, label] of FORBIDDEN) if (pattern.test(source)) problem(`${name}: contains ${label}`)
}

// ---- Report ---------------------------------------------------------------------------------
const total = [...entries.values()].reduce((sum, data) => sum + data.length, 0)
const shown = zipPath.startsWith(ROOT) ? relative(ROOT, zipPath) : zipPath
console.log(`${shown}: ${entries.size} entries (${total} bytes unpacked, ${zip.length} packed), manifest ${manifest.version}, locales ${locales.join(', ')}`)
console.log(`sha256 ${sha256(zip)}`)
if (problems.length > 0) {
  for (const message of problems) console.log(`  x ${message}`)
  console.log(`${problems.length} problem${problems.length === 1 ? '' : 's'}: not a Store package.`)
  process.exit(1)
}
console.log('every entry matches dist/ byte for byte; allowlist, manifest, icons, permissions, CSP and scripts pass.')
