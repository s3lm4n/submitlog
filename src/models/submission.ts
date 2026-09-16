export const SCHEMA_VERSION = 1;

export interface CapturedField {
  id: string;
  label: string;
  value: string;
  fieldType: FieldType;
  labelSource: LabelSource;
  excluded: boolean;
  excludeReason?: string;
}

export type FieldType =
  | 'text'
  | 'email'
  | 'tel'
  | 'url'
  | 'number'
  | 'date'
  | 'textarea'
  | 'select'
  | 'checkbox'
  | 'radio'
  | 'file'
  | 'other';

export type LabelSource =
  | 'label-for'
  | 'wrapping-label'
  | 'aria-labelledby'
  | 'aria-label'
  | 'nearby-text'
  | 'placeholder'
  | 'name-fallback'
  | 'id-fallback'
  | 'unknown';

export interface Submission {
  id: string;
  schemaVersion: number;
  createdAt: string; // ISO 8601
  pageTitle: string;
  pageUrl: string;
  hostname: string;
  submissionTitle: string;
  fields: CapturedField[];
  captureVersion: string;
}
