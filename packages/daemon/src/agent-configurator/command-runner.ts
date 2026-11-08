import { spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export interface CommandResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

export type CommandRunner = (command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<CommandResult>

/** Run a program without a shell (arguments are never re-parsed), capturing bounded output. */
export const runCommand: CommandRunner = (command, args, options) =>
  new Promise((resolve) => {
    const child = spawn(command, [...args], { env: options.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const cap = (current: string, chunk: Buffer): string => (current.length > 64_000 ? current : current + chunk.toString('utf8'))
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = cap(stdout, chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = cap(stderr, chunk)
    })
    const timer = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: `${stderr}${error.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })

/** Find an executable on PATH (PATHEXT-aware on Windows). */
export function findExecutable(name: string, env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform): string | null {
  const pathValue = env['PATH'] ?? env['Path'] ?? ''
  const extensions = platform === 'win32' ? (env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext !== '') : ['']
  for (const dir of pathValue.split(platform === 'win32' ? ';' : delimiter)) {
    if (dir === '') continue
    for (const ext of extensions) {
      const candidate = join(dir, name + ext.toLowerCase())
      try {
        if (!statSync(candidate).isFile()) continue
        if (platform !== 'win32') accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        // not here
      }
    }
  }
  return null
}
