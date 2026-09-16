import { useState, useEffect, useMemo, useCallback } from 'react';
import { browser } from 'wxt/browser';
import type { CapturedField, Submission, SubmissionRevision } from '../../src/models/submission';
import { SCHEMA_VERSION } from '../../src/models/submission';
import { generateId } from '../../src/utils/id';
import { createSubmissionRepository } from '../../src/storage/submission-repository';
import { createDraftRepository } from '../../src/storage/draft-repository';
import { normalizeDraftPathname } from '../../src/models/draft';
import {
  scanPageForms,
  capturePageForms,
  type InjectedScanResult,
  type InjectedCaptureResult,
  type InjectedDetectedField,
} from '../../src/capture/injected-capture';
import {
  injectedFillForm,
  type FillResult,
  type SavedAnswerToFill,
} from '../../src/capture/injected-fill';
import {
  mergeSubmissions,
  type MergePreview,
  type FieldDiff,
} from '../../src/matching/form-merger';
import { computeFormFingerprint } from '../../src/matching/form-fingerprint';
import {
  checkPrivateBrowsing,
  PRIVATE_BROWSING_MESSAGE,
} from '../../src/security/private-browsing-guard';
import { checkPageSupported, RESTRICTED_PAGE_MESSAGE } from '../../src/security/page-guard';
import './popup.css';

type PopupState =
  | 'idle'
  | 'loading'
  | 'preview'
  | 'merge-preview'
  | 'saved'
  | 'error'
  | 'private-blocked'
  | 'restricted';

