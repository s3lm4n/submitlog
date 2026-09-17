import { defineContentScript } from 'wxt/utils/define-content-script';
import { scanPageForms, type InjectedScanResult } from '../src/capture/injected-capture';
import { computeFormFingerprint } from '../src/matching/form-fingerprint';
import { injectedArmAutosave, injectedDisarmAutosave } from '../src/capture/injected-autosave';
import { initFieldAssistant, disarmFieldAssistant } from '../src/assistant/injected-assistant';
import { normalizeDraftPathname } from '../src/models/draft';
import { getEffectiveState, normalizeHostname } from '../src/storage/site-settings';

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
    let observer: MutationObserver | null = null;
    let observerTimer: ReturnType<typeof setTimeout> | null = null;

    function stopAllPageActivity() {
      if (observer) {
        observer.disconnect();
      }
      if (observerTimer) {
        clearTimeout(observerTimer);
        observerTimer = null;
      }
      injectedDisarmAutosave(false); // Disarm without flushing pending keystrokes
      disarmFieldAssistant();
      currentFingerprint = '';
      isArmed = false;
    }

    function setupObserver() {
      if (!document.body || observer) return;
      observer = new MutationObserver(() => {
        if (observerTimer) clearTimeout(observerTimer);
        observerTimer = setTimeout(() => {
          checkAndInitPage();
        }, 250);
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }

    async function checkAndInitPage() {
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

      // Precedence check: global pause, user site disable, built-in exclusion
      const effectiveState = await getEffectiveState(hostname, pathname);
      if (effectiveState !== 'active') {
        stopAllPageActivity();
        return;
      }

      // Step 1: Scan page forms structurally
      const scan: InjectedScanResult = scanPageForms();
      if (!scan || !scan.formDetected || !scan.detectedFields || scan.detectedFields.length === 0) {
        // No meaningful form detected (e.g. search engine, utility UI, empty page)
        if (isArmed) {
          injectedDisarmAutosave(false);
          disarmFieldAssistant();
          currentFingerprint = '';
          isArmed = false;
        }
        setupObserver();
        return;
      }

      const detectedFields = scan.detectedFields;
      const formFingerprint = computeFormFingerprint(hostname, detectedFields);
      const formFamilyKey = scan.formFamilyKey || '';

      // Avoid redundant re-arming if the form structure has not changed
      if (isArmed && formFingerprint === currentFingerprint) {
        setupObserver();
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

      // Step 3: Bootstrap one-click pencil assistant (user-initiated restore only)
      initFieldAssistant();

      setupObserver();
    }

    // Run initial initialization
    checkAndInitPage();

    // Runtime message listener for state changes and deletions
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
          const m = msg as {
            type?: string;
            payload?: {
              enabled?: boolean;
              hostname?: string;
              disabled?: boolean;
              origin?: string;
              pathname?: string;
            };
          };

          // 1. Global pause broadcast
          if (m?.type === 'SUBMITLOG_GLOBAL_STATE_CHANGED') {
            const enabled = Boolean(m.payload?.enabled);
            if (!enabled) {
              stopAllPageActivity();
            } else {
              checkAndInitPage();
            }
            return;
          }

          // 2. Site disable broadcast
          if (m?.type === 'SUBMITLOG_SITE_STATE_CHANGED') {
            const { hostname: changedHost, disabled } = m.payload || {};
            if (
              normalizeHostname(changedHost || '') === normalizeHostname(window.location.hostname)
            ) {
              if (disabled) {
                stopAllPageActivity();
              } else {
                checkAndInitPage();
              }
            }
            return;
          }

          // 3. Draft deleted broadcast
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

    // SPA navigation listener (popstate)
    window.addEventListener('popstate', () => {
      setTimeout(checkAndInitPage, 150);
    });
  },
});
