import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  SupportCard,
  GITHUB_REPO_URL,
  BUY_ME_A_COFFEE_URL,
} from '../entrypoints/archive/SupportCard';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('SupportCard Suite', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
  });

  it('renders support section with title and description', () => {
    act(() => {
      root = createRoot(container);
      root.render(<SupportCard />);
    });

    expect(container.textContent).toContain('Support SubmitLog');
    expect(container.textContent).toContain(
      'SubmitLog is free, open source, and runs entirely on your device.',
    );
    expect(container.textContent).toContain(
      'If it saves you time, you can support its development.',
    );
  });

  it('renders GitHub support link with correct href and security attributes', () => {
    act(() => {
      root = createRoot(container);
      root.render(<SupportCard />);
    });

    const links = Array.from(container.querySelectorAll('a'));
    const githubLink = links.find(
      (a) => a.getAttribute('aria-label')?.includes('GitHub') || a.textContent?.includes('GitHub'),
    );

    expect(githubLink).toBeTruthy();
    expect(githubLink?.getAttribute('href')).toBe(GITHUB_REPO_URL);
    expect(githubLink?.getAttribute('href')).toBe('https://github.com/s3lm4n/submitlog');
    expect(githubLink?.getAttribute('target')).toBe('_blank');
    expect(githubLink?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('renders Buy Me a Coffee button by default with configured URL and safety attributes', () => {
    expect(BUY_ME_A_COFFEE_URL).toBe('https://buymeacoffee.com/vltge6001b');

    act(() => {
      root = createRoot(container);
      root.render(<SupportCard />);
    });

    const links = Array.from(container.querySelectorAll('a'));
    const coffeeLink = links.find(
      (a) => a.getAttribute('aria-label')?.includes('coffee') || a.textContent?.includes('coffee'),
    );

    expect(coffeeLink).toBeTruthy();
    expect(coffeeLink?.getAttribute('href')).toBe('https://buymeacoffee.com/vltge6001b');
    expect(coffeeLink?.getAttribute('target')).toBe('_blank');
    expect(coffeeLink?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(container.textContent).toContain('Buy me a coffee');
  });

  it('hides Buy Me a Coffee button when URL is empty or whitespace', () => {
    act(() => {
      root = createRoot(container);
      root.render(<SupportCard buyMeACoffeeUrl="" />);
    });

    const links = Array.from(container.querySelectorAll('a'));
    const coffeeLink = links.find(
      (a) => a.getAttribute('aria-label')?.includes('coffee') || a.textContent?.includes('coffee'),
    );

    expect(coffeeLink).toBeUndefined();
    expect(container.textContent).not.toContain('Buy me a coffee');
  });
});
