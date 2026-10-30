import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base 使用相对路径：页面挂在 /_zhlx/admin/ 下，构建产物按当前路径解析。
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
