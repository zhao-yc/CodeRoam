import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 使用相对资源路径，让发行后的界面通过 Electron 本地文件加载。
export default defineConfig({
  base: './',
  plugins: [vue()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { host: '127.0.0.1', strictPort: true },
})