export function Popup() {
  const [state, setState] = useState<PopupState>('loading');
  const [hostname, setHostname] = useState('');
  const [pageTitle, setPageTitle] = useState('');
  const [pageUrl, setPageUrl] = useState('');
  const [formDetected, setFormDetected] = useState(false);
  const [totalFields, setTotalFields] = useState(0);
  const [answeredCount, setAnsweredCount] = useState(0);
  const [targetFrameId, setTargetFrameId] = useState(0);
  const [inaccessibleFrame, setInaccessibleFrame] = useState(false);
  const [currentDetectedFields, setCurrentDetectedFields] = useState<InjectedDetectedField[]>([]);

  // Saved match
  const [matchingSubmission, setMatchingSubmission] = useState<Submission | null>(null);
  const [fillFeedback, setFillFeedback] = useState<FillResult | null>(null);

  // Passive draft indication
  const [hasActiveDraft, setHasActiveDraft] = useState(false);

  // Capture & Merge
  const [capturedFields, setCapturedFields] = useState<CapturedField[]>([]);
  const [selectedFields, setSelectedFields] = useState<Set<string>>(new Set());
  const [excludedCount, setExcludedCount] = useState(0);
  const [mergePreview, setMergePreview] = useState<MergePreview | null>(null);
  const [savedSuccessMessage, setSavedSuccessMessage] = useState(
    'Your form data has been added to the archive.',
  );
  const [error, setError] = useState('');

  const repo = useMemo(() => createSubmissionRepository(), []);
  const draftRepo = useMemo(() => createDraftRepository(), []);

  const scanCurrentTab = useCallback(async () => {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !tab.url) {
        setState('restricted');
        return;
      }

      // 1. Private / Incognito browsing safety check
      const privateCheck = checkPrivateBrowsing(tab);
      if (privateCheck.isPrivate) {
        setPageTitle('');
        setPageUrl('');
        setHostname('');
        setFormDetected(false);
        setTotalFields(0);
        setAnsweredCount(0);
        setHasActiveDraft(false);
        setState('private-blocked');
        return;
      }

      // 2. Restricted browser internal page check
      const pageSupport = checkPageSupported(tab.url);
      if (!pageSupport.isSupported) {
        setState('restricted');
        return;
      }

      const url = new URL(tab.url);
      const origin = url.origin.toLowerCase();
      const normPath = normalizeDraftPathname(tab.url);

      setHostname(url.hostname);
      setPageTitle(tab.title || url.hostname);
      setPageUrl(tab.url);

      // Scan all accessible frames within the tab
      const results = await browser.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: scanPageForms,
      });

      let bestFrameId = 0;
      let bestScan: InjectedScanResult | null = null;
      let anyInaccessible = false;

      if (results && results.length > 0) {
        for (const r of results) {
          const res = r.result as InjectedScanResult | undefined;
          if (!res) continue;
          if (res.inaccessibleFrameDetected) anyInaccessible = true;
          if (res.formDetected) {
            if (!bestScan || (res.score || 0) > (bestScan.score || 0)) {
              bestScan = res;
              bestFrameId = r.frameId ?? 0;
            }
          }
        }
      }

      setTargetFrameId(bestFrameId);

      if (bestScan && bestScan.formDetected) {
        setFormDetected(true);
        setTotalFields(bestScan.totalFields);
        setAnsweredCount(bestScan.answeredCount);
        setInaccessibleFrame(false);
        const detected = bestScan.detectedFields || [];
        setCurrentDetectedFields(detected);

        // Query IndexedDB for matching saved submission in Archive
        try {
          const match = await repo.findMatching(url.hostname, detected);
          setMatchingSubmission(match || null);
        } catch {
          setMatchingSubmission(null);
        }

        // Query active local draft for passive status indicator
        try {
          const fp = computeFormFingerprint(url.hostname, detected);
          const draft = await draftRepo.getByForm(origin, normPath, fp);
          setHasActiveDraft(Boolean(draft && Object.keys(draft.fields).length > 0));
        } catch {
          setHasActiveDraft(false);
        }
      } else {
        setFormDetected(false);
        setTotalFields(0);
        setAnsweredCount(0);
        setInaccessibleFrame(anyInaccessible);
        setCurrentDetectedFields([]);
        setMatchingSubmission(null);
        setHasActiveDraft(false);
      }

      setState('idle');
    } catch {
      setState('restricted');
    }
  }, [repo, draftRepo]);

  useEffect(() => {
    scanCurrentTab();
  }, [scanCurrentTab]);

  useEffect(() => {
    const handleNotify = (msg: unknown) => {
      const message = msg as { type?: string; result?: { status?: string } };
      if (message?.type === 'SUBMITLOG_AUTOSAVE_NOTIFY') {
        if (message.result?.status === 'saved') {
          setHasActiveDraft(true);
          scanCurrentTab();
        }
      }
    };
    browser.runtime.onMessage.addListener(handleNotify);
    return () => {
      browser.runtime.onMessage.removeListener(handleNotify);
    };
  }, [scanCurrentTab]);

  async function handleFill() {
    if (!matchingSubmission) return;
    setState('loading');

    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        setState('idle');
        return;
      }

      const savedAnswers: SavedAnswerToFill[] = matchingSubmission.fields
        .filter((f) => !f.excluded && f.value.trim() !== '')
        .map((f) => ({
          label: f.label,
          value: f.value,
          fieldType: f.fieldType,
        }));

      const results = await browser.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [targetFrameId] },
        func: injectedFillForm,
        args: [{ savedAnswers }],
      });

      const fillRes = results?.[0]?.result as FillResult | undefined;
      if (fillRes) {
        setFillFeedback(fillRes);
      }

      // Re-scan tab to reflect newly filled fields
      await scanCurrentTab();
    } catch {
      setState('idle');
    }
  }

  async function handleCapture() {
    setState('loading');
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !tab.url) {
        setState('restricted');
        return;
      }

      const privateCheck = checkPrivateBrowsing(tab);
      if (privateCheck.isPrivate) {
        setState('private-blocked');
        return;
      }

      const pageSupport = checkPageSupported(tab.url);
      if (!pageSupport.isSupported) {
        setState('restricted');
        return;
      }

      const results = await browser.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [targetFrameId] },
        func: capturePageForms,
      });

      const captureResult = results?.[0]?.result as InjectedCaptureResult | undefined;
      if (!captureResult || !captureResult.fields) {
        setState('restricted');
        return;
      }

      const fields = captureResult.fields as unknown as CapturedField[];
      setCapturedFields(fields);
      setExcludedCount(captureResult.excludedCount);

      // If a matching saved submission exists in Archive, show Merge Preview
      if (matchingSubmission) {
        const preview = mergeSubmissions(matchingSubmission, fields);
        setMergePreview(preview);
        setState('merge-preview');
      } else {
        // Pre-select all non-excluded fields for direct save
        const selected = new Set<string>();
        fields.forEach((f: CapturedField) => {
          if (!f.excluded) selected.add(f.id);
        });
        setSelectedFields(selected);
        setState('preview');
      }
    } catch {
      setState('restricted');
    }
  }

  async function handleUpdateSaved() {
    if (!matchingSubmission || !mergePreview) return;

    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (checkPrivateBrowsing(tab).isPrivate) {
        setState('private-blocked');
        return;
      }
    } catch {
      // Ignore query error, proceed
    }

    const revision: SubmissionRevision = {
      id: generateId(),
      createdAt: new Date().toISOString(),
      fields: mergePreview.mergedFields,
      changeNote: `Updated (${mergePreview.changedCount} changed, ${mergePreview.newCount} new)`,
    };

    const updatedSubmission: Submission = {
      ...matchingSubmission,
      updatedAt: new Date().toISOString(),
      fields: mergePreview.mergedFields,
      revisions: [revision, ...(matchingSubmission.revisions || [])],
      schemaVersion: SCHEMA_VERSION,
    };

    try {
      await repo.save(updatedSubmission);
      setSavedSuccessMessage('Submission updated successfully.');
      setState('saved');
    } catch {
      setState('error');
      setError('Failed to update submission locally.');
    }
  }

  async function handleSaveAsNew() {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (checkPrivateBrowsing(tab).isPrivate) {
        setState('private-blocked');
        return;
      }
    } catch {
      // Ignore query error, proceed
    }

    const fieldsToSave = capturedFields.filter((f) => !f.excluded && f.value.trim() !== '');
    const fingerprint = computeFormFingerprint(hostname, currentDetectedFields);

    const submission: Submission = {
      id: generateId(),
      schemaVersion: SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pageTitle,
      pageUrl,
      hostname,
      submissionTitle: `${pageTitle} - ${new Date().toLocaleDateString()}`,
      fields: fieldsToSave,
      captureVersion: '0.1.0',
      formFingerprint: fingerprint,
      revisions: [
        {
          id: generateId(),
          createdAt: new Date().toISOString(),
          fields: fieldsToSave,
          changeNote: 'Initial capture',
        },
      ],
    };

    try {
      await repo.save(submission);
      setSavedSuccessMessage('Saved as a new submission.');
      setState('saved');
    } catch {
      setState('error');
      setError('Failed to save submission locally.');
    }
  }

  async function handleDirectSave() {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (checkPrivateBrowsing(tab).isPrivate) {
        setState('private-blocked');
        return;
      }
    } catch {
      // Ignore query error, proceed
    }

    const fieldsToSave = capturedFields.map((f) => ({
      ...f,
      excluded: f.excluded || !selectedFields.has(f.id),
      value: f.excluded || !selectedFields.has(f.id) ? '' : f.value,
    }));

    const nonExcluded = fieldsToSave.filter((f) => !f.excluded && f.value.trim() !== '');
    const fingerprint = computeFormFingerprint(hostname, currentDetectedFields);

    const submission: Submission = {
      id: generateId(),
      schemaVersion: SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pageTitle,
      pageUrl,
      hostname,
      submissionTitle: `${pageTitle} - ${new Date().toLocaleDateString()}`,
      fields: nonExcluded,
      captureVersion: '0.1.0',
      formFingerprint: fingerprint,
      revisions: [
        {
          id: generateId(),
          createdAt: new Date().toISOString(),
          fields: nonExcluded,
          changeNote: 'Initial capture',
        },
      ],
    };

    try {
      await repo.save(submission);
      setSavedSuccessMessage('Your form data has been added to the archive.');
      setState('saved');
    } catch {
      setState('error');
      setError('Failed to save submission locally.');
    }
  }

  function toggleField(id: string) {
    setSelectedFields((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function openArchive() {
    const url = browser.runtime.getURL('/archive.html');
    browser.tabs.create({ url });
  }

  if (state === 'loading') {
    return (
      <div className="popup-container loading-state">
        <div className="spinner"></div>
        <p>Scanning page...</p>
      </div>
    );
  }

  if (state === 'private-blocked') {
    return (
      <div className="popup-container">
        <div className="header">
          <h1>SubmitLog</h1>
          <button className="link-btn" onClick={openArchive}>
            Archive
          </button>
        </div>
        <div className="status-card message-card">
          <p className="guard-message">{PRIVATE_BROWSING_MESSAGE}</p>
        </div>
        <div className="actions main-actions">
          <button onClick={() => window.close()} className="btn btn-secondary">
            Close
          </button>
        </div>
        <div className="privacy-note">Stored locally. Nothing is uploaded.</div>
      </div>
    );
  }

  if (state === 'restricted') {
    return (
      <div className="popup-container">
        <div className="header">
          <h1>SubmitLog</h1>
          <button className="link-btn" onClick={openArchive}>
            Archive
          </button>
        </div>
        <div className="status-card message-card">
          <p className="guard-message">{RESTRICTED_PAGE_MESSAGE}</p>
        </div>
        <div className="actions main-actions">
          <button onClick={() => window.close()} className="btn btn-secondary">
            Close
          </button>
        </div>
        <div className="privacy-note">Stored locally. Nothing is uploaded.</div>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="popup-container error-state">
        <h2>Notice</h2>
        <p>{error}</p>
        <div className="actions">
          <button onClick={() => window.close()} className="btn btn-secondary">
            Close
          </button>
          <button onClick={openArchive} className="btn btn-primary">
            Archive
          </button>
        </div>
        <div className="privacy-note">Stored locally. Nothing is uploaded.</div>
      </div>
    );
  }

  if (state === 'saved') {
    return (
      <div className="popup-container saved-state">
        <div className="success-icon">✓</div>
        <h2>Saved Successfully</h2>
        <p>{savedSuccessMessage}</p>
        <div className="actions">
          <button onClick={openArchive} className="btn btn-primary">
            Open Archive
          </button>
          <button onClick={() => window.close()} className="btn btn-secondary">
            Close
          </button>
        </div>
        <div className="privacy-note">Stored locally. Nothing is uploaded.</div>
      </div>
    );
  }

  if (state === 'merge-preview' && mergePreview) {
    const significantDiffs = mergePreview.diffs.filter(
      (d) => d.status === 'changed' || d.status === 'newly_added',
    );

    return (
      <div className="popup-container preview-state">
        <div className="header">
          <h2>Update Saved Submission</h2>
          <div className="site-info">{hostname}</div>
        </div>

        <div className="merge-summary-card">
          <div className="diff-badges">
            {mergePreview.changedCount > 0 && (
              <span className="diff-badge badge-changed">{mergePreview.changedCount} changed</span>
            )}
            {mergePreview.newCount > 0 && (
              <span className="diff-badge badge-new">{mergePreview.newCount} new</span>
            )}
            {mergePreview.unchangedCount > 0 && (
              <span className="diff-badge badge-unchanged">
                {mergePreview.unchangedCount} unchanged
              </span>
            )}
            {mergePreview.blankPreservedCount > 0 && (
              <span className="diff-badge badge-preserved">
                {mergePreview.blankPreservedCount} blank preserved
              </span>
            )}
          </div>
          <p className="merge-note">
            Blank current fields preserve previously saved answers non-destructively.
          </p>
        </div>

        <div className="field-list">
          {significantDiffs.length === 0 ? (
            <div className="no-fields-msg">All answered fields match your saved submission.</div>
          ) : (
            significantDiffs.map((d: FieldDiff) => (
              <div key={d.id} className="field-item diff-item">
                <div className="field-content">
                  <div className="diff-header">
                    <span className="field-label">{d.label}</span>
                    <span className={`status-tag tag-${d.status}`}>
                      {d.status === 'changed' ? 'Changed' : 'New'}
                    </span>
                  </div>
                  {d.status === 'changed' && (
                    <div className="old-val">
                      <span className="val-label">Old:</span> {d.oldValue}
                    </div>
                  )}
                  <div className="new-val">
                    <span className="val-label">{d.status === 'changed' ? 'New:' : 'Value:'}</span>{' '}
                    {d.newValue}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="actions sticky-actions merge-actions">
          <button onClick={handleUpdateSaved} className="btn btn-primary">
            Update saved submission
          </button>
          <div className="action-row">
            <button onClick={handleSaveAsNew} className="btn btn-secondary">
              Save as new
            </button>
            <button onClick={() => setState('idle')} className="btn btn-secondary">
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (state === 'preview') {
    const includedFields = capturedFields.filter((f) => !f.excluded);

    return (
      <div className="popup-container preview-state">
        <div className="header">
          <h2>Preview Data</h2>
          <div className="site-info">{hostname}</div>
        </div>

        <div className="field-list">
          {includedFields.length === 0 ? (
            <div className="no-fields">No valid fields to capture.</div>
          ) : (
            includedFields.map((f) => (
              <div key={f.id} className="field-item">
                <input
                  type="checkbox"
                  id={f.id}
                  checked={selectedFields.has(f.id)}
                  onChange={() => toggleField(f.id)}
                />
                <div className="field-content">
                  <label htmlFor={f.id} className="field-label">
                    {f.label}
                  </label>
                  <div className="field-value">
                    {f.value || <span className="empty-val">(empty)</span>}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {excludedCount > 0 && (
          <div className="excluded-info">
            {excludedCount} sensitive {excludedCount === 1 ? 'field' : 'fields'} ignored.
          </div>
        )}

        <div className="actions sticky-actions">
          <button onClick={() => setState('idle')} className="btn btn-secondary">
            Back
          </button>
          <button
            onClick={handleDirectSave}
            className="btn btn-primary"
            disabled={selectedFields.size === 0}
          >
            Save ({selectedFields.size})
          </button>
        </div>
      </div>
    );
  }

  // Idle state
  return (
    <div className="popup-container idle-state">
      <div className="header">
        <h1>SubmitLog</h1>
        <button className="link-btn" onClick={openArchive}>
          Archive
        </button>
      </div>

      {fillFeedback && (
        <div className="fill-result-banner">
          {fillFeedback.filledCount > 0 ? (
            <p className="fill-summary-text">
              ✓ Filled {fillFeedback.filledCount}{' '}
              {fillFeedback.filledCount === 1 ? 'field' : 'fields'}
              {fillFeedback.unmatchedSavedCount > 0 &&
                ` · ${fillFeedback.unmatchedSavedCount} saved answers had no matching field`}
              {fillFeedback.sensitiveSkippedCount > 0 &&
                ` · ${fillFeedback.sensitiveSkippedCount} sensitive field skipped`}
            </p>
          ) : (
            <p className="fill-summary-text">No matching fields found to fill.</p>
          )}
        </div>
      )}

      {!formDetected ? (
        <>
          <div className="status-card message-card">
            <div className="site-info">{hostname}</div>
            <p className="guard-message">
              {inaccessibleFrame
                ? 'SubmitLog found an embedded form it cannot access with the current permission model.'
                : 'No meaningful submission form detected on this page.'}
            </p>
          </div>

          <div className="actions main-actions">
            <button className="btn btn-primary capture-btn" disabled={true}>
              Capture submission
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="status-card">
            <div className="site-info">{hostname}</div>
            <div className="field-stats">
              <span className="count">{answeredCount > 0 ? answeredCount : totalFields}</span>
              <span className="label">
                {answeredCount > 0
                  ? `${answeredCount === 1 ? 'Answer ready' : 'Answers ready'} (${totalFields} fields detected)`
                  : totalFields === 1
                    ? 'Field detected (blank)'
                    : 'Fields detected (blank)'}
              </span>
            </div>

            {matchingSubmission ? (
              <div className="match-banner">
                <span className="match-title">Saved submission found</span>
                <span className="match-date">
                  Updated{' '}
                  {new Date(
                    matchingSubmission.updatedAt || matchingSubmission.createdAt,
                  ).toLocaleDateString()}
                </span>
              </div>
            ) : (
              <p className="form-subtext">
                {answeredCount > 0
                  ? 'Application form detected'
                  : 'Application form detected. No answers entered yet.'}
              </p>
            )}

            {hasActiveDraft && <div className="passive-draft-note">Draft saved locally</div>}
          </div>

          <div className="actions main-actions">
            {matchingSubmission && (
              <button onClick={handleFill} className="btn btn-secondary fill-btn">
                Fill from saved answers
              </button>
            )}

            <button
              className="btn btn-primary capture-btn"
              onClick={handleCapture}
              disabled={answeredCount === 0}
            >
              {answeredCount === 0
                ? 'Capture answers (0)'
                : matchingSubmission
                  ? `Update saved submission (${answeredCount})`
                  : `Capture ${answeredCount} ${answeredCount === 1 ? 'answer' : 'answers'}`}
            </button>
          </div>
        </>
      )}

      <div className="privacy-note">Stored locally. Nothing is uploaded.</div>
    </div>
  );
}
