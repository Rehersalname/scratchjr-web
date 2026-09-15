import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const appAssets = path.resolve(repoRoot, 'desktop-src/src/app');
const distDir = path.resolve(__dirname, 'dist');

const ASSET_DIRS = [
  'assets',
  'css',
  'inapp',
  'localizations',
  'pnglibrary',
  'samples',
  'sounds',
  'svglibrary',
];
const ASSET_FILES = ['settings.json', 'media.json'];

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function isAllowedAsset(rel) {
  if (ASSET_FILES.includes(rel)) return true;
  return ASSET_DIRS.some((dir) => rel === dir || rel.startsWith(`${dir}/`));
}

function safeAssetPath(rel) {
  const resolved = path.resolve(appAssets, rel);
  const root = appAssets.endsWith(path.sep) ? appAssets : appAssets + path.sep;
  if (resolved !== appAssets && !resolved.startsWith(root)) return null;
  return resolved;
}

function scratchJrAssets() {
  return {
    name: 'scratchjr-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = decodeURIComponent((req.url || '').split('?')[0]);
        const rel = url.replace(/^\/+/, '');
        if (!isAllowedAsset(rel)) return next();
        const file = safeAssetPath(rel);
        if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return next();
        const ext = path.extname(file).toLowerCase();
        res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
        fs.createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      for (const dir of ASSET_DIRS) {
        const from = path.join(appAssets, dir);
        const to = path.join(distDir, dir);
        if (fs.existsSync(from)) {
          fs.cpSync(from, to, {recursive: true});
        }
      }
      for (const name of ASSET_FILES) {
        const from = path.join(appAssets, name);
        if (fs.existsSync(from)) {
          fs.copyFileSync(from, path.join(distDir, name));
        }
      }
    },
  };
}

export default defineConfig({
  root: __dirname,
  base: process.env.BASE_PATH || '/',
  publicDir: path.resolve(__dirname, 'hosting-public'),
  define: {
    global: 'globalThis',
  },
  resolve: {
    alias: {
      snapsvg: path.resolve(__dirname, 'node_modules/snapsvg-cjs'),
      jszip: path.resolve(__dirname, 'node_modules/jszip'),
      intl: path.resolve(__dirname, 'node_modules/intl'),
      'intl-messageformat': path.resolve(__dirname, 'node_modules/intl-messageformat'),
    },
  },
  optimizeDeps: {
    include: [
      'jszip',
      'intl',
      'intl-messageformat',
      'sql.js',
      'spark-md5',
      'snapsvg-cjs',
    ],
    esbuildOptions: {
      define: {
        global: 'globalThis',
      },
    },
  },
  plugins: [scratchJrAssets()],
  server: {
    port: 5173,
    fs: {
      allow: [repoRoot],
    },
  },
  preview: {
    port: 4173,
  },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        home: path.resolve(__dirname, 'home.html'),
        editor: path.resolve(__dirname, 'editor.html'),
        gettingstarted: path.resolve(__dirname, 'gettingstarted.html'),
      },
    },
  },
});
