import { useState, useEffect, useCallback, useMemo } from 'react';
import type { Submission } from '../../src/models/submission';
import { createSubmissionRepository } from '../../src/storage/submission-repository';
import { exportAllAsJson, downloadFile } from '../../src/export/exporter';
import { SubmissionDetail } from './SubmissionDetail';
import './archive.css';

export function Archive() {
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);

  const repo = useMemo(() => createSubmissionRepository(), []);

  const loadSubmissions = useCallback(async () => {
    setLoading(true);
    try {
      const data = await repo.getAll();
      data.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      setSubmissions(data);
    } catch {
      setSubmissions([]);
    } finally {
      setLoading(false);
    }
  }, [repo]);

  useEffect(() => {
    loadSubmissions();
  }, [loadSubmissions]);

  const filteredSubmissions = submissions.filter((sub) => {
    const q = searchQuery.toLowerCase();
    return (
      sub.submissionTitle.toLowerCase().includes(q) ||
      sub.hostname.toLowerCase().includes(q) ||
      sub.fields.some((f) => f.label.toLowerCase().includes(q) || f.value.toLowerCase().includes(q))
    );
  });

  async function handleDelete(id: string) {
    if (!window.confirm('Are you sure you want to delete this submission?')) return;
    await repo.delete(id);
    if (selectedId === id) setSelectedId(null);
    await loadSubmissions();
  }

  async function handleUpdate(updated: Submission) {
    await repo.save(updated);
    await loadSubmissions();
  }

  if (selectedId) {
    const selected = submissions.find((s) => s.id === selectedId);
    if (selected) {
      return (
        <SubmissionDetail
          submission={selected}
          onBack={() => setSelectedId(null)}
          onDelete={() => handleDelete(selected.id)}
          onUpdate={handleUpdate}
        />
      );
    }
  }

  return (
    <div className="archive-container">
      <header className="archive-header">
        <div className="header-content">
          <h1>SubmitLog Archive</h1>
          <div className="search-bar">
            <input
              type="text"
              placeholder="Search submissions..."
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
        ) : filteredSubmissions.length === 0 ? (
          <div className="empty-state">
            {searchQuery
              ? 'No matching submissions found.'
              : 'Your archive is empty. Capture some forms!'}
          </div>
        ) : (
          <div className="submissions-grid">
            {filteredSubmissions.map((sub) => (
              <div key={sub.id} className="submission-card" onClick={() => setSelectedId(sub.id)}>
                <div className="card-header">
                  <h3>{sub.submissionTitle}</h3>
                </div>
                <div className="card-body">
                  <div className="meta-item">
                    <span className="meta-label">Site</span>
                    <span>{sub.hostname}</span>
                  </div>
                  <div className="meta-item">
                    <span className="meta-label">Date</span>
                    <span>{new Date(sub.createdAt).toLocaleString()}</span>
                  </div>
                  <div className="meta-item">
                    <span className="meta-label">Fields</span>
                    <span>{sub.fields.length} captured</span>
                  </div>
                </div>
                <div className="card-actions">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedId(sub.id);
                    }}
                    className="btn btn-primary"
                  >
                    View Details
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(sub.id);
                    }}
                    className="btn btn-danger"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
