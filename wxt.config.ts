import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        '@/components': path.resolve(__dirname, './src/components'),
        '@/lib': path.resolve(__dirname, './src/lib'),
        '@': path.resolve(__dirname, '.'),
      },
    },
  }),
  manifest: ({ browser }) => {
    const baseManifest = {
      name: 'SubmitLog',
      description:
        'Never forget what you submitted. A local-first, privacy-first archive for web form submissions.',
      permissions: ['activeTab', 'scripting', 'storage'],
      action: {
        default_title: 'SubmitLog - Capture form submission',
      },
    };

    if (browser === 'firefox') {
      return {
        ...baseManifest,
        permissions: ['activeTab', 'scripting', 'storage', 'http://*/*', 'https://*/*'],
        browser_specific_settings: {
          gecko: {
            id: 'submitlog@s3lm4n.github.io',
            data_collection_permissions: {
              required: ['none'],
            },
          },
        },
      };
    }

    return {
      ...baseManifest,
      host_permissions: ['http://*/*', 'https://*/*'],
    };
  },
});
