import { defineConfig } from 'vite'

// base: './' gives relative asset paths that work under any subpath on GitHub Pages.
// If you host at a custom domain root, change to '/'.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2020',
  },
})
