import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.homlamoon.cafemanager',
  appName: 'Homlamoon Cafe',
  webDir: 'www',
  server: {
    url: 'http://192.168.1.35:5000',
    cleartext: true,
  },
  android: {
    allowMixedContent: true,
  },
};

export default config;
