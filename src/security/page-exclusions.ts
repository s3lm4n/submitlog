/**
 * Built-in safety exclusion rules for non-application web contexts.
 *
 * Prevents SubmitLog from activating on:
 * 1. Search engine result pages and query bars (Google, Bing, DuckDuckGo, etc.)
 * 2. AI chat and conversational assistants (ChatGPT, Claude, Gemini, Copilot, etc.)
 * 3. Webmail and real-time chat/messaging interfaces (Gmail, Outlook Web, Slack, Discord, WhatsApp)
 * 4. Document, spreadsheet, slide, and design canvas editors (Google Docs/Sheets, Canva, Figma)
 * 5. Browser-based IDEs and code editors (GitHub Codespaces, Replit, StackBlitz)
 * 6. Dedicated authentication and payment checkout flows
 *
 * NOTE: This is NOT a blind top-100 website blocklist. It is a carefully scoped set of
 * hostname + route/context rules that complement generic structural heuristics.
 * Legitimate forms on major domains (e.g. Google Forms on docs.google.com/forms) are explicitly preserved.
 */

export type ExcludedCategory =
  'search' | 'ai-chat' | 'messaging' | 'editor' | 'code' | 'auth-payment';

export interface ExcludedContextResult {
  isExcluded: boolean;
  category?: ExcludedCategory;
  reason?: string;
}

export interface ExcludedContextOptions {
  hostname: string;
  pathname?: string;
  url?: string;
}

