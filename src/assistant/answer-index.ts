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

export const SEMANTIC_MODIFIERS = [
  'password',
  'passcode',
  'confirm',
  'confirmation',
  'previous',
  'former',
  'current',
  'expected',
  'desired',
  'minimum',
  'maximum',
] as const;

export function getSemanticModifiers(label: string): Set<string> {
  const words = normalizeAnswerLabel(label).split(/\s+/);
  const found = new Set<string>();
  for (const w of words) {
    if (w === 'password' || w === 'passcode') found.add('password');
    if (w === 'confirm' || w === 'confirmation') found.add('confirm');
    if (w === 'previous' || w === 'former') found.add('previous');
    if (w === 'current') found.add('current');
    if (w === 'expected' || w === 'desired') found.add('expected');
    if (w === 'minimum' || w === 'min') found.add('minimum');
    if (w === 'maximum' || w === 'max') found.add('maximum');
  }
  return found;
}

export function hasSemanticModifierConflict(labelA: string, labelB: string): boolean {
  const modsA = getSemanticModifiers(labelA);
  const modsB = getSemanticModifiers(labelB);
  if (modsA.size !== modsB.size) return true;
  for (const m of modsA) {
    if (!modsB.has(m)) return true;
  }
  return false;
}

export const BENIGN_DESCRIPTORS = new Set(['url', 'link', 'profile', 'number', 'name', 'address']);

export const STOP_WORDS = new Set([
  'a',
  'about',
  'above',
  'after',
  'again',
  'against',
  'all',
  'am',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'because',
  'been',
  'before',
  'being',
  'below',
  'between',
  'both',
  'but',
  'by',
  'can',
  'did',
  'do',
  'does',
  'doing',
  'down',
  'during',
  'each',
  'few',
  'for',
  'from',
  'further',
  'had',
  'has',
  'have',
  'having',
  'he',
  'her',
  'here',
  'hers',
  'herself',
  'him',
  'himself',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'itself',
  'just',
  'me',
  'more',
  'most',
  'my',
  'myself',
  'no',
  'nor',
  'not',
  'now',
  'of',
  'off',
  'on',
  'once',
  'only',
  'or',
  'other',
  'our',
  'ours',
  'ourselves',
  'out',
  'over',
  'own',
  'same',
  'she',
  'should',
  'so',
  'some',
  'such',
  'than',
  'that',
  'the',
  'their',
  'theirs',
  'them',
  'themselves',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'to',
  'too',
  'under',
  'until',
  'up',
  'very',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'whom',
  'why',
  'will',
  'with',
  'you',
  'your',
  'yours',
  'yourself',
  'yourselves',
  'ever',
  // Question-style and form prompt wrappers
  'please',
  'enter',
  'provide',
  'tell',
  'us',
  'input',
]);

export function getContentWords(label: string): string[] {
  return normalizeAnswerLabel(label)
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w));
}

export function getSemanticBase(label: string): string {
  const content = getContentWords(label);
  if (content.length === 0) return '';
  const filtered = content.filter((w) => !BENIGN_DESCRIPTORS.has(w));
  // If stripping benign descriptors removed all tokens (e.g. label was just "Name" or "Address"), retain content words
  const baseWords = filtered.length > 0 ? filtered : content;
  return baseWords.join(' ');
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

    // Fallback: semantic match only when exact match fails
    if (matches.length === 0) {
      const targetBase = getSemanticBase(label);
      const targetContentWords = getContentWords(label);

      for (const [key, list] of this.entries.entries()) {
        // Hard blocker: reject semantic modifier conflicts
        if (hasSemanticModifierConflict(label, key)) continue;

        // 1. Exact semantic-base match after stopword & benign-descriptor normalization
        const keyBase = getSemanticBase(key);
        if (targetBase && keyBase && targetBase === keyBase) {
          matches = matches.concat(list);
          continue;
        }

        // 2. Conservative similarity for longer labels (both >= 3 content words, Dice >= 0.85)
        const candidateContentWords = getContentWords(key);
        if (targetContentWords.length >= 3 && candidateContentWords.length >= 3) {
          const setA = new Set(targetContentWords);
          const setB = new Set(candidateContentWords);
          let common = 0;
          for (const w of setA) {
            if (setB.has(w)) common++;
          }
          const dice = (2 * common) / (setA.size + setB.size);
          if (dice >= 0.85) {
            matches = matches.concat(list);
          }
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
