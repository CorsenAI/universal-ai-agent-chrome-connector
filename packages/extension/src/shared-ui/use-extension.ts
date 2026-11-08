import { useCallback, useEffect, useState } from 'react'
import { UI_PORT, type UiRequest, type UiResponse, type UiState } from '../messages'

/** Send one request to the service worker. */
export async function send<T = unknown>(request: UiRequest): Promise<UiResponse<T>> {
  try {
    const response = (await chrome.runtime.sendMessage(request)) as UiResponse<T> | undefined
    return response ?? { ok: false, error: { code: 'INTERNAL', message: 'no answer from the service worker' } }
  } catch (error) {
    return { ok: false, error: { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) } }
  }
}

/** Live UI state pushed by the service worker over a long-lived port (reconnects if the worker restarts). */
export function useExtensionState(): { state: UiState | null; refresh: () => void } {
  const [state, setState] = useState<UiState | null>(null)

  const refresh = useCallback(() => {
    void send<UiState>({ type: 'getState' }).then((response) => {
      if (response.ok) setState(response.result)
    })
  }, [])

  useEffect(() => {
    let port: chrome.runtime.Port | null = null
    let closed = false
    let retry: ReturnType<typeof setTimeout> | null = null
    const connect = (): void => {
      port = chrome.runtime.connect({ name: UI_PORT })
      port.onMessage.addListener((message: { type?: string; state?: UiState }) => {
        if (message.type === 'state' && message.state !== undefined) setState(message.state)
      })
      port.onDisconnect.addListener(() => {
        if (!closed) retry = setTimeout(connect, 500)
      })
    }
    connect()
    refresh()
    return () => {
      closed = true
      if (retry !== null) clearTimeout(retry)
      port?.disconnect()
    }
  }, [refresh])

  return { state, refresh }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
