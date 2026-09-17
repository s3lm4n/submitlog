import { isBuiltInExcludedContext } from '../security/page-exclusions';

export const STORAGE_KEY_GLOBAL_ENABLED = 'submitlog.globalEnabled';
export const STORAGE_KEY_DISABLED_SITES = 'submitlog.disabledSites';

export type ExtensionActiveState =
  'active' | 'global_paused' | 'site_disabled' | 'excluded_context';

/**
 * In-memory fallback and synchronous cache for environments where browser.storage is unavailable
 * or slow to initialize (e.g. unit tests or rapid checks).
 */
let cachedGlobalEnabled: boolean | null = null;
let cachedDisabledSites: Set<string> | null = null;

export function normalizeHostname(hostname: string): string {
  if (!hostname) return '';
  let clean = hostname.trim().toLowerCase();
  if (clean.includes('://')) {
    try {
      clean = new URL(clean).hostname.toLowerCase();
    } catch {
      clean = clean.replace(/^[a-z]+:\/\//, '');
    }
  }
  clean = clean.split('/')[0] || '';
  clean = clean.split(':')[0] || '';
  if (clean.startsWith('www.')) {
    clean = clean.slice(4);
  }
  return clean;
}

function getStorageApi() {
  const g = globalThis as unknown as {
    browser?: {
      storage?: {
        local?: {
          get: (keys: string | string[]) => Promise<Record<string, unknown>>;
          set: (obj: Record<string, unknown>) => Promise<void>;
        };
      };
    };
    chrome?: {
      storage?: {
        local?: {
          get: (
            keys: string | string[],
            cb?: (res: Record<string, unknown>) => void,
          ) => Promise<Record<string, unknown>> | undefined;
          set: (obj: Record<string, unknown>, cb?: () => void) => Promise<void> | undefined;
        };
      };
    };
  };
  return g.browser?.storage?.local || g.chrome?.storage?.local || null;
}

/**
 * Checks whether SubmitLog is globally enabled (not paused). Default: true.
 */
export async function isGlobalEnabled(): Promise<boolean> {
  const storage = getStorageApi();
  if (!storage) {
    return cachedGlobalEnabled !== null ? cachedGlobalEnabled : true;
  }
  try {
    const res = await new Promise<Record<string, unknown>>((resolve) => {
      const p = storage.get([STORAGE_KEY_GLOBAL_ENABLED], (items) => {
        if (items) resolve(items);
      });
      if (p && typeof (p as Promise<Record<string, unknown>>).then === 'function') {
        (p as Promise<Record<string, unknown>>).then(resolve).catch(() => resolve({}));
      }
    });
    const val = res[STORAGE_KEY_GLOBAL_ENABLED];
    const enabled = typeof val === 'boolean' ? val : true;
    cachedGlobalEnabled = enabled;
    return enabled;
  } catch {
    return cachedGlobalEnabled !== null ? cachedGlobalEnabled : true;
  }
}

/**
 * Updates the global enabled/paused state.
 */
export async function setGlobalEnabled(enabled: boolean): Promise<void> {
  cachedGlobalEnabled = enabled;
  const storage = getStorageApi();
  if (!storage) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    try {
      const p = storage.set({ [STORAGE_KEY_GLOBAL_ENABLED]: enabled }, () => {
        const lastErr = (globalThis as unknown as { chrome?: { runtime?: { lastError?: Error } } })
          .chrome?.runtime?.lastError;
        if (lastErr) {
          if (!settled) {
            settled = true;
            reject(new Error(lastErr.message || 'Storage write failed'));
          }
        } else if (!settled) {
          settled = true;
          resolve();
        }
      });
      if (p && typeof (p as Promise<void>).then === 'function') {
        (p as Promise<void>)
          .then(() => {
            if (!settled) {
              settled = true;
              resolve();
            }
          })
          .catch((err) => {
            if (!settled) {
              settled = true;
              reject(err);
            }
          });
      }
    } catch (err) {
      if (!settled) {
        settled = true;
        reject(err);
      }
    }
  });
}

