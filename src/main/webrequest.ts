import type { BeforeSendResponse, CallbackResponse, HeadersReceivedResponse, OnBeforeRequestListenerDetails, OnBeforeSendHeadersListenerDetails, OnHeadersReceivedListenerDetails, Session } from 'electron';

/**
 * Electron allows one listener per webRequest event per session; the last registration wins.
 * Shields (Ghostery), the Google identity and the privacy hooks all want a say, so this hub
 * owns the registrations and runs every hook in turn. Hooks are app-wide; install() wires a
 * session. Call install() again after anything else touched the session's listeners.
 */

type Maybe<T> = T | undefined | Promise<T | undefined>;
export type BeforeRequestHook = (d: OnBeforeRequestListenerDetails) => Maybe<CallbackResponse>;
export type BeforeSendHeadersHook = (d: OnBeforeSendHeadersListenerDetails, headers: Record<string, string>) => void;
export type HeadersReceivedHook = (d: OnHeadersReceivedListenerDetails, headers: Record<string, string[]>) => Maybe<HeadersReceivedResponse | void>;

const beforeRequest: BeforeRequestHook[] = [];
const beforeSendHeaders: BeforeSendHeadersHook[] = [];
const headersReceived: HeadersReceivedHook[] = [];

export function onBeforeRequest(hook: BeforeRequestHook): void {
  beforeRequest.push(hook);
}
export function onBeforeSendHeaders(hook: BeforeSendHeadersHook): void {
  beforeSendHeaders.push(hook);
}
export function onHeadersReceived(hook: HeadersReceivedHook): void {
  headersReceived.push(hook);
}

export function installHub(ses: Session): void {
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    void (async () => {
      for (const hook of beforeRequest) {
        try {
          const r = await hook(details);
          if (r && (r.cancel || r.redirectURL)) return callback(r);
        } catch (err) {
          console.warn('webRequest hook failed', err);
        }
      }
      callback({});
    })();
  });
  ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
    const headers: Record<string, string> = { ...details.requestHeaders };
    for (const hook of beforeSendHeaders) {
      try {
        hook(details, headers);
      } catch (err) {
        console.warn('webRequest hook failed', err);
      }
    }
    const res: BeforeSendResponse = { requestHeaders: headers };
    callback(res);
  });
  ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
    void (async () => {
      let headers: Record<string, string[]> = { ...(details.responseHeaders ?? {}) };
      for (const hook of headersReceived) {
        try {
          const r = await hook(details, headers);
          if (r?.responseHeaders) headers = r.responseHeaders as Record<string, string[]>;
          if (r?.cancel) return callback({ cancel: true });
        } catch (err) {
          console.warn('webRequest hook failed', err);
        }
      }
      callback({ responseHeaders: headers });
    })();
  });
}

/** The header with this name, whatever its case. */
export function headerKey(headers: Record<string, unknown>, name: string): string | undefined {
  const lower = name.toLowerCase();
  return Object.keys(headers).find((k) => k.toLowerCase() === lower);
}
