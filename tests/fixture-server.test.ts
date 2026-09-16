import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { resolveFixturePath, FIXTURES_DIR } from './serve-fixtures.mjs';

describe('fixture-server path resolution', () => {
  it('resolves exact fixture path', () => {
    const resolved = resolveFixturePath('/sample-application.html');
    expect(resolved).not.toBeNull();
    expect(resolved).toBe(path.join(FIXTURES_DIR, 'sample-application.html'));
    expect(fs.existsSync(resolved!)).toBe(true);
  });

  it('resolves fixture path with GET query parameters correctly', () => {
    const resolved = resolveFixturePath(
      '/sample-application.html?fullName=Alice+Founder&email=alice%40startup.io&terms=accepted',
    );
    expect(resolved).not.toBeNull();
    expect(resolved).toBe(path.join(FIXTURES_DIR, 'sample-application.html'));
    expect(fs.existsSync(resolved!)).toBe(true);
  });

  it('resolves root / to sample-application.html', () => {
    const resolved = resolveFixturePath('/');
    expect(resolved).toBe(path.join(FIXTURES_DIR, 'sample-application.html'));
  });

  it('resolves root / with query parameters to sample-application.html', () => {
    const resolved = resolveFixturePath('/?param=value');
    expect(resolved).toBe(path.join(FIXTURES_DIR, 'sample-application.html'));
  });

  it('resolves other fixtures with query strings and hashes', () => {
    const resolved = resolveFixturePath('/traditional-form.html?submitted=true#section');
    expect(resolved).toBe(path.join(FIXTURES_DIR, 'traditional-form.html'));
    expect(fs.existsSync(resolved!)).toBe(true);
  });

  it('blocks path traversal attacks attempting to escape fixtures directory', () => {
    expect(resolveFixturePath('/../package.json')).toBeNull();
    expect(resolveFixturePath('/../../package.json')).toBeNull();
    expect(resolveFixturePath('/....//package.json')).toBeNull();
    expect(resolveFixturePath('/..%2Fpackage.json')).toBeNull();
  });

  it('blocks null-byte injection attempts', () => {
    expect(resolveFixturePath('/sample-application.html%00.evil')).toBeNull();
  });

  it('blocks requesting the fixtures directory itself', () => {
    expect(resolveFixturePath('/.')).toBeNull();
  });
});
