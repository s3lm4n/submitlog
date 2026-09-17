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
import { createSubmissionRepository } from '../src/storage/submission-repository';
import { createDraftRepository } from '../src/storage/draft-repository';
import { buildDraftId } from '../src/models/draft';
import { setDraftTombstone, createTombstoneRepository } from '../src/storage/tombstone-registry';
import { injectedFillForm, type SavedAnswerToFill } from '../src/capture/injected-fill';

export default defineBackground(() => {
  // 1. Startup: draft cleanup (30-day retention policy), duplicate migration & tombstone cleanup
  try {
    const draftRepo = createDraftRepository();
    draftRepo.cleanupExpired().catch(() => {});
    draftRepo.consolidateDuplicates?.().catch(() => {});

    const tombstoneRepo = createTombstoneRepository();
    tombstoneRepo.cleanupExpired().catch(() => {});
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
            browser.runtime
              .sendMessage({
                type: 'SUBMITLOG_AUTOSAVE_NOTIFY',
                result,
              })
              .catch(() => {
                // Popup might not be open - ignore quietly
              });
          } catch {
            // Popup not open
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

      const { origin, pathname, formFingerprint, formFamilyKey } = message.payload || {};
      handleGetDraft(origin, pathname, formFamilyKey || formFingerprint)
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

    if (message?.type === 'SUBMITLOG_DELETE_DRAFT') {
      const { id, origin, pathname, formFamilyKey } = message.payload || {};
      const stableDraftId =
        id || (origin && pathname ? buildDraftId(origin, pathname, formFamilyKey) : '');

      if (stableDraftId) {
        setDraftTombstone(stableDraftId, Date.now()).catch(() => {});
      }

      const draftRepo = createDraftRepository();
      if (id) {
        draftRepo.delete(id).catch(() => {});
      }
      if (stableDraftId && stableDraftId !== id) {
        draftRepo.delete(stableDraftId).catch(() => {});
      }

      // Broadcast to active tabs to cancel pending flushes and mark draft as deleted
      try {
        browser.tabs
          .query({})
          .then((tabs) => {
            for (const tab of tabs) {
              if (tab.id) {
                browser.tabs
                  .sendMessage(tab.id, {
                    type: 'SUBMITLOG_DRAFT_DELETED',
                    payload: { stableDraftId, origin, pathname },
                  })
                  .catch(() => {});
              }
            }
          })
          .catch(() => {});
      } catch {
        // ignore
      }

      sendResponse({ status: 'deleted' });
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
});
