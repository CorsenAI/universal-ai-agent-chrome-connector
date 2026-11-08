import '../zod-setup'
import { isRestrictedUrl } from '@corsen-ai/shared'
import { UI_PORT, UiRequestSchema } from '../messages'
import { Controller } from './controller'

/**
 * Service worker entry. Every listener is registered synchronously at the top level (MV3 rule:
 * listeners added later are not guaranteed to wake the worker). State is reloaded from
 * chrome.storage on each wake by the controller.
 */
const RECONNECT_ALARM = 'corsen-reconnect'
const controller = new Controller()

function ownPage(sender: chrome.runtime.MessageSender): boolean {
  // Only our own extension pages (popup, side panel — also when opened in a tab) may drive the
  // worker. Content scripts would carry the web page URL (and we ship none); web pages cannot
  // message us at all (no externally_connectable).
  return sender.id === chrome.runtime.id && (sender.url ?? '').startsWith(chrome.runtime.getURL(''))
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => undefined)
  void chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 })
  void controller.init()
})

chrome.runtime.onStartup.addListener(() => {
  void chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 })
  void controller.init()
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) void controller.link.ensureConnected()
})

chrome.tabs.onRemoved.addListener((tabId) => {
  void controller.forgetTab(tabId)
})

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url !== undefined && isRestrictedUrl(change.url) && controller.roleOf(tabId) !== 'ignored') {
    void controller.setRole(tabId, 'ignored').catch(() => undefined)
    return
  }
  if (change.title !== undefined || change.url !== undefined || change.status === 'complete') controller.schedulePush()
})

chrome.tabs.onActivated.addListener(() => controller.schedulePush(false))

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== UI_PORT || port.sender === undefined || !ownPage(port.sender)) {
    port.disconnect()
    return
  }
  controller.addPort(port)
})

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!ownPage(sender)) return false
  const parsed = UiRequestSchema.safeParse(message)
  if (!parsed.success) {
    sendResponse({ ok: false, error: { code: 'MALFORMED', message: parsed.error.issues[0]?.message ?? 'invalid request' } })
    return false
  }
  void controller.handleUi(parsed.data).then(sendResponse)
  return true
})

// Every wake (not only install/startup) reconnects and re-attaches what the roles say.
void controller.init()
