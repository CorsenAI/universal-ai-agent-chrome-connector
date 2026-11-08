import { ConnectorError, LIMITS, type ExtensionParams, type ExtensionResult } from '@corsen-ai/shared'
import type { DebuggerManager } from '../cdp/debugger-manager'

const MAX_FULL_PAGE_HEIGHT = 16_384

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ConnectorError('TIMEOUT', 'Chrome did not paint the tab in time')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** `page.screenshot` via `Page.captureScreenshot` (WebP/PNG/JPEG, viewport or full page). */
export async function screenshot(manager: DebuggerManager, params: ExtensionParams<'page.screenshot'>): Promise<ExtensionResult<'page.screenshot'>> {
  const { tabId } = params
  const metrics = await manager.send(tabId, 'Page.getLayoutMetrics')
  const viewport = metrics.cssVisualViewport
  const content = metrics.cssContentSize
  const width = Math.ceil(params.fullPage ? content.width : viewport.clientWidth)
  const height = Math.ceil(params.fullPage ? Math.min(content.height, MAX_FULL_PAGE_HEIGHT) : viewport.clientHeight)

  const capture = async (format: 'webp' | 'png' | 'jpeg', quality: number): Promise<string> => {
    const response = await withTimeout(
      manager.send(tabId, 'Page.captureScreenshot', {
        format,
        ...(format !== 'png' ? { quality } : {}),
        ...(params.fullPage ? { captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } } : {}),
      }),
      10_000,
    )
    return response.data
  }

  let format = params.format
  let data: string
  try {
    data = await capture(format, params.quality)
  } catch (error) {
    if (!(error instanceof ConnectorError) || error.code !== 'TIMEOUT') throw error
    if (!params.bringToFront) throw new ConnectorError('ACTION_FAILED', 'Chrome does not paint this background tab; call again with bring_to_front: true (this activates the tab).')
    const tab = await chrome.tabs.update(tabId, { active: true })
    if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 300))
    data = await capture(format, params.quality)
  }
  if (data.length > LIMITS.MAX_SCREENSHOT_BASE64_CHARS && format !== 'jpeg') {
    format = 'jpeg'
    data = await capture('jpeg', 60)
  }
  if (data.length > LIMITS.MAX_SCREENSHOT_BASE64_CHARS) throw new ConnectorError('TOO_LARGE', 'the screenshot is too large; use the viewport instead of full_page')
  return { mimeType: `image/${format}`, data, width, height }
}
