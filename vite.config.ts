import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

// base: './' gives relative asset paths that work under any subpath on GitHub Pages.
// If you host at a custom domain root, change to '/'.
export default defineConfig({
  base: './',
  plugins: [basicSsl()],
  server: { https: true },
  build: {
    outDir: 'dist',
    target: 'es2020',
  },
})
