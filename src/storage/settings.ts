import { storage } from 'wxt/utils/storage';

export interface AppSettings {
  theme: 'system' | 'light' | 'dark';
}

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
};

export const appSettings = storage.defineItem<AppSettings>('local:settings', {
  defaultValue: DEFAULT_SETTINGS,
});
