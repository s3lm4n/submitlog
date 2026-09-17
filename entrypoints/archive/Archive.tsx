import { useState, useEffect, useCallback, useMemo } from 'react';
import type { Submission } from '../../src/models/submission';
import type { FormDraft } from '../../src/models/draft';
import { createSubmissionRepository } from '../../src/storage/submission-repository';
import { createDraftRepository, consolidateDrafts } from '../../src/storage/draft-repository';
import { exportAllAsJson, downloadFile } from '../../src/export/exporter';
import { SubmissionDetail } from './SubmissionDetail';
import { DraftDetail } from './DraftDetail';
import './archive.css';

export function Archive() {
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [drafts, setDrafts] = useState<FormDraft[]>([]);
  const [selectedSubmissionId, setSelectedSubmissionId] = useState<string | null>(null);
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [isDeletingDraft, setIsDeletingDraft] = useState(false);

  const subRepo = useMemo(() => createSubmissionRepository(), []);
  const draftRepo = useMemo(() => createDraftRepository(), []);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [subsData, rawDrafts] = await Promise.all([
        subRepo.getAll().catch(() => [] as Submission[]),
        draftRepo.getAll().catch(() => [] as FormDraft[]),
      ]);

      const { canonicalDrafts } = consolidateDrafts(rawDrafts);

      subsData.sort(
        (a: Submission, b: Submission) =>
          new Date(b.updatedAt || b.createdAt).getTime() -
          new Date(a.updatedAt || a.createdAt).getTime(),
      );
      canonicalDrafts.sort(
        (a: FormDraft, b: FormDraft) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );

      setSubmissions(subsData);
      setDrafts(canonicalDrafts);
    } catch {
      setSubmissions([]);
      setDrafts([]);
    } finally {
      setLoading(false);
    }
  }, [subRepo, draftRepo]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const q = searchQuery.toLowerCase().trim();

  const filteredDrafts = drafts.filter((draft) => {
    if (!q) return true;
    const fieldsList = Object.values(draft.fields || {});
    return (
      (draft.pageTitle && draft.pageTitle.toLowerCase().includes(q)) ||
      (draft.hostname && draft.hostname.toLowerCase().includes(q)) ||
      fieldsList.some(
        (f) =>
          (f.label && f.label.toLowerCase().includes(q)) ||
          (f.value && f.value.toLowerCase().includes(q)),
      )
    );
  });

  const filteredSubmissions = submissions.filter((sub) => {
    if (!q) return true;
    return (
      (sub.submissionTitle && sub.submissionTitle.toLowerCase().includes(q)) ||
      (sub.hostname && sub.hostname.toLowerCase().includes(q)) ||
      (sub.fields &&
        sub.fields.some(
          (f) =>
            (f.label && f.label.toLowerCase().includes(q)) ||
            (f.value && f.value.toLowerCase().includes(q)),
        ))
    );
  });

  async function handleDeleteSubmission(id: string) {
    if (!window.confirm('Are you sure you want to delete this submission?')) return;
    await subRepo.delete(id);
    if (selectedSubmissionId === id) setSelectedSubmissionId(null);
    await loadData();
  }

  async function handleDeleteDraft(id: string) {
    if (isDeletingDraft) return;
    if (!window.confirm('Are you sure you want to delete this draft?')) return;

    setIsDeletingDraft(true);
    const draftToDelete = drafts.find((d) => d.id === id);
    const previousDrafts = [...drafts];

    // Optimistically remove card immediately from local UI state
    setDrafts((prev) => prev.filter((d) => d.id !== id));
    if (selectedDraftId === id) setSelectedDraftId(null);

    try {
      // 1. Delete from repository
      await draftRepo.delete(id);

      // 2. Notify background to set tombstone and alert content scripts
      try {
        const g = globalThis as unknown as {
          browser?: { runtime?: { sendMessage?: (msg: unknown) => void } };
          chrome?: { runtime?: { sendMessage?: (msg: unknown) => void } };
        };
        const runtime = g.browser?.runtime || g.chrome?.runtime;
        if (runtime && typeof runtime.sendMessage === 'function') {
          runtime.sendMessage({
            type: 'SUBMITLOG_DELETE_DRAFT',
            payload: {
              id,
              origin: draftToDelete?.origin,
              pathname: draftToDelete?.pathname,
              formFamilyKey: draftToDelete?.formFamilyKey,
            },
          });
        }
      } catch {
        // ignore background communication error
      }

      // 3. Reconcile with repository state
      await loadData();
    } catch {
      // If deletion fails, restore previous drafts and show error
      setDrafts(previousDrafts);
      alert('Failed to delete draft. Please try again.');
    } finally {
      setIsDeletingDraft(false);
    }
  }

  async function handleUpdateSubmission(updated: Submission) {
    await subRepo.save(updated);
    await loadData();
  }

  if (selectedDraftId) {
    const selectedDraft = drafts.find((d) => d.id === selectedDraftId);
    if (selectedDraft) {
      return (
        <DraftDetail
          draft={selectedDraft}
          onBack={() => setSelectedDraftId(null)}
          onDelete={() => handleDeleteDraft(selectedDraft.id)}
          onConverted={async () => {
            setSelectedDraftId(null);
            await loadData();
          }}
        />
      );
    }
  }

  if (selectedSubmissionId) {
    const selectedSub = submissions.find((s) => s.id === selectedSubmissionId);
    if (selectedSub) {
      return (
        <SubmissionDetail
          submission={selectedSub}
          onBack={() => setSelectedSubmissionId(null)}
          onDelete={() => handleDeleteSubmission(selectedSub.id)}
          onUpdate={handleUpdateSubmission}
        />
      );
    }
  }

  const hasAnyRecords = drafts.length > 0 || submissions.length > 0;
  const hasMatchingRecords = filteredDrafts.length > 0 || filteredSubmissions.length > 0;

  return (
    <div className="archive-container">
      <header className="archive-header">
        <div className="header-content">
          <h1>SubmitLog Archive</h1>
          <div className="search-bar">
            <input
              type="text"
              placeholder="Search drafts and submissions..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          {submissions.length > 0 && (
            <button
              className="btn btn-secondary"
              onClick={() => {
                const json = exportAllAsJson(submissions);
                downloadFile(json, 'submitlog_archive.json', 'application/json');
              }}
            >
              Export all
            </button>
          )}
        </div>
      </header>

      <main className="archive-main">
        {loading ? (
          <div className="loading-state">Loading...</div>
        ) : !hasAnyRecords ? (
          <div className="empty-state">
            Your archive is empty. Fill out forms or capture submissions to see them here!
          </div>
        ) : !hasMatchingRecords ? (
          <div className="empty-state">No matching drafts or submissions found.</div>
        ) : (
          <div className="archive-sections">
            {/* Section 1: In progress (Autosaved Drafts) */}
            {filteredDrafts.length > 0 && (
              <section className="archive-section">
                <div className="section-header">
                  <h2>In progress ({filteredDrafts.length})</h2>
                  <span className="section-subtext">Active autosaved drafts</span>
                </div>
                <div className="submissions-grid">
                  {filteredDrafts.map((draft) => {
                    const fieldsCount = Object.keys(draft.fields || {}).length;
                    return (
                      <div
                        key={draft.id}
                        className="submission-card draft-card"
                        onClick={() => setSelectedDraftId(draft.id)}
                      >
                        <div className="card-header">
                          <h3>{draft.pageTitle || draft.hostname}</h3>
                          <span className="badge badge-draft">Draft</span>
                        </div>
                        <div className="card-body">
                          <div className="meta-item">
                            <span className="meta-label">Site</span>
                            <span>{draft.hostname}</span>
                          </div>
                          <div className="meta-item">
                            <span className="meta-label">Last saved</span>
                            <span>
                              {new Date(draft.updatedAt).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}{' '}
                              ({new Date(draft.updatedAt).toLocaleDateString()})
                            </span>
                          </div>
                          <div className="meta-item">
                            <span className="meta-label">Fields</span>
                            <span>
                              {fieldsCount} saved {fieldsCount === 1 ? 'answer' : 'answers'}
                            </span>
                          </div>
                        </div>
                        <div className="card-actions">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedDraftId(draft.id);
                            }}
                            className="btn btn-primary"
                          >
                            View Draft
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteDraft(draft.id);
                            }}
                            className="btn btn-danger"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Section 2: Saved submissions (Explicit Captured Snapshots) */}
            {filteredSubmissions.length > 0 && (
              <section className="archive-section">
                <div className="section-header">
                  <h2>Saved submissions ({filteredSubmissions.length})</h2>
                  <span className="section-subtext">Explicitly archived snapshots</span>
                </div>
                <div className="submissions-grid">
                  {filteredSubmissions.map((sub) => (
                    <div
                      key={sub.id}
                      className="submission-card"
                      onClick={() => setSelectedSubmissionId(sub.id)}
                    >
                      <div className="card-header">
                        <h3>{sub.submissionTitle}</h3>
                        <span className="badge badge-saved">Saved</span>
                      </div>
                      <div className="card-body">
                        <div className="meta-item">
                          <span className="meta-label">Site</span>
                          <span>{sub.hostname}</span>
                        </div>
                        <div className="meta-item">
                          <span className="meta-label">Updated</span>
                          <span>
                            {new Date(sub.updatedAt || sub.createdAt).toLocaleDateString()}
                          </span>
                        </div>
                        <div className="meta-item">
                          <span className="meta-label">Revisions</span>
                          <span>{sub.revisions?.length || 1}</span>
                        </div>
                        <div className="meta-item">
                          <span className="meta-label">Fields</span>
                          <span>{sub.fields.length} saved answers</span>
                        </div>
                      </div>
                      <div className="card-actions">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedSubmissionId(sub.id);
                          }}
                          className="btn btn-primary"
                        >
                          View Details
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteSubmission(sub.id);
                          }}
                          className="btn btn-danger"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