/**
 * Retrieves the user-managed list of disabled sites (hostnames). Default: [].
 */
export async function getDisabledSites(): Promise<string[]> {
  const storage = getStorageApi();
  if (!storage) {
    return cachedDisabledSites ? Array.from(cachedDisabledSites) : [];
  }
  try {
    const res = await new Promise<Record<string, unknown>>((resolve) => {
      const p = storage.get([STORAGE_KEY_DISABLED_SITES], (items) => {
        if (items) resolve(items);
      });
      if (p && typeof (p as Promise<Record<string, unknown>>).then === 'function') {
        (p as Promise<Record<string, unknown>>).then(resolve).catch(() => resolve({}));
      }
    });
    const list = res[STORAGE_KEY_DISABLED_SITES];
    const sites = Array.isArray(list)
      ? list.map((s) => normalizeHostname(String(s))).filter(Boolean)
      : [];
    cachedDisabledSites = new Set(sites);
    return sites;
  } catch {
    return cachedDisabledSites ? Array.from(cachedDisabledSites) : [];
  }
}

/**
 * Checks whether a specific hostname is in the user's disabled sites list.
 */
export async function isSiteDisabled(hostname: string): Promise<boolean> {
  const norm = normalizeHostname(hostname);
  if (!norm) return false;
  const sites = await getDisabledSites();
  return sites.includes(norm);
}

/**
 * Adds or removes a hostname from the user-managed disabled sites list.
 */
export async function setSiteDisabled(hostname: string, disabled: boolean): Promise<void> {
  const norm = normalizeHostname(hostname);
  if (!norm) return;
  const current = await getDisabledSites();
  const set = new Set(current);
  if (disabled) {
    set.add(norm);
  } else {
    set.delete(norm);
  }
  const updated = Array.from(set);
  cachedDisabledSites = set;

  const storage = getStorageApi();
  if (!storage) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    try {
      const p = storage.set({ [STORAGE_KEY_DISABLED_SITES]: updated }, () => {
        const lastErr = (globalThis as unknown as { chrome?: { runtime?: { lastError?: Error } } })
          .chrome?.runtime?.lastError;
        if (lastErr) {
          if (!settled) {
            settled = true;
            reject(new Error(lastErr.message || 'Storage write failed'));
          }
        } else if (!settled) {
          settled = true;
          resolve();
        }
      });
      if (p && typeof (p as Promise<void>).then === 'function') {
        (p as Promise<void>)
          .then(() => {
            if (!settled) {
              settled = true;
              resolve();
            }
          })
          .catch((err) => {
            if (!settled) {
              settled = true;
              reject(err);
            }
          });
      }
    } catch (err) {
      if (!settled) {
        settled = true;
        reject(err);
      }
    }
  });
}

/**
 * Deterministic precedence:
 * 1. Global pause -> 'global_paused'
 * 2. Site user-disabled -> 'site_disabled'
 * 3. Built-in safety exclusion -> 'excluded_context'
 * 4. Normal active -> 'active'
 */
export async function getEffectiveState(
  hostname: string,
  pathname?: string,
): Promise<ExtensionActiveState> {
  // Precedence 1: Global Pause
  const globalOn = await isGlobalEnabled();
  if (!globalOn) {
    return 'global_paused';
  }

  // Precedence 2: User-managed Site Disable
  const siteOff = await isSiteDisabled(hostname);
  if (siteOff) {
    return 'site_disabled';
  }

  // Precedence 3: Built-in Safety Exclusion
  const excluded = isBuiltInExcludedContext({ hostname, pathname });
  if (excluded.isExcluded) {
    return 'excluded_context';
  }

  return 'active';
}

/**
 * For testing and test tear-downs: clears in-memory caches.
 */
export function resetSiteSettingsCache(): void {
  cachedGlobalEnabled = null;
  cachedDisabledSites = null;
}
