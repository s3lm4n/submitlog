import { defineContentScript } from 'wxt/utils/define-content-script';
import { scanPageForms, type InjectedScanResult } from '../src/capture/injected-capture';
import { computeFormFingerprint } from '../src/matching/form-fingerprint';
import { injectedArmAutosave } from '../src/capture/injected-autosave';
import { injectedRestoreDraft } from '../src/capture/injected-restore';
import { initFieldAssistant } from '../src/assistant/injected-assistant';
import { normalizeDraftPathname, type FormDraft } from '../src/models/draft';

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  runAt: 'document_idle',
  allFrames: true,
  main() {
    // 0. Authoritative private / incognito browsing block
    const gCheck = globalThis as unknown as {
      chrome?: { extension?: { inIncognitoContext?: boolean } };
      browser?: { extension?: { inIncognitoContext?: boolean } };
    };
    if (
      gCheck.chrome?.extension?.inIncognitoContext ||
      gCheck.browser?.extension?.inIncognitoContext
    ) {
      return;
    }

    let currentFingerprint = '';
    let isArmed = false;

    function safeSendMessage<T = unknown>(msg: unknown, callback?: (res: T) => void): void {
      try {
        const g = globalThis as unknown as {
          browser?: {
            runtime?: { sendMessage?: (m: unknown, c?: (r: unknown) => void) => Promise<unknown> };
          };
          chrome?: {
            runtime?: { sendMessage?: (m: unknown, c?: (r: unknown) => void) => void };
          };
        };
        const runtime = g.browser?.runtime || g.chrome?.runtime || null;
        if (!runtime || typeof runtime.sendMessage !== 'function') return;

        const promise: unknown = runtime.sendMessage(msg, (res) => {
          try {
            const _err = (runtime as unknown as { lastError?: unknown }).lastError;
          } catch {
            // ignore
          }
          if (callback) callback(res as T);
        });

        if (promise && typeof (promise as { catch?: unknown }).catch === 'function') {
          (promise as Promise<unknown>).catch(() => {});
        }
      } catch {
        // Extension context invalidated or reload in progress
      }
    }

    function initPageAutosaveAndAssistant() {
      if (!document.body) return;

      const url = window.location.href;
      if (!url.startsWith('http://') && !url.startsWith('https://')) return;

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        return;
      }

      const origin = parsedUrl.origin.toLowerCase();
      const hostname = parsedUrl.hostname;
      const pathname = normalizeDraftPathname(url);

      // Step 1: Scan page forms
      const scan: InjectedScanResult = scanPageForms();
      if (!scan || !scan.formDetected || !scan.detectedFields || scan.detectedFields.length === 0) {
        // No meaningful form detected (e.g. simple search bar)
        return;
      }

      const detectedFields = scan.detectedFields;
      const formFingerprint = computeFormFingerprint(hostname, detectedFields);
      const formFamilyKey = scan.formFamilyKey || '';

      // Avoid redundant re-arming if the form structure has not changed
      if (isArmed && formFingerprint === currentFingerprint) {
        return;
      }

      currentFingerprint = formFingerprint;
      isArmed = true;

      // Step 2: Arm autosave on the frame
      injectedArmAutosave({
        editingSessionId: `auto-${Date.now()}`,
        origin,
        hostname,
        pathname,
        pageTitle: document.title || hostname,
        pageUrl: url,
        formFingerprint,
        formFamilyKey,
        initialFields: detectedFields,
      });

      // Step 3: Retrieve active draft and restore into empty fields
      safeSendMessage<{ draft: FormDraft | null }>(
        {
          type: 'SUBMITLOG_GET_DRAFT',
          payload: { origin, pathname, formFingerprint, formFamilyKey },
        },
        (res) => {
          if (res?.draft && res.draft.fields && Object.keys(res.draft.fields).length > 0) {
            injectedRestoreDraft({
              draftFields: res.draft.fields,
              showIndicator: true,
            });
          }
        },
      );

      // Step 4: Bootstrap one-click pencil assistant
      initFieldAssistant();
    }

    // Run initial initialization
    initPageAutosaveAndAssistant();

    // Listen for draft deletion broadcast from background to prevent resurrection
    try {
      const g = globalThis as unknown as {
        browser?: {
          runtime?: { onMessage?: { addListener: (cb: (msg: unknown) => void) => void } };
        };
        chrome?: {
          runtime?: { onMessage?: { addListener: (cb: (msg: unknown) => void) => void } };
        };
      };
      const runtime = g.browser?.runtime || g.chrome?.runtime;
      if (runtime?.onMessage?.addListener) {
        runtime.onMessage.addListener((msg) => {
          const m = msg as { type?: string; payload?: { origin?: string; pathname?: string } };
          if (m?.type === 'SUBMITLOG_DRAFT_DELETED') {
            const { origin: delOrigin, pathname: delPath } = m.payload || {};
            const url = window.location.href;
            if (url.startsWith('http://') || url.startsWith('https://')) {
              try {
                const p = new URL(url);
                if (
                  p.origin.toLowerCase() === delOrigin?.toLowerCase() &&
                  (!delPath || delPath === normalizeDraftPathname(url))
                ) {
                  if (typeof window.__submitlog_autosave_on_delete === 'function') {
                    window.__submitlog_autosave_on_delete();
                  }
                }
              } catch {
                // ignore
              }
            }
          }
        });
      }
    } catch {
      // ignore
    }

    // Observe meaningful SPA DOM changes (with restrained 250ms debounce)
    let observerTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new MutationObserver(() => {
      if (observerTimer) clearTimeout(observerTimer);
      observerTimer = setTimeout(() => {
        initPageAutosaveAndAssistant();
      }, 250);
    });

    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }

    // SPA navigation listener (popstate)
    window.addEventListener('popstate', () => {
      setTimeout(initPageAutosaveAndAssistant, 150);
    });
  },
});
