import { useState, useEffect } from 'react';
import { browser } from 'wxt/browser';
import type { CapturedField, Submission } from '../../src/models/submission';
import { SCHEMA_VERSION } from '../../src/models/submission';
import { generateId } from '../../src/utils/id';
import { createSubmissionRepository } from '../../src/storage/submission-repository';
import {
  scanPageForms,
  capturePageForms,
  type InjectedScanResult,
  type InjectedCaptureResult,
} from '../../src/capture/injected-capture';
import {
  checkPrivateBrowsing,
  PRIVATE_BROWSING_MESSAGE,
} from '../../src/security/private-browsing-guard';
import { checkPageSupported, RESTRICTED_PAGE_MESSAGE } from '../../src/security/page-guard';
import './popup.css';

type PopupState =
  'idle' | 'loading' | 'preview' | 'saved' | 'error' | 'private-blocked' | 'restricted';

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
  const [capturedFields, setCapturedFields] = useState<CapturedField[]>([]);
  const [selectedFields, setSelectedFields] = useState<Set<string>>(new Set());
  const [excludedCount, setExcludedCount] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    scanCurrentTab();
  }, []);

  async function scanCurrentTab() {
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
      setHostname(url.hostname);
      setPageTitle(tab.title || url.hostname);
      setPageUrl(tab.url);

      // Scan all accessible frames within the tab (via activeTab/scripting)
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
      } else {
        setFormDetected(false);
        setTotalFields(0);
        setAnsweredCount(0);
        setInaccessibleFrame(anyInaccessible);
      }

      setState('idle');
    } catch {
      setState('restricted');
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

      const selected = new Set<string>();
      fields.forEach((f: CapturedField) => {
        if (!f.excluded) selected.add(f.id);
      });
      setSelectedFields(selected);
      setState('preview');
    } catch {
      setState('restricted');
    }
  }

  async function handleSave() {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (checkPrivateBrowsing(tab).isPrivate) {
        setState('private-blocked');
        return;
      }
    } catch {
      // Ignore query error, proceed with existing state
    }

    const fieldsToSave = capturedFields.map((f) => ({
      ...f,
      excluded: f.excluded || !selectedFields.has(f.id),
      value: f.excluded || !selectedFields.has(f.id) ? '' : f.value,
    }));

    const submission: Submission = {
      id: generateId(),
      schemaVersion: SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      pageTitle,
      pageUrl,
      hostname,
      submissionTitle: `${pageTitle} - ${new Date().toLocaleDateString()}`,
      fields: fieldsToSave.filter((f) => !f.excluded),
      captureVersion: '0.1.0',
    };

    try {
      const repo = createSubmissionRepository();
      await repo.save(submission);
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
        <p>Your form data has been added to the archive.</p>
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
            onClick={handleSave}
            className="btn btn-primary"
            disabled={selectedFields.size === 0}
          >
            Save ({selectedFields.size})
          </button>
        </div>
      </div>
    );
  }

  // Default idle state distinguishing:
  // 1. No form detected
  // 2. Application detected, 0 answers entered yet
  // 3. Application detected, answers ready
  return (
    <div className="popup-container idle-state">
      <div className="header">
        <h1>SubmitLog</h1>
        <button className="link-btn" onClick={openArchive}>
          Archive
        </button>
      </div>

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
      ) : answeredCount === 0 ? (
        <>
          <div className="status-card">
            <div className="site-info">{hostname}</div>
            <div className="field-stats">
              <span className="count">{totalFields}</span>
              <span className="label">
                {totalFields === 1 ? 'Field detected' : 'Fields detected'}
              </span>
            </div>
            <p className="form-subtext">Application form detected. No answers entered yet.</p>
          </div>

          <div className="actions main-actions">
            <button className="btn btn-primary capture-btn" disabled={true}>
              Capture answers (0)
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="status-card">
            <div className="site-info">{hostname}</div>
            <div className="field-stats">
              <span className="count">{answeredCount}</span>
              <span className="label">
                {answeredCount === 1 ? 'Answer ready' : 'Answers ready'} ({totalFields} fields
                detected)
              </span>
            </div>
            <p className="form-subtext">Application form detected</p>
          </div>

          <div className="actions main-actions">
            <button className="btn btn-primary capture-btn" onClick={handleCapture}>
              Capture {answeredCount} {answeredCount === 1 ? 'answer' : 'answers'}
            </button>
          </div>
        </>
      )}

      <div className="privacy-note">Stored locally. Nothing is uploaded.</div>
    </div>
  );
}
