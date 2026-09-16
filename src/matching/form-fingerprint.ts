/**
 * Deterministic form fingerprinting and signature extraction.
 * Identifies the logical structure of a form without including user answers,
 * sensitive fields, volatile IDs, or brittle CSS selectors.
 */

export interface FormFieldDescriptor {
  label: string;
  fieldType: string;
  excluded?: boolean;
}

/**
 * Normalizes a field label into a clean, canonical string for matching and fingerprinting.
 * Removes required markers (*), punctuation, collapses whitespace, and lowercases.
 */
export function normalizeLabel(label: string): string {
  if (!label) return '';
  return label
    .toLowerCase()
    .replace(/[*:\-–—_?#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fast, deterministic 64-bit string hash (Murmur-style) returning a 12-char hex string.
 * Synchronous and portable across browser content scripts, popups, and Node.js.
 */
export function hashString(str: string): string {
  let h1 = 0xdeadbeef ^ 0;
  let h2 = 0x41c6ce57 ^ 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(12, '0');
}

/**
 * Extracts a sorted, deduplicated list of non-sensitive field signatures.
 * Format: `${normalizedLabel}:${fieldType}`
 */
export function extractFieldSignatures(fields: FormFieldDescriptor[]): string[] {
  const signatures = new Set<string>();

  for (const field of fields) {
    if (field.excluded) continue;
    const norm = normalizeLabel(field.label);
    if (!norm) continue;
    const type = (field.fieldType || 'text').toLowerCase();
    signatures.add(`${norm}:${type}`);
  }

  return Array.from(signatures).sort();
}

/**
 * Computes a stable, deterministic fingerprint string for a form.
 * Combines the normalized hostname with sorted field signatures.
 * Returns a string like: `fp_v2_<hash>`
 */
export function computeFormFingerprint(hostname: string, fields: FormFieldDescriptor[]): string {
  const normHost = (hostname || '')
    .toLowerCase()
    .replace(/^www\./, '')
    .trim();
  const signatures = extractFieldSignatures(fields);

  if (signatures.length === 0) {
    return `fp_v2_${normHost}_empty`;
  }

  const rawKey = `${normHost}::${signatures.join(';;')}`;
  const hash = hashString(rawKey);
  return `fp_v2_${hash}`;
}

/**
 * Calculates the Jaccard similarity score (0.0 to 1.0) between two sets of field signatures.
 */
export function calculateSignatureSimilarity(sigsA: string[], sigsB: string[]): number {
  if (sigsA.length === 0 && sigsB.length === 0) return 1.0;
  if (sigsA.length === 0 || sigsB.length === 0) return 0.0;

  const setA = new Set(sigsA);
  const setB = new Set(sigsB);

  let intersection = 0;
  for (const s of setA) {
    if (setB.has(s)) intersection++;
  }

  const union = new Set([...sigsA, ...sigsB]).size;
  return union === 0 ? 0 : intersection / union;
}