function normalizeHost(hostname: string): string {
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

function normalizePath(pathname?: string): string {
  if (!pathname) return '/';
  let clean = pathname.trim().toLowerCase();
  if (!clean.startsWith('/')) {
    clean = '/' + clean;
  }
  return clean;
}

/**
 * Evaluates whether the given hostname and pathname combination belongs to a built-in excluded context.
 */
export function isBuiltInExcludedContext(options: ExcludedContextOptions): ExcludedContextResult {
  const host = normalizeHost(options.hostname);
  const path = normalizePath(options.pathname);

  // --------------------------------------------------------------------------
  // 1. SEARCH: Search engines, search result pages, and query portals
  // --------------------------------------------------------------------------
  const isGoogleSearch =
    (host === 'google.com' || host.endsWith('.google.com')) &&
    host !== 'docs.google.com' &&
    (path === '/' ||
      path.startsWith('/search') ||
      path.startsWith('/webhp') ||
      path.startsWith('/imghp') ||
      path.startsWith('/maps'));

  const isBingSearch =
    (host === 'bing.com' || host.endsWith('.bing.com')) &&
    (path === '/' || path.startsWith('/search') || path.startsWith('/images'));

  const isDuckDuckGo = host === 'duckduckgo.com' || host.endsWith('.duckduckgo.com');
  const isYahooSearch =
    host === 'search.yahoo.com' || (host.includes('yahoo.com') && path.startsWith('/search'));
  const isBraveSearch = host === 'search.brave.com';
  const isKagiSearch = host === 'kagi.com';
  const isEcosia = host === 'ecosia.org' || host.endsWith('.ecosia.org');

  if (
    isGoogleSearch ||
    isBingSearch ||
    isDuckDuckGo ||
    isYahooSearch ||
    isBraveSearch ||
    isKagiSearch ||
    isEcosia
  ) {
    return {
      isExcluded: true,
      category: 'search',
      reason: 'Search engine query or results context',
    };
  }

  // Generic search result path on any website
  if (
    path === '/search' ||
    path.startsWith('/search/') ||
    path === '/results' ||
    path.startsWith('/results/')
  ) {
    return {
      isExcluded: true,
      category: 'search',
      reason: 'Generic search result page path',
    };
  }

  // --------------------------------------------------------------------------
  // 2. AI CHAT: Conversational AI prompt composers and assistant interfaces
  // --------------------------------------------------------------------------
  const AI_CHAT_HOSTS = [
    'chatgpt.com',
    'chat.openai.com',
    'claude.ai',
    'gemini.google.com',
    'copilot.microsoft.com',
    'perplexity.ai',
    'poe.com',
    'chat.mistral.ai',
    'chat.deepseek.com',
    'deepseek.com',
    'groq.com',
    'character.ai',
    'pi.ai',
    'you.com',
  ];

  if (AI_CHAT_HOSTS.some((h) => host === h || host.endsWith('.' + h))) {
    return {
      isExcluded: true,
      category: 'ai-chat',
      reason: 'Conversational AI / chatbot composer interface',
    };
  }

  // --------------------------------------------------------------------------
  // 3. WEBMAIL & MESSAGING: Mail composers and chat surfaces
  // --------------------------------------------------------------------------
  const MESSAGING_HOSTS = [
    'mail.google.com',
    'inbox.google.com',
    'outlook.live.com',
    'outlook.office.com',
    'outlook.office365.com',
    'mail.yahoo.com',
    'web.whatsapp.com',
    'discord.com',
    'app.slack.com',
    'slack.com',
    'teams.microsoft.com',
    'messenger.com',
    'web.telegram.org',
    'app.element.io',
  ];

  if (MESSAGING_HOSTS.some((h) => host === h || host.endsWith('.' + h))) {
    return {
      isExcluded: true,
      category: 'messaging',
      reason: 'Webmail or real-time messaging interface',
    };
  }

  // --------------------------------------------------------------------------
  // 4. DOCUMENT & DESIGN EDITORS: Document, spreadsheet, slide, and canvas editors
  // --------------------------------------------------------------------------
  // Google Docs suite: docs/sheets/slides/drawings are excluded; Google Forms is EXPLICITLY PRESERVED!
  if (host === 'docs.google.com') {
    if (path.startsWith('/forms')) {
      // Legitimate application/survey form - ALLOW!
      return { isExcluded: false };
    }
    if (
      path.startsWith('/document') ||
      path.startsWith('/spreadsheets') ||
      path.startsWith('/presentation') ||
      path.startsWith('/drawings')
    ) {
      return {
        isExcluded: true,
        category: 'editor',
        reason: 'Office document / sheet / slide editor',
      };
    }
  }

  const EDITOR_HOSTS = [
    'canva.com',
    'figma.com',
    'miro.com',
    'lucidchart.com',
    'excalidraw.com',
    'notion.so',
    'airtable.com',
    'coda.io',
    'mural.co',
  ];

  if (EDITOR_HOSTS.some((h) => host === h || host.endsWith('.' + h))) {
    return {
      isExcluded: true,
      category: 'editor',
      reason: 'Graphic design, whiteboard, or workspace document editor',
    };
  }

  // --------------------------------------------------------------------------
  // 5. CODE EDITORS: Browser IDEs and dev sandboxes
  // --------------------------------------------------------------------------
  const CODE_EDITOR_HOSTS = [
    'replit.com',
    'stackblitz.com',
    'codesandbox.io',
    'gitpod.io',
    'glitch.com',
    'codepen.io',
    'jsfiddle.net',
  ];

  if (
    CODE_EDITOR_HOSTS.some((h) => host === h || host.endsWith('.' + h)) ||
    (host === 'github.com' && path.startsWith('/codespaces'))
  ) {
    return {
      isExcluded: true,
      category: 'code',
      reason: 'In-browser IDE or code sandbox surface',
    };
  }

  // --------------------------------------------------------------------------
  // 6. DEDICATED AUTH & PAYMENT PORTALS
  // --------------------------------------------------------------------------
  const DEDICATED_AUTH_HOSTS = [
    'accounts.google.com',
    'login.microsoftonline.com',
    'appleid.apple.com',
    'auth0.com',
    'clerk.com',
    'okta.com',
    'auth.atlassian.com',
    'id.atlassian.com',
  ];

  if (DEDICATED_AUTH_HOSTS.some((h) => host === h || host.endsWith('.' + h))) {
    return {
      isExcluded: true,
      category: 'auth-payment',
      reason: 'Dedicated authentication portal',
    };
  }

  // Dedicated auth/payment endpoints on normal sites
  const AUTH_PAYMENT_PATHS =
    /^\/(login|signin|sign-in|authenticate|oauth|password-reset|forgot-password|reset-password|2fa|mfa|otp|checkout|pay|payment|stripe)\b/i;
  if (AUTH_PAYMENT_PATHS.test(path)) {
    return {
      isExcluded: true,
      category: 'auth-payment',
      reason: 'Dedicated authentication or payment checkout route',
    };
  }

  return { isExcluded: false };
}
