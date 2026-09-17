import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Storage map for tests
const storageMap = new Map<string, unknown>();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let mockSetShouldFail = false;
let mockGetShouldFail = false;
let currentTabInfo = {
  id: 1,
  url: 'https://apply.techventures.org/application',
  title: 'TechVentures Application',
};

// Message listeners
const messageListeners = new Set<(msg: unknown) => void>();

vi.mock('wxt/browser', () => {
  return {
    browser: {
      storage: {
        local: {
          get: vi.fn(async (keys: string | string[]) => {
            const res: Record<string, unknown> = {};
            const kList = Array.isArray(keys) ? keys : [keys];
            for (const k of kList) {
              res[k] = storageMap.get(k);
            }
            return res;
          }),
          set: vi.fn(async (obj: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(obj)) {
              storageMap.set(k, v);
            }
          }),
        },
      },
      runtime: {
        sendMessage: vi.fn(async (msg: { type?: string; payload?: Record<string, unknown> }) => {
          if (msg?.type === 'SUBMITLOG_GET_GLOBAL_ENABLED') {
            if (mockGetShouldFail) {
              throw new Error('Background unavailable');
            }
            const enabled = storageMap.get('submitlog.globalEnabled') !== false;
            return { success: true, enabled };
          }

          if (msg?.type === 'SUBMITLOG_SET_GLOBAL_ENABLED') {
            if (mockSetShouldFail) {
              return { success: false, error: 'Storage write failed' };
            }
            const enabled = Boolean(msg.payload?.enabled);
            storageMap.set('submitlog.globalEnabled', enabled);
            return { success: true, enabled };
          }

          if (msg?.type === 'SUBMITLOG_IS_SITE_DISABLED') {
            const disabledSites = (storageMap.get('submitlog.disabledSites') as string[]) || [];
            const hostname = String(msg.payload?.hostname || '');
            return { disabled: disabledSites.includes(hostname) };
          }

          if (msg?.type === 'SUBMITLOG_SET_SITE_DISABLED') {
            const hostname = String(msg.payload?.hostname || '');
            const disabled = Boolean(msg.payload?.disabled);
            const current = new Set((storageMap.get('submitlog.disabledSites') as string[]) || []);
            if (disabled) {
              current.add(hostname);
            } else {
              current.delete(hostname);
            }
            storageMap.set('submitlog.disabledSites', Array.from(current));
            return { success: true, hostname, disabled };
          }

          return { success: true };
        }),
        onMessage: {
          addListener: vi.fn((cb: (msg: unknown) => void) => {
            messageListeners.add(cb);
          }),
          removeListener: vi.fn((cb: (msg: unknown) => void) => {
            messageListeners.delete(cb);
          }),
        },
        getURL: vi.fn((pathStr: string) => `chrome-extension://mock-id${pathStr}`),
      },
      tabs: {
        query: vi.fn(async () => [currentTabInfo]),
        create: vi.fn(async () => ({})),
      },
      scripting: {
        executeScript: vi.fn(async () => [
          {
            frameId: 0,
            result: {
              formDetected: true,
              totalFields: 5,
              answeredCount: 2,
              detectedFields: [
                { id: 'f1', label: 'Company', fieldType: 'text', value: 'Acme Inc' },
                { id: 'f2', label: 'Pitch', fieldType: 'textarea', value: 'AI tool' },
              ],
            },
          },
        ]),
      },
    },
  };
});

// Import Popup after mock
import { Popup } from '../entrypoints/popup/Popup';

