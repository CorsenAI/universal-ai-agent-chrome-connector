import { spawn } from 'node:child_process'

/** Open a URL in the default browser without a shell (the URL is never re-parsed by one). */
export function openUrl(url: string): void {
  if (!/^https?:\/\//.test(url)) return
  const [command, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => undefined)
    child.unref()
  } catch {
    // no opener available: the URL is printed anyway
  }
}
