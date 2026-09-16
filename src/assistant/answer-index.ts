import type { Submission } from '../models/submission';
import type { SubmissionRepository } from '../storage/submission-repository';
import type { AnswerMemoryRepository } from '../storage/answer-memory-repository';

export interface IndexedAnswer {
  label: string;
  value: string;
  fieldType: string;
  hostname: string;
  submissionId: string;
  updatedAt: string;
}

/**
 * Normalizes a field label for semantic question matching.
 * Strips punctuation, asterisks, colons, question marks, hashes, and collapses whitespace.
 */
export function normalizeAnswerLabel(label: string): string {
  if (!label) return '';
  return label
    .toLowerCase()
    .replace(/[*?:!#\-_()[\]{}.,/\\<>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class AnswerIndex {
  private entries: Map<string, IndexedAnswer[]> = new Map();

  constructor(submissions: Submission[] = []) {
    this.rebuild(submissions);
  }

  /**
   * Rebuilds the index from a list of submissions.
   */
  public rebuild(submissions: Submission[]): void {
    this.entries.clear();

    for (const sub of submissions) {
      if (!sub.fields) continue;
      const subTime = sub.updatedAt || sub.createdAt || new Date().toISOString();

      for (const field of sub.fields) {
        if (field.excluded) continue;
        const val = (field.value || '').trim();
        if (!val) continue;

        const norm = normalizeAnswerLabel(field.label);
        if (!norm) continue;

        const list = this.entries.get(norm) || [];
        list.push({
          label: field.label,
          value: val,
          fieldType: field.fieldType,
          hostname: sub.hostname,
          submissionId: sub.id,
          updatedAt: subTime,
        });
        this.entries.set(norm, list);
      }
    }
  }

  /**
   * Adds Answer Memory entries (from finalized drafts and explicit submissions) into the index.
   */
  public addAnswerMemoryEntries(
    entries: Array<{
      id: string;
      label: string;
      normalizedLabel?: string;
      value: string;
      fieldType: string;
      hostname?: string;
      updatedAt?: string;
    }>,
  ): void {
    for (const entry of entries) {
      if (!entry.value || !entry.value.trim()) continue;
      const norm = normalizeAnswerLabel(entry.label || entry.normalizedLabel || '');
      if (!norm) continue;

      const list = this.entries.get(norm) || [];
      list.push({
        label: entry.label,
        value: entry.value.trim(),
        fieldType: entry.fieldType,
        hostname: entry.hostname || '',
        submissionId: entry.id,
        updatedAt: entry.updatedAt || new Date().toISOString(),
      });
      this.entries.set(norm, list);
    }
  }

  /**
   * Returns suggestions matching a field label, prioritizing the current hostname
   * and ordered by most recent submission first.
   */
  public getSuggestions(label: string, hostname?: string): IndexedAnswer[] {
    const norm = normalizeAnswerLabel(label);
    if (!norm) return [];

    let matches = this.entries.get(norm) || [];

    // Fallback: check partial token overlap or containment if no exact match
    if (matches.length === 0) {
      for (const [key, list] of this.entries.entries()) {
        if (norm.length >= 4 && (key.includes(norm) || norm.includes(key))) {
          matches = matches.concat(list);
        }
      }
    }

    if (matches.length === 0) return [];

    // Sort: current hostname first, then recency descending
    const normHost = (hostname || '').toLowerCase().trim();
    const sorted = [...matches].sort((a, b) => {
      if (normHost) {
        const aMatchesHost = a.hostname.toLowerCase() === normHost;
        const bMatchesHost = b.hostname.toLowerCase() === normHost;
        if (aMatchesHost && !bMatchesHost) return -1;
        if (!aMatchesHost && bMatchesHost) return 1;
      }
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

    // Deduplicate by value (case-insensitive)
    const seen = new Set<string>();
    const deduped: IndexedAnswer[] = [];
    for (const item of sorted) {
      const lowerVal = item.value.toLowerCase();
      if (!seen.has(lowerVal)) {
        seen.add(lowerVal);
        deduped.push(item);
      }
    }

    return deduped;
  }

  /**
   * Checks if an eligible field label has any saved answers in the index.
   */
  public hasSuggestionsFor(label: string, hostname?: string): boolean {
    return this.getSuggestions(label, hostname).length > 0;
  }

  /**
   * Gets the single best answer for a label.
   */
  public getBestAnswerFor(label: string, hostname?: string): string | null {
    const suggestions = this.getSuggestions(label, hostname);
    return suggestions[0]?.value || null;
  }

  /**
   * Returns a map of normalized labels to their top answer for a specific hostname.
   * Useful for bootstrapping the page assistant on load/reload.
   */
  public getAllAvailableForHost(
    hostname: string,
  ): Record<string, { value: string; fieldType: string; count: number }> {
    const result: Record<string, { value: string; fieldType: string; count: number }> = {};
    for (const [normLabel, list] of this.entries.entries()) {
      const suggestions = this.getSuggestions(normLabel, hostname);
      if (suggestions.length > 0) {
        const best = suggestions[0];
        if (best) {
          result[normLabel] = {
            value: best.value,
            fieldType: best.fieldType,
            count: list.length,
          };
        }
      }
    }
    return result;
  }
}

let cachedIndex: AnswerIndex | null = null;

/**
 * Builds or refreshes the global in-memory AnswerIndex from SubmissionRepository and AnswerMemoryRepository.
 */
export async function getOrBuildAnswerIndex(
  customRepo?: SubmissionRepository,
  customMemoryRepo?: AnswerMemoryRepository,
): Promise<AnswerIndex> {
  const { createSubmissionRepository } = await import('../storage/submission-repository');
  const repo = customRepo || createSubmissionRepository();
  const subs = await repo.getAll();
  const index = new AnswerIndex(subs);

  try {
    const { createAnswerMemoryRepository } = await import('../storage/answer-memory-repository');
    const memoryRepo = customMemoryRepo || createAnswerMemoryRepository();
    const memories = await memoryRepo.getAll();
    index.addAnswerMemoryEntries(memories);
  } catch {
    // Fallback in mock environments
  }

  cachedIndex = index;
  return cachedIndex;
}

export function invalidateCachedAnswerIndex(): void {
  cachedIndex = null;
}
