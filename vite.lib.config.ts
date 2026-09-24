import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

// Сборка библиотеки: ES-модуль + UMD (глобальная переменная `RrwebViewer`), CSS отдельным файлом.
export default defineConfig({
  plugins: [
    dts({
      tsconfigPath: 'tsconfig.lib.json',
      // В исходниках импорты с расширением `.ts`; в декларациях их нужно заменить на `.js`.
      beforeWriteFile: (filePath, content) => ({ filePath, content: content.replace(/(from\s+'\.[^']+)\.ts'/g, "$1.js'") }),
    }),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: 'src/index.ts',
      name: 'RrwebViewer',
      fileName: 'rrweb-viewer',
      cssFileName: 'rrweb-viewer',
      formats: ['es', 'umd'],
    },
  },
});
