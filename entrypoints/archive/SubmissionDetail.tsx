import { useState } from 'react';
import type { Submission } from '../../src/models/submission';
import { exportAsJson, exportAsMarkdown, downloadFile } from '../../src/export/exporter';

interface Props {
  submission: Submission;
  onBack: () => void;
  onDelete: () => void;
  onUpdate: (updated: Submission) => void;
}

export function SubmissionDetail({ submission, onBack, onDelete, onUpdate }: Props) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState(submission.submissionTitle);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  async function handleTitleSave() {
    if (title.trim() && title !== submission.submissionTitle) {
      await onUpdate({ ...submission, submissionTitle: title.trim() });
    }
    setEditingTitle(false);
  }

  async function copyToClipboard(text: string, feedbackId: string) {
    await navigator.clipboard.writeText(text);
    setCopyFeedback(feedbackId);
    setTimeout(() => setCopyFeedback(null), 2000);
  }

  function handleExportJson() {
    const json = exportAsJson(submission);
    const slug = submission.hostname.replace(/\./g, '_');
    downloadFile(json, `submitlog_${slug}_${submission.id.slice(0, 8)}.json`, 'application/json');
  }

  function handleExportMarkdown() {
    const md = exportAsMarkdown(submission);
    const slug = submission.hostname.replace(/\./g, '_');
    downloadFile(md, `submitlog_${slug}_${submission.id.slice(0, 8)}.md`, 'text/markdown');
  }

  function handleCopyAllMarkdown() {
    const md = exportAsMarkdown(submission);
    copyToClipboard(md, 'all-md');
  }

  return (
    <div className="archive-container">
      <header className="archive-header detail-header">
        <div className="header-content">
          <button onClick={onBack} className="btn btn-secondary back-btn">
            Back to List
          </button>

          <div className="title-section">
            {editingTitle ? (
              <div className="title-edit">
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onBlur={handleTitleSave}
                  onKeyDown={(e) => e.key === 'Enter' && handleTitleSave()}
                  autoFocus
                />
              </div>
            ) : (
              <div
                className="title-display"
                onClick={() => setEditingTitle(true)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && setEditingTitle(true)}
              >
                <h1>{submission.submissionTitle}</h1>
                <span className="edit-hint">Edit</span>
              </div>
            )}
            <div className="meta-info">
              <a href={submission.pageUrl} target="_blank" rel="noreferrer" className="url-link">
                {submission.hostname}
              </a>
              <span className="dot">&middot;</span>
              <span>{new Date(submission.createdAt).toLocaleString()}</span>
              <span className="dot">&middot;</span>
              <span>{submission.fields.length} fields</span>
            </div>
          </div>

          <div className="header-actions">
            <button onClick={handleCopyAllMarkdown} className="btn btn-secondary">
              {copyFeedback === 'all-md' ? 'Copied' : 'Copy all as Markdown'}
            </button>
            <button onClick={handleExportJson} className="btn btn-secondary">
              Export JSON
            </button>
            <button onClick={handleExportMarkdown} className="btn btn-secondary">
              Export Markdown
            </button>
            <button onClick={onDelete} className="btn btn-danger">
              Delete
            </button>
          </div>
        </div>
      </header>

      <main className="archive-main detail-main">
        <div className="qa-list">
          {submission.fields.length === 0 ? (
            <div className="empty-state">No fields captured in this submission.</div>
          ) : (
            submission.fields.map((f) => (
              <div key={f.id} className="qa-card">
                <div className="qa-header">
                  <h3 className="qa-question">{f.label}</h3>
                  <button
                    onClick={() => copyToClipboard(f.value, f.id)}
                    className="btn btn-sm btn-outline"
                  >
                    {copyFeedback === f.id ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <div className="qa-answer">
                  {f.value || <span className="empty-val">(empty)</span>}
                </div>
              </div>
            ))
          )}
        </div>
      </main>
    </div>
  );
}
