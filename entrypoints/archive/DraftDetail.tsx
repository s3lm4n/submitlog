import { useState } from 'react';
import type { FormDraft } from '../../src/models/draft';
import { SCHEMA_VERSION, type Submission, type CapturedField } from '../../src/models/submission';
import { generateId } from '../../src/utils/id';
import { createSubmissionRepository } from '../../src/storage/submission-repository';

interface Props {
  draft: FormDraft;
  onBack: () => void;
  onDelete: () => void;
  onConverted: () => void;
}

export function DraftDetail({ draft, onBack, onDelete, onConverted }: Props) {
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [isConverting, setIsConverting] = useState(false);

  async function copyToClipboard(text: string, feedbackId: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopyFeedback(feedbackId);
      setTimeout(() => setCopyFeedback(null), 2000);
    } catch {
      // ignore
    }
  }

  function handleCopyAllMarkdown() {
    const fields = Object.values(draft.fields);
    let md = `# Draft: ${draft.pageTitle || draft.hostname}\n\n`;
    md += `**Site:** ${draft.hostname}\n`;
    md += `**URL:** ${draft.pageUrl}\n`;
    md += `**Last Saved:** ${new Date(draft.updatedAt).toLocaleString()}\n`;
    md += `**Status:** In progress (Draft)\n\n---\n\n## Saved Answers\n\n`;

    for (const f of fields) {
      md += `### ${f.label}\n${f.value}\n\n`;
    }

    md += `*Autosaved by SubmitLog on ${new Date(draft.updatedAt).toLocaleString()}*\n`;
    copyToClipboard(md, 'all-md');
  }

  async function handleConvertToSubmission() {
    setIsConverting(true);
    try {
      const now = new Date().toISOString();
      const fields: CapturedField[] = Object.values(draft.fields).map((f) => ({
        id: f.id || generateId(),
        label: f.label,
        value: f.value,
        fieldType: f.fieldType,
        labelSource: 'label-for',
        excluded: false,
      }));

      const newSubmission: Submission = {
        id: generateId(),
        schemaVersion: SCHEMA_VERSION,
        createdAt: draft.createdAt || now,
        updatedAt: now,
        pageTitle: draft.pageTitle || draft.hostname,
        pageUrl: draft.pageUrl || `https://${draft.hostname}/`,
        hostname: draft.hostname,
        submissionTitle: `${draft.pageTitle || draft.hostname} - Captured Draft`,
        fields,
        captureVersion: '0.1.0',
        formFingerprint: draft.formFingerprint,
        revisions: [
          {
            id: generateId(),
            createdAt: now,
            fields: fields.map((f) => ({ ...f })),
            changeNote: 'Converted from autosaved draft to permanent submission',
          },
        ],
      };

      const repo = createSubmissionRepository();
      await repo.save(newSubmission);
      onConverted();
    } catch {
      setIsConverting(false);
    }
  }

  const fieldsList = Object.values(draft.fields);

  return (
    <div className="archive-container">
      <header className="archive-header detail-header">
        <div className="header-content">
          <button onClick={onBack} className="btn btn-secondary back-btn">
            Back to List
          </button>

          <div className="title-section">
            <div className="title-display">
              <h1>{draft.pageTitle || draft.hostname}</h1>
              <span className="badge badge-draft">Draft (In Progress)</span>
            </div>
            <div className="meta-info">
              <a href={draft.pageUrl} target="_blank" rel="noreferrer" className="url-link">
                {draft.hostname}
              </a>
              <span className="dot">&middot;</span>
              <span>Last saved: {new Date(draft.updatedAt).toLocaleString()}</span>
              <span className="dot">&middot;</span>
              <span>{fieldsList.length} saved fields</span>
            </div>
          </div>

          <div className="header-actions">
            <button onClick={handleCopyAllMarkdown} className="btn btn-secondary">
              {copyFeedback === 'all-md' ? '✓ Copied' : 'Copy as Markdown'}
            </button>
            <button
              onClick={handleConvertToSubmission}
              disabled={isConverting}
              className="btn btn-primary"
            >
              {isConverting ? 'Saving...' : 'Save to Archive'}
            </button>
            <button onClick={onDelete} className="btn btn-danger">
              Delete Draft
            </button>
          </div>
        </div>
      </header>

      <main className="archive-main detail-main">
        <div className="draft-notice-banner">
          <span className="notice-icon">ℹ️</span>
          <span>
            This is an in-progress autosaved draft. It updates automatically as you complete form
            fields and has not yet been marked as submitted.
          </span>
        </div>

        <div className="fields-container">
          <h2>Draft Answers ({fieldsList.length})</h2>
          {fieldsList.length === 0 ? (
            <div className="empty-fields">No answers saved in this draft.</div>
          ) : (
            <div className="fields-list">
              {fieldsList.map((f, idx) => (
                <div key={f.id || idx} className="field-card">
                  <div className="field-header">
                    <span className="field-label">{f.label}</span>
                    <button
                      onClick={() => copyToClipboard(f.value, `field-${idx}`)}
                      className="btn btn-sm btn-secondary copy-field-btn"
                    >
                      {copyFeedback === `field-${idx}` ? '✓ Copied' : 'Copy'}
                    </button>
                  </div>
                  <div className="field-value">{f.value}</div>
                  <div className="field-meta">
                    <span className="field-type-badge">{f.fieldType}</span>
                    <span className="field-updated-time">
                      Saved {new Date(f.updatedAt).toLocaleTimeString()}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
