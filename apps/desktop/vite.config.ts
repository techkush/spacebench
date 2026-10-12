import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { ngspiceDev } from './vite-ngspice.ts'
import { claudeDev } from './vite-claude.ts'
import { arduinoDev } from './vite-arduino.ts'
import { esp32Dev } from './vite-esp32.ts'
import { linuxDev } from './vite-linux.ts'
import { renodeDev } from './vite-renode.ts'

// Tauri expects a fixed dev port and must not clear its own terminal output.
export default defineConfig({
  plugins: [react(), tailwindcss(), ngspiceDev(), claudeDev(), arduinoDev(), esp32Dev(), linuxDev(), renodeDev()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  clearScreen: false,
  // the Rust side (and Tauri's generated schemas) rebuilds don't reload the page
  server: { port: 5173, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
})
