import { defineConfig } from 'vitest/config';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig(({ command }) => ({
  clearScreen: false,
  plugins: [tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  define: { __REVIEW_SERVE__: JSON.stringify(command === 'serve' && process.env.VITE_COMPANION_REVIEW === '1') },
  server: { host: '127.0.0.1', port: 1420, strictPort: true },
  build: { target: 'es2022', sourcemap: false, assetsInlineLimit: 0 },
  test: { environment: 'jsdom', include: ['test/frontend/**/*.test.ts'], restoreMocks: true },
}));
