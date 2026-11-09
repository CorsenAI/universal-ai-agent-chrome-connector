/**
 * The command the user typed to run the CLI, so hints show something that works for them: the
 * repository's `pnpm connector` script (pnpm sets `npm_lifecycle_event` to the script name), or the
 * installed `universal-connector` command.
 */
export function cliName(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env['npm_lifecycle_event'] === 'connector' ? 'pnpm connector' : 'universal-connector'
}