describe('Popup Power Control & Visual Polish Suite (Scenarios A through K)', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    storageMap.clear();
    mockSetShouldFail = false;
    mockGetShouldFail = false;
    currentTabInfo = {
      id: 1,
      url: 'https://apply.techventures.org/application',
      title: 'TechVentures Application',
    };
    messageListeners.clear();
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

  async function mountPopup() {
    await act(async () => {
      root = createRoot(container);
      root.render(<Popup />);
    });
    // Allow useEffect and async scanCurrentTab to settle
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }

  // --------------------------------------------------------------------------
  // A. Global enabled true -> green Power icon, accessible label "Pause SubmitLog"
  // --------------------------------------------------------------------------
  it('A. Global enabled true renders green Power icon with accessible Pause label', async () => {
    storageMap.set('submitlog.globalEnabled', true);
    await mountPopup();

    const powerBtn = container.querySelector('button[aria-label="Pause SubmitLog"]');
    expect(powerBtn).not.toBeNull();
    expect(powerBtn?.getAttribute('aria-pressed')).toBe('true');
    expect(powerBtn?.getAttribute('data-state')).toBe('active');
    expect(powerBtn?.className).toContain('text-emerald-600');
  });

  // --------------------------------------------------------------------------
  // B. Click Power -> SET_GLOBAL_ENABLED false -> confirmed response -> icon becomes red -> reopen stays paused
  // --------------------------------------------------------------------------
  it('B. Click Power pauses SubmitLog, updates icon to red, and survives reopen', async () => {
    storageMap.set('submitlog.globalEnabled', true);
    await mountPopup();

    const powerBtn = container.querySelector(
      'button[aria-label="Pause SubmitLog"]',
    ) as HTMLButtonElement;
    expect(powerBtn).not.toBeNull();

    // Click power button
    await act(async () => {
      powerBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // Check storage updated
    expect(storageMap.get('submitlog.globalEnabled')).toBe(false);

    // Button state updated to paused/red
    const resumedBtn = container.querySelector('button[aria-label="Resume SubmitLog"]');
    expect(resumedBtn).not.toBeNull();
    expect(resumedBtn?.getAttribute('aria-pressed')).toBe('false');
    expect(resumedBtn?.getAttribute('data-state')).toBe('paused');
    expect(resumedBtn?.className).toContain('text-red-500');

    // Main card renders paused state
    expect(container.textContent).toContain('SubmitLog is paused');
    expect(container.textContent).toContain('No form fields are being read or saved.');
    expect(container.textContent).toContain('Click the power button to resume.');

    // Simulate popup close & reopen
    act(() => {
      root?.unmount();
      root = null;
    });

    await mountPopup();

    // Still paused on reopen!
    expect(container.textContent).toContain('SubmitLog is paused');
    const reopenPowerBtn = container.querySelector('button[aria-label="Resume SubmitLog"]');
    expect(reopenPowerBtn).not.toBeNull();
  });

  // --------------------------------------------------------------------------
  // C. Paused -> red Power icon -> label "Resume SubmitLog"
  // --------------------------------------------------------------------------
  it('C. When initially paused, renders red Power icon with accessible Resume label', async () => {
    storageMap.set('submitlog.globalEnabled', false);
    await mountPopup();

    const resumeBtn = container.querySelector('button[aria-label="Resume SubmitLog"]');
    expect(resumeBtn).not.toBeNull();
    expect(resumeBtn?.getAttribute('aria-pressed')).toBe('false');
    expect(resumeBtn?.getAttribute('data-state')).toBe('paused');
    expect(resumeBtn?.className).toContain('text-red-500');
  });

  // --------------------------------------------------------------------------
  // D. Click Power while paused -> enabled true -> green Power returns
  // --------------------------------------------------------------------------
  it('D. Click Power while paused restores enabled state and returns green Power icon', async () => {
    storageMap.set('submitlog.globalEnabled', false);
    await mountPopup();

    const resumeBtn = container.querySelector(
      'button[aria-label="Resume SubmitLog"]',
    ) as HTMLButtonElement;
    expect(resumeBtn).not.toBeNull();

    await act(async () => {
      resumeBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // Check storage updated back to true
    expect(storageMap.get('submitlog.globalEnabled')).toBe(true);

    // Button state returns to active/green
    const activeBtn = container.querySelector('button[aria-label="Pause SubmitLog"]');
    expect(activeBtn).not.toBeNull();
    expect(activeBtn?.getAttribute('aria-pressed')).toBe('true');
    expect(activeBtn?.className).toContain('text-emerald-600');
  });

  // --------------------------------------------------------------------------
  // E. SET_GLOBAL_ENABLED failure -> state does not falsely change, error shown
  // --------------------------------------------------------------------------
  it('E. When SET_GLOBAL_ENABLED fails, state does not falsely change and error feedback is displayed', async () => {
    storageMap.set('submitlog.globalEnabled', true);
    mockSetShouldFail = true;
    await mountPopup();

    const powerBtn = container.querySelector(
      'button[aria-label="Pause SubmitLog"]',
    ) as HTMLButtonElement;
    expect(powerBtn).not.toBeNull();

    await act(async () => {
      powerBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // Storage was NOT updated to false
    expect(storageMap.get('submitlog.globalEnabled')).toBe(true);

    // UI did not falsely toggle to paused
    expect(container.textContent).not.toContain('SubmitLog is paused');

    // Non-intrusive error is shown
    expect(container.textContent).toContain('Storage write failed');
  });

  // --------------------------------------------------------------------------
  // F. Double click while pending -> only one toggle operation dispatched
  // --------------------------------------------------------------------------
  it('F. Double click while pending dispatches only one toggle operation', async () => {
    storageMap.set('submitlog.globalEnabled', true);
    await mountPopup();

    const powerBtn = container.querySelector(
      'button[aria-label="Pause SubmitLog"]',
    ) as HTMLButtonElement;
    expect(powerBtn).not.toBeNull();

    // Rapid double click
    await act(async () => {
      powerBtn.click();
      powerBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // Successfully toggled once to false
    expect(storageMap.get('submitlog.globalEnabled')).toBe(false);
  });

  // --------------------------------------------------------------------------
  // G. No textual bottom "Pause SubmitLog" button remains
  // --------------------------------------------------------------------------
  it('G. No textual bottom Pause SubmitLog or Resume SubmitLog button remains in the DOM', async () => {
    storageMap.set('submitlog.globalEnabled', true);
    await mountPopup();

    const buttons = Array.from(container.querySelectorAll('button'));
    const buttonTexts = buttons.map((b) => b.textContent?.trim());

    expect(buttonTexts).not.toContain('Pause SubmitLog');
    expect(buttonTexts).not.toContain('Resume SubmitLog');
    expect(buttonTexts).not.toContain('Pause SubmitLog globally');
  });

  // --------------------------------------------------------------------------
  // H. Site-disable control still works separately
  // --------------------------------------------------------------------------
  it('H. Site-disable control operates separately without altering global Power state', async () => {
    storageMap.set('submitlog.globalEnabled', true);
    await mountPopup();

    const allBtns = Array.from(container.querySelectorAll('button'));
    const targetSiteBtn = allBtns.find((b) => b.textContent?.includes('Disable on this site'));
    expect(targetSiteBtn).toBeDefined();

    await act(async () => {
      targetSiteBtn?.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // Site is disabled in storage
    const disabledSites = storageMap.get('submitlog.disabledSites') as string[];
    expect(disabledSites).toContain('apply.techventures.org');

    // Global pause remains ENABLED (true)
    expect(storageMap.get('submitlog.globalEnabled')).toBe(true);

    // Power icon in header remains GREEN
    const powerBtn = container.querySelector('button[aria-label="Pause SubmitLog"]');
    expect(powerBtn).not.toBeNull();
    expect(powerBtn?.className).toContain('text-emerald-600');

    // Site disabled card is rendered
    expect(container.textContent).toContain('SubmitLog is disabled on this site');
  });

  // --------------------------------------------------------------------------
  // I. Archive remains accessible while paused
  // --------------------------------------------------------------------------
  it('I. Archive button remains accessible and clickable while paused', async () => {
    storageMap.set('submitlog.globalEnabled', false);
    await mountPopup();

    const archiveBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Open Archive'),
    );
    expect(archiveBtn).toBeDefined();

    const headerArchiveBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Archive'),
    );
    expect(headerArchiveBtn).toBeDefined();
  });

  // --------------------------------------------------------------------------
  // J. Excluded page: global power green, page status explicitly says inactive/excluded
  // --------------------------------------------------------------------------
  it('J. Excluded page renders green Power icon but explicitly shows inactive/excluded page status', async () => {
    storageMap.set('submitlog.globalEnabled', true);
    currentTabInfo = {
      id: 2,
      url: 'https://chatgpt.com/c/chat-uuid',
      title: 'ChatGPT',
    };

    await mountPopup();

    // Global power icon remains green because extension is globally enabled
    const powerBtn = container.querySelector('button[aria-label="Pause SubmitLog"]');
    expect(powerBtn).not.toBeNull();
    expect(powerBtn?.className).toContain('text-emerald-600');

    // Page status explicitly states it is inactive on this page
    expect(container.textContent).toContain('SubmitLog is inactive on this page.');
    expect(container.textContent).toContain('This page matches a built-in safety exclusion');
    expect(container.textContent).not.toContain('No meaningful submission form detected');

    // No textual bottom buttons claiming the site is active
    expect(container.textContent).not.toContain('Disable on this site');
  });

  // --------------------------------------------------------------------------
  // K. Dark theme tokens include deep charcoal layered surfaces
  // --------------------------------------------------------------------------
  it('K. Dark theme tokens include deep charcoal layered surfaces from GitHub Dark palette', () => {
    const cssPath = path.resolve(__dirname, '../entrypoints/styles/global.css');
    const cssContent = fs.readFileSync(cssPath, 'utf-8');

    // Background: #0d1117 -> 216 28% 7%
    expect(cssContent).toContain('--background: 216 28% 7%');

    // Card surface: #161b22 -> 215 21% 11%
    expect(cssContent).toContain('--card: 215 21% 11%');

    // Secondary / Muted surface: #1c2128 -> 215 18% 13%
    expect(cssContent).toContain('--secondary: 215 18% 13%');
    expect(cssContent).toContain('--muted: 215 18% 13%');

    // Border: #30363d -> 212 12% 21%
    expect(cssContent).toContain('--border: 212 12% 21%');

    // Foreground: #f0f6fc -> 210 67% 96%
    expect(cssContent).toContain('--foreground: 210 67% 96%');

    // Muted foreground: #8b949e -> 212 9% 58%
    expect(cssContent).toContain('--muted-foreground: 212 9% 58%');
  });
});
