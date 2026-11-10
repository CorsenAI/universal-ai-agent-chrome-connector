import { existsSync, readFileSync } from 'node:fs'
import { MCP_SERVER_NAME, type AgentActionResult, type AgentId, type AgentStatus } from '@corsen-ai/shared'
import type { Logger } from '../util/logger'
import { AGENT_SPECS, agentSpec, type AgentSpec, type ConfigTarget } from './agents'
import type { BackupStore } from './backups'
import { findExecutable, runCommand, type CommandRunner } from './command-runner'
import { ConfigFileError, backupFile, editJsonc, readJsonc, valueAt, writeAtomically } from './json-config'
import type { LaunchCommand } from './launch'
import { claudeCodeConfig, displayPath, type PlatformContext } from './locations'

export interface ConfiguratorOptions {
  readonly ctx: PlatformContext
  readonly launch: LaunchCommand
  readonly backups: BackupStore
  readonly logger: Logger
  readonly runner?: CommandRunner
}

/**
 * 1-click agent onboarding: detect installed agents, add/remove our MCP server entry with a
 * timestamped backup, and restore the last backup. Every result is re-read from disk before it is
 * reported, so "connected" means the entry really is in the file.
 */
export class AgentConfigurator {
  readonly #options: ConfiguratorOptions
  readonly #runner: CommandRunner

  constructor(options: ConfiguratorOptions) {
    this.#options = options
    this.#runner = options.runner ?? runCommand
  }

  list(): AgentStatus[] {
    return AGENT_SPECS.map((spec) => this.status(spec.id))
  }

