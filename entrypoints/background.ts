import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import {
  handleAutosaveMessage,
  handleGetDraft,
  handleClearDraft,
} from '../src/background/autosave-handler';
import {
  handleGetFieldStatus,
  handleSaveFieldFromAssistant,
  handleBootstrapAssistant,
} from '../src/background/assistant-handler';
import { scanPageForms, type InjectedScanResult } from '../src/capture/injected-capture';
import { computeFormFingerprint } from '../src/matching/form-fingerprint';
import { injectedArmAutosave } from '../src/capture/injected-autosave';
import { injectedRestoreDraft } from '../src/capture/injected-restore';
import { initFieldAssistant } from '../src/assistant/injected-assistant';
import { createSubmissionRepository } from '../src/storage/submission-repository';
import { createDraftRepository } from '../src/storage/draft-repository';
import { injectedFillForm, type SavedAnswerToFill } from '../src/capture/injected-fill';
import { normalizeDraftPathname } from '../src/models/draft';

export default defineBackground(() => {
  // 1. Startup: draft cleanup (30-day retention policy)
  try {
    createDraftRepository()
      .cleanupExpired()
      .catch(() => {});
  } catch {
    // DB initializes on demand
  }

  // 2. Runtime messaging router
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'SUBMITLOG_AUTOSAVE_FIELD') {
      const isIncognito = Boolean(sender.tab?.incognito);
      if (isIncognito) {
        sendResponse({ status: 'private_browsing_blocked' });
        return true;
      }

      handleAutosaveMessage(message.payload, undefined, isIncognito)
        .then((result) => {
          sendResponse(result);
          try {
            browser.runtime.sendMessage({
              type: 'SUBMITLOG_AUTOSAVE_NOTIFY',
              result,
            });
          } catch {
            // Popup might not be open
          }
        })
        .catch((err) => sendResponse({ status: 'error', error: String(err) }));
      return true;
    }

    if (message?.type === 'SUBMITLOG_GET_DRAFT') {
      const isIncognito = Boolean(sender.tab?.incognito);
      if (isIncognito) {
        sendResponse({ draft: null });
        return true;
      }

      const { origin, pathname, formFingerprint } = message.payload || {};
      handleGetDraft(origin, pathname, formFingerprint)
        .then((draft) => sendResponse({ draft }))
        .catch(() => sendResponse({ draft: null }));
      return true;
    }

    if (message?.type === 'SUBMITLOG_CLEAR_DRAFT') {
      const isIncognito = Boolean(sender.tab?.incognito);
      if (isIncognito) {
        sendResponse({ success: false });
        return true;
      }

      const { draftId } = message.payload || {};
      handleClearDraft(draftId)
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    if (message?.type === 'SUBMITLOG_BOOTSTRAP_ASSISTANT') {
      const isIncognito = Boolean(sender.tab?.incognito);
      if (isIncognito) {
        sendResponse({ availableAnswers: {}, privateBrowsing: true });
        return true;
      }

      handleBootstrapAssistant(message.payload, undefined, isIncognito)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ availableAnswers: {}, error: String(err) }));
      return true;
    }

    if (message?.type === 'SUBMITLOG_GET_FIELD_STATUS') {
      const isIncognito = Boolean(sender.tab?.incognito);
      if (isIncognito) {
        sendResponse({
          savedAnswer: '',
          hasOtherSavedAnswers: false,
          totalSavedAnswers: 0,
          privateBrowsing: true,
        });
        return true;
      }

      handleGetFieldStatus(message.payload, undefined, isIncognito)
        .then((result) => sendResponse(result))
        .catch((err) =>
          sendResponse({
            savedAnswer: '',
            hasOtherSavedAnswers: false,
            totalSavedAnswers: 0,
            error: String(err),
          }),
        );
      return true;
    }

    if (message?.type === 'SUBMITLOG_SAVE_FIELD') {
      const isIncognito = Boolean(sender.tab?.incognito);
      if (isIncognito) {
        sendResponse({ status: 'private_browsing_blocked' });
        return true;
      }

      handleSaveFieldFromAssistant(message.payload, undefined, isIncognito)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ status: 'error', error: String(err) }));
      return true;
    }

    if (message?.type === 'SUBMITLOG_OPEN_ARCHIVE') {
      const url = browser.runtime.getURL('/archive.html');
      browser.tabs.create({ url });
      sendResponse({ success: true });
      return true;
    }

    if (message?.type === 'SUBMITLOG_TRIGGER_FILL_ALL') {
      const isIncognito = Boolean(sender.tab?.incognito);
      if (isIncognito) {
        sendResponse({ success: false, reason: 'private_browsing_blocked' });
        return true;
      }

      const hostname = message.payload?.hostname;
      const tabId = sender.tab?.id;
      if (tabId && hostname) {
        const repo = createSubmissionRepository();
        repo
          .getAll()
          .then(async (subs) => {
            const match = subs.find((s) => s.hostname.toLowerCase() === hostname.toLowerCase());
            if (match) {
              const savedAnswers: SavedAnswerToFill[] = match.fields
                .filter((f) => !f.excluded && f.value.trim() !== '')
                .map((f) => ({
                  label: f.label,
                  value: f.value,
                  fieldType: f.fieldType,
                }));

              await browser.scripting.executeScript({
                target: { tabId },
                func: injectedFillForm,
                args: [{ savedAnswers }],
              });
              sendResponse({ success: true, count: savedAnswers.length });
            } else {
              sendResponse({ success: false, count: 0 });
            }
          })
          .catch((err) => sendResponse({ success: false, error: String(err) }));
        return true;
      }
    }
  });

  // 3. Tab reload and navigation listener: automatic autosave and reload restore on meaningful forms
  browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab?.url) {
      // Authoritative private / incognito browsing block
      if (tab.incognito) {
        return;
      }

      // Check scheme: only normal http and https pages
      if (!tab.url.startsWith('http://') && !tab.url.startsWith('https://')) {
        return;
      }

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(tab.url);
      } catch {
        return;
      }

      const origin = parsedUrl.origin.toLowerCase();
      const hostname = parsedUrl.hostname;
      const pathname = normalizeDraftPathname(tab.url);

      try {
        // Step 1: Scan page forms across all accessible frames
        const scanResults = await browser.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: scanPageForms,
        });

        let bestFrameId = 0;
        let bestScan: InjectedScanResult | null = null;

        if (scanResults && scanResults.length > 0) {
          for (const r of scanResults) {
            const res = r.result as InjectedScanResult | undefined;
            if (!res || !res.formDetected) continue;
            if (!bestScan || (res.score || 0) > (bestScan.score || 0)) {
              bestScan = res;
              bestFrameId = r.frameId ?? 0;
            }
          }
        }

        // Step 2: Form scoping guard - only arm when a meaningful form exists
        if (!bestScan || !bestScan.formDetected) {
          return;
        }

        const detectedFields = bestScan.detectedFields || [];
        const formFingerprint = computeFormFingerprint(hostname, detectedFields);

        // Step 3: Automatically arm autosave on the target frame
        await browser.scripting.executeScript({
          target: { tabId, frameIds: [bestFrameId] },
          func: injectedArmAutosave,
          args: [
            {
              editingSessionId: `auto-${Date.now()}`,
              origin,
              hostname,
              pathname,
              pageTitle: tab.title || hostname,
              pageUrl: tab.url,
              formFingerprint,
              initialFields: detectedFields,
            },
          ],
        });

        // Step 4: Automatic reload restore: check for latest matching draft and restore into empty fields
        try {
          const draftRepo = createDraftRepository();
          const matchingDraft = await draftRepo.getByForm(origin, pathname, formFingerprint);

          if (matchingDraft && Object.keys(matchingDraft.fields).length > 0) {
            await browser.scripting.executeScript({
              target: { tabId, frameIds: [bestFrameId] },
              func: injectedRestoreDraft,
              args: [
                {
                  draftFields: matchingDraft.fields,
                  showIndicator: true,
                },
              ],
            });
          }
        } catch {
          // Draft restore error fallback
        }

        // Step 5: Automatically bootstrap pencil assistant
        try {
          await browser.scripting.executeScript({
            target: { tabId, frameIds: [bestFrameId] },
            func: initFieldAssistant,
          });
        } catch {
          // Assistant fallback
        }
      } catch {
        // Tab may have closed or frame restricted
      }
    }
  });
});
