import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
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

    return baseManifest;
  },
});
