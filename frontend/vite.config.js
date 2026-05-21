import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/pi-stream': {
        target: 'http://10.20.201.30:8080', //kindly edit the ip and put ip of your target system here and make sure you are connected to the same internet
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/pi-stream/, '/stream'),
      }
    }
  },
})
