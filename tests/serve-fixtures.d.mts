import type { IncomingMessage, ServerResponse } from 'node:http';

export const FIXTURES_DIR: string;
export const PORT: number;
export const MIME_TYPES: Record<string, string>;
export const ALLOWED_FIXTURES: Set<string>;

export function resolveFixturePath(
  rawUrl: string | undefined | null,
  fixturesDir?: string,
): string | null;

export function handleFixtureRequest(
  req: IncomingMessage,
  res: ServerResponse,
  fixturesDir?: string,
): void;
