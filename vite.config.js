import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    // 确保资源使用相对路径，支持离线使用
    assetsDir: 'assets',
    // 禁用外部资源
    rollupOptions: {
      external: []
    }
  },
  server: {
    port: 5173,
    strictPort: true
  }
});
