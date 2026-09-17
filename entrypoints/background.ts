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
import { createDraftRepository } from '../src/storage/draft-repository';
import { buildDraftId } from '../src/models/draft';
import { setDraftTombstone, createTombstoneRepository } from '../src/storage/tombstone-registry';
import {
  isGlobalEnabled,
  setGlobalEnabled,
  isSiteDisabled,
  setSiteDisabled,
  getEffectiveState,
} from '../src/storage/site-settings';

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

  function broadcastToTabs(msg: unknown): void {
    try {
      browser.tabs
        .query({})
        .then((tabs) => {
          for (const tab of tabs) {
            if (tab.id) {
              browser.tabs.sendMessage(tab.id, msg).catch(() => {});
            }
          }
        })
        .catch(() => {});
    } catch {
      // ignore
    }
  }

  // 2. Runtime messaging router
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // ------------------------------------------------------------------------
    // Global & Site State Management Messages
    // ------------------------------------------------------------------------
    if (message?.type === 'SUBMITLOG_SET_GLOBAL_ENABLED') {
      const enabled = Boolean(message.payload?.enabled);
      setGlobalEnabled(enabled)
        .then(() => {
          broadcastToTabs({
            type: 'SUBMITLOG_GLOBAL_STATE_CHANGED',
            payload: { enabled },
          });
          sendResponse({ success: true, enabled });
        })
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    if (message?.type === 'SUBMITLOG_GET_GLOBAL_ENABLED') {
      isGlobalEnabled()
        .then((enabled) => sendResponse({ enabled }))
        .catch(() => sendResponse({ enabled: true }));
      return true;
    }

    if (message?.type === 'SUBMITLOG_SET_SITE_DISABLED') {
      const { hostname, disabled } = message.payload || {};
      setSiteDisabled(hostname, Boolean(disabled))
        .then(() => {
          broadcastToTabs({
            type: 'SUBMITLOG_SITE_STATE_CHANGED',
            payload: { hostname, disabled: Boolean(disabled) },
          });
          sendResponse({ success: true, hostname, disabled: Boolean(disabled) });
        })
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    if (message?.type === 'SUBMITLOG_IS_SITE_DISABLED') {
      const { hostname } = message.payload || {};
      isSiteDisabled(hostname)
        .then((disabled) => sendResponse({ disabled }))
        .catch(() => sendResponse({ disabled: false }));
      return true;
    }

    if (message?.type === 'SUBMITLOG_GET_EFFECTIVE_STATE') {
      const { hostname, pathname } = message.payload || {};
      getEffectiveState(hostname, pathname)
        .then((state) => sendResponse({ state }))
        .catch(() => sendResponse({ state: 'active' }));
      return true;
    }

    // ------------------------------------------------------------------------
    // Form Autosave Field
    // ------------------------------------------------------------------------
    if (message?.type === 'SUBMITLOG_AUTOSAVE_FIELD') {
      const isIncognito = Boolean(sender.tab?.incognito);
      if (isIncognito) {
        sendResponse({ status: 'private_browsing_blocked' });
        return true;
      }

      const hostname = message.payload?.hostname || '';
      const pathname = message.payload?.pathname || '';

      getEffectiveState(hostname, pathname)
        .then((state) => {
          if (state === 'global_paused') {
            sendResponse({ status: 'paused', paused: true });
            return;
          }
          if (state === 'site_disabled') {
            sendResponse({ status: 'site_disabled', siteDisabled: true });
            return;
          }
          if (state === 'excluded_context') {
            sendResponse({ status: 'excluded_context', excluded: true });
            return;
          }

          return handleAutosaveMessage(message.payload, undefined, isIncognito).then((result) => {
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
          });
        })
        .catch((err) => sendResponse({ status: 'error', error: String(err) }));
      return true;
    }

    // ------------------------------------------------------------------------
    // Draft Retrieval
    // ------------------------------------------------------------------------
    if (message?.type === 'SUBMITLOG_GET_DRAFT') {
      const isIncognito = Boolean(sender.tab?.incognito);
      if (isIncognito) {
        sendResponse({ draft: null });
        return true;
      }

      const { origin, pathname, formFingerprint, formFamilyKey } = message.payload || {};
      let host = '';
      try {
        host = origin ? new URL(origin).hostname : '';
      } catch {
        host = origin || '';
      }

      getEffectiveState(host, pathname)
        .then((state) => {
          if (state !== 'active') {
            sendResponse({ draft: null });
            return;
          }
          return handleGetDraft(origin, pathname, formFamilyKey || formFingerprint).then((draft) =>
            sendResponse({ draft }),
          );
        })
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
      broadcastToTabs({
        type: 'SUBMITLOG_DRAFT_DELETED',
        payload: { stableDraftId, origin, pathname },
      });

      sendResponse({ status: 'deleted' });
      return true;
    }

    // ------------------------------------------------------------------------
    // Assistant Handlers
    // ------------------------------------------------------------------------
    if (message?.type === 'SUBMITLOG_BOOTSTRAP_ASSISTANT') {
      const isIncognito = Boolean(sender.tab?.incognito);
      if (isIncognito) {
        sendResponse({ availableAnswers: {}, privateBrowsing: true });
        return true;
      }

      const hostname = message.payload?.hostname || '';
      getEffectiveState(hostname)
        .then((state) => {
          if (state === 'global_paused') {
            sendResponse({ availableAnswers: {}, paused: true });
            return;
          }
          if (state === 'site_disabled') {
            sendResponse({ availableAnswers: {}, siteDisabled: true });
            return;
          }
          if (state === 'excluded_context') {
            sendResponse({ availableAnswers: {}, excluded: true });
            return;
          }

          return handleBootstrapAssistant(message.payload, undefined, isIncognito).then((result) =>
            sendResponse(result),
          );
        })
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

      const hostname = message.payload?.hostname || '';
      getEffectiveState(hostname)
        .then((state) => {
          if (state === 'global_paused') {
            sendResponse({
              savedAnswer: '',
              hasOtherSavedAnswers: false,
              totalSavedAnswers: 0,
              paused: true,
            });
            return;
          }
          if (state === 'site_disabled') {
            sendResponse({
              savedAnswer: '',
              hasOtherSavedAnswers: false,
              totalSavedAnswers: 0,
              siteDisabled: true,
            });
            return;
          }
          if (state === 'excluded_context') {
            sendResponse({
              savedAnswer: '',
              hasOtherSavedAnswers: false,
              totalSavedAnswers: 0,
              excluded: true,
            });
            return;
          }

          return handleGetFieldStatus(message.payload, undefined, isIncognito).then((result) =>
            sendResponse(result),
          );
        })
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

      const hostname = message.payload?.hostname || '';
      getEffectiveState(hostname)
        .then((state) => {
          if (state !== 'active') {
            sendResponse({ status: state });
            return;
          }
          return handleSaveFieldFromAssistant(message.payload, undefined, isIncognito).then(
            (result) => sendResponse(result),
          );
        })
        .catch((err) => sendResponse({ status: 'error', error: String(err) }));
      return true;
    }

    if (message?.type === 'SUBMITLOG_OPEN_ARCHIVE') {
      const url = browser.runtime.getURL('/archive.html');
      browser.tabs.create({ url });
      sendResponse({ success: true });
      return true;
    }
  });
});