  status(id: AgentId): AgentStatus {
    const spec = agentSpec(id)
    const { ctx } = this.#options
    const targets = spec.targets(ctx, this.#options.launch)
    const notes = [...spec.notes(ctx)]
    let connected = false
    for (const target of targets) {
      try {
        if (valueAt(readJsonc(target.file).data, target.path) !== undefined) connected = true
      } catch (error) {
        notes.push((error as Error).message)
      }
    }
    return {
      id,
      name: spec.name,
      detected: spec.detect(ctx, (name) => this.#hasExecutable(name)),
      connected,
      method: this.#usesClaudeCli(spec) ? 'cli' : 'file',
      configPaths: targets.map((target) => displayPath(ctx, target.file)),
      backups: this.#options.backups.list(id).length,
      needsRestart: spec.needsRestart,
      notes: notes.slice(0, 8),
    }
  }

  async connect(id: AgentId): Promise<AgentActionResult> {
    const spec = agentSpec(id)
    const targets = spec.targets(this.#options.ctx, this.#options.launch)
    if (this.#usesClaudeCli(spec)) return this.#claudeCli(spec, targets, 'connect')
    return this.#editAll(spec, targets, 'connect')
  }

  async unlink(id: AgentId): Promise<AgentActionResult> {
    const spec = agentSpec(id)
    const targets = spec.targets(this.#options.ctx, this.#options.launch)
    if (this.#usesClaudeCli(spec)) return this.#claudeCli(spec, targets, 'unlink')
    return this.#editAll(spec, targets, 'unlink')
  }

  /**
   * Put back the most recent backup of each config file. For Claude Code the file is its whole
   * state store (history, settings), so restoring an old copy would lose unrelated changes: restore
   * means removing our entry there.
   */
  async restore(id: AgentId): Promise<AgentActionResult> {
    const spec = agentSpec(id)
    if (spec.id === 'claude-code') {
      const result = await this.unlink(id)
      const file = displayPath(this.#options.ctx, claudeCodeConfig(this.#options.ctx))
      return { ...result, message: `${result.message} (Claude Code keeps all its state in ${file}, so restore removes our entry instead of rolling the file back.)` }
    }
    const targets = spec.targets(this.#options.ctx, this.#options.launch)
    const backupPaths: string[] = []
    const restored: string[] = []
    for (const target of targets) {
      const record = this.#options.backups.latest(spec.id, target.file)
      if (record === undefined || !existsSync(record.backup)) continue
      if (existsSync(target.file)) backupPaths.push(backupFile(target.file, { agentId: spec.id, reason: 'restore', backups: this.#options.backups }))
      writeAtomically(target.file, readFileSync(record.backup, 'utf8'))
      restored.push(displayPath(this.#options.ctx, target.file))
    }
    const message =
      restored.length > 0
        ? `Restored ${restored.join(', ')} from the last backup (the replaced version was backed up too).`
        : 'No backup to restore: the connector created this configuration itself. Use Unlink to remove the entry.'
    return { agent: this.status(id), changed: restored.length > 0, message, backupPaths }
  }

  #hasExecutable(name: string): boolean {
    return findExecutable(name, this.#options.ctx.env, this.#options.ctx.platform) !== null
  }

  /** The Claude CLI is used on POSIX when present; on Windows `.cmd` shims need a shell, so we edit the file. */
  #usesClaudeCli(spec: AgentSpec): boolean {
    return spec.id === 'claude-code' && this.#options.ctx.platform !== 'win32' && this.#hasExecutable('claude')
  }

  #editAll(spec: AgentSpec, targets: readonly ConfigTarget[], action: 'connect' | 'unlink'): AgentActionResult {
    const backupPaths: string[] = []
    const touched: string[] = []
    const errors: string[] = []
    for (const target of targets) {
      try {
        const result = editJsonc(target.file, target.path, action === 'connect' ? target.entry : undefined, { agentId: spec.id, reason: action, backups: this.#options.backups })
        if (result.backupPath !== null) backupPaths.push(result.backupPath)
        if (result.changed) touched.push(displayPath(this.#options.ctx, target.file))
      } catch (error) {
        errors.push(error instanceof ConfigFileError ? error.message : `${displayPath(this.#options.ctx, target.file)}: ${(error as Error).message}`)
      }
    }
    const status = this.status(spec.id)
    const verb = action === 'connect' ? 'Connected' : 'Unlinked'
    const parts: string[] = []
    if (touched.length > 0) parts.push(`${verb} ${spec.name} (${touched.join(', ')}).`)
    else if (errors.length === 0) parts.push(action === 'connect' ? `${spec.name} was already connected.` : `${spec.name} was not connected.`)
    if (backupPaths.length > 0) parts.push(`Backup: ${backupPaths.map((path) => displayPath(this.#options.ctx, path)).join(', ')}.`)
    if (errors.length > 0) parts.push(`Not modified: ${errors.join(' ')}`)
    if (action === 'connect' && status.needsRestart && touched.length > 0) parts.push(`Restart ${spec.name} to load it.`)
    if (action === 'connect' && !status.connected) {
      throw new ConfigFileError(targets[0]?.file ?? '', parts.join(' ') || `Could not connect ${spec.name}.`)
    }
    return { agent: status, changed: touched.length > 0, message: parts.join(' '), backupPaths }
  }

  async #claudeCli(spec: AgentSpec, targets: readonly ConfigTarget[], action: 'connect' | 'unlink'): Promise<AgentActionResult> {
    const { ctx, logger } = this.#options
    const exe = findExecutable('claude', ctx.env, ctx.platform)
    const target = targets[0]
    if (exe === null || target === undefined) return this.#editAll(spec, targets, action)
    const backupPaths: string[] = []
    if (existsSync(target.file)) backupPaths.push(backupFile(target.file, { agentId: spec.id, reason: action, backups: this.#options.backups }))
    // The CLI gets exactly the environment the paths above were computed from (in the daemon, the
    // process environment). Merging in process.env would let a variable such as CLAUDE_CONFIG_DIR
    // send the CLI to a different file than the one backed up and verified.
    const env = { ...ctx.env } as NodeJS.ProcessEnv
    const remove = await this.#runner(exe, ['mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME], { env, timeoutMs: 30_000 })
    logger.debug('claude mcp remove', { code: remove.code })
    if (action === 'connect') {
      const add = await this.#runner(exe, ['mcp', 'add-json', '--scope', 'user', MCP_SERVER_NAME, JSON.stringify(target.entry)], { env, timeoutMs: 30_000 })
      if (add.code !== 0) {
        throw new ConfigFileError(target.file, `claude mcp add-json failed (exit ${String(add.code)}): ${(add.stderr || add.stdout).trim().slice(0, 500)}`)
      }
    }
    const status = this.status(spec.id)
    const ok = action === 'connect' ? status.connected : !status.connected
    if (!ok) throw new ConfigFileError(target.file, `Claude Code reported success but ${displayPath(ctx, target.file)} does not reflect it.`)
    const backups = backupPaths.length > 0 ? ` Backup: ${backupPaths.map((path) => displayPath(ctx, path)).join(', ')}.` : ''
    const message = action === 'connect' ? `Connected Claude Code with \`claude mcp add-json --scope user\`.${backups} Restart running sessions or type /mcp.` : `Unlinked Claude Code (\`claude mcp remove\`).${backups}`
    return { agent: status, changed: true, message, backupPaths }
  }
}
