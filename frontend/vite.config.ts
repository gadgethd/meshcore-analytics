import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'deck': ['@deck.gl/core', '@deck.gl/layers', '@deck.gl/geo-layers', '@deck.gl/react'],
          'leaflet': ['leaflet', 'react-leaflet'],
          'react': ['react', 'react-dom'],
        },
      },
    },
  },
});
