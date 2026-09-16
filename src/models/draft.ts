import type { FieldType } from './submission';

export const DRAFT_SCHEMA_VERSION = 1;

export interface DraftField {
  id: string;
  label: string;
  value: string;
  fieldType: FieldType;
  updatedAt: string; // ISO 8601
}

export interface FormDraft {
  id: string; // Composite key: `${origin}|${pathname}|${formFingerprint}`
  schemaVersion: number;
  origin: string; // Normalized origin, e.g. "https://example.com"
  hostname: string; // e.g. "example.com"
  pathname: string; // Normalized pathname, e.g. "/apply/form1"
  pageTitle: string;
  pageUrl: string;
  formFingerprint: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  fields: Record<string, DraftField>; // Keyed by normalized label or field key
}

const TRACKING_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'ref',
  'fbclid',
  'gclid',
  'msclkid',
  '_ga',
  'mc_cid',
  'mc_eid',
];

/**
 * Strips tracking query parameters and normalizes a pathname or URL for stable draft matching.
 */
export function normalizeDraftPathname(rawUrlOrPath: string): string {
  if (!rawUrlOrPath) return '/';
  try {
    const url = new URL(rawUrlOrPath, 'https://dummy.local');
    for (const param of TRACKING_PARAMS) {
      url.searchParams.delete(param);
    }
    const search = url.searchParams.toString();
    return url.pathname + (search ? `?${search}` : '');
  } catch {
    const clean = rawUrlOrPath.split('#')[0] || '/';
    return clean;
  }
}

/**
 * Builds the deterministic composite identity for a form draft.
 */
export function buildDraftId(origin: string, pathname: string, formFingerprint: string): string {
  const normOrigin = (origin || '').toLowerCase().trim().replace(/\/+$/, '');
  const normPath = normalizeDraftPathname(pathname);
  const normFp = (formFingerprint || '').trim();
  return `${normOrigin}|${normPath}|${normFp}`;
}
