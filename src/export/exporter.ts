import type { Submission } from '../models/submission';

export function exportAsJson(submission: Submission): string {
  const cleanFields = submission.fields.filter((f) => !f.excluded);
  const cleanSubmission = { ...submission, fields: cleanFields };
  return JSON.stringify(cleanSubmission, null, 2);
}

export function exportAsMarkdown(submission: Submission): string {
  const date = new Date(submission.createdAt).toLocaleString();
  const cleanFields = submission.fields.filter((f) => !f.excluded);

  let md = `# ${submission.submissionTitle || 'Untitled Submission'}\n\n`;
  md += `**Site:** ${submission.hostname}\n`;
  md += `**URL:** ${submission.pageUrl}\n`;
  md += `**Date:** ${date}\n\n`;
  md += `---\n\n`;
  md += `## Questions & Answers\n\n`;

  for (const field of cleanFields) {
    md += `### ${field.label || 'Unknown Field'}\n`;
    md += `${field.value || ''}\n\n`;
  }

  md += `---\n\n`;
  md += `*Captured by SubmitLog on ${date}*\n`;

  return md;
}

export function exportAllAsJson(submissions: Submission[]): string {
  const data = {
    exportedAt: new Date().toISOString(),
    exportVersion: 1,
    count: submissions.length,
    submissions: submissions.map((sub) => ({
      ...sub,
      fields: sub.fields.filter((f) => !f.excluded),
    })),
  };
  return JSON.stringify(data, null, 2);
}

export function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();

  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
