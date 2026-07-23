import { defineConfig as define_config } from 'vite';

export default define_config({
  root: 'studio',
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
