import SparkMD5 from 'spark-md5';
import initSqlJs from 'sql.js';
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';

const IDB_NAME = 'scratchjr-web';
const IDB_STORE = 'kv';
const SQLITE_KEY = 'scratchjr.sqlite';

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function withBase(relPath) {
  const base = import.meta.env.BASE_URL || '/';
  const clean = String(relPath || '').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  const prefix = base.endsWith('/') ? base : `${base}/`;
  return `${prefix}${clean}`;
}

function syncGet(url) {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', url, false);
  xhr.send(null);
  if (xhr.status === 0 || xhr.status === 200) {
    return xhr.responseText;
  }
  return null;
}

function syncGetBinaryAsDataUri(url, mime) {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', url, false);
  xhr.overrideMimeType('text/plain; charset=x-user-defined');
  xhr.send(null);
  if (!(xhr.status === 0 || xhr.status === 200) || !xhr.responseText) {
    return null;
  }
  const text = xhr.responseText;
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    bytes[i] = text.charCodeAt(i) & 0xff;
  }
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

class DatabaseManager {
  constructor(SQL, savedBytes) {
    this.SQL = SQL;
    this.saveTimer = null;
    if (savedBytes && savedBytes.length) {
      this.db = new SQL.Database(savedBytes);
      this.runMigrations();
    } else {
      this.initTables();
      this.runMigrations();
    }
    this.db.handleError = this.handleError;
  }

  handleError(e) {
    console.warn('scratchjr db', e);
  }

  persistSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.save().catch((err) => console.warn('scratchjr save failed', err));
    }, 250);
  }

  async save() {
    const data = this.db.export();
    await idbSet(SQLITE_KEY, data);
  }

  initTables() {
    this.db = new this.SQL.Database();
    this.db.exec('CREATE TABLE IF NOT EXISTS PROJECTS (ID INTEGER PRIMARY KEY AUTOINCREMENT, CTIME DATETIME DEFAULT CURRENT_TIMESTAMP, MTIME DATETIME, ALTMD5 TEXT, POS INTEGER, NAME TEXT, JSON TEXT, THUMBNAIL TEXT, OWNER TEXT, GALLERY TEXT, DELETED TEXT, VERSION TEXT)');
    this.db.exec('CREATE TABLE IF NOT EXISTS USERSHAPES (ID INTEGER PRIMARY KEY AUTOINCREMENT, CTIME DATETIME DEFAULT CURRENT_TIMESTAMP, MD5 TEXT, ALTMD5 TEXT, WIDTH TEXT, HEIGHT TEXT, EXT TEXT, NAME TEXT, OWNER TEXT, SCALE TEXT, VERSION TEXT)');
    this.db.exec('CREATE TABLE IF NOT EXISTS USERBKGS (ID INTEGER PRIMARY KEY AUTOINCREMENT, CTIME DATETIME DEFAULT CURRENT_TIMESTAMP, MD5 TEXT, ALTMD5 TEXT, WIDTH TEXT, HEIGHT TEXT, EXT TEXT, OWNER TEXT,  VERSION TEXT)');
    this.db.exec('CREATE TABLE IF NOT EXISTS PROJECTFILES (MD5 TEXT PRIMARY KEY, CONTENTS TEXT)');
  }

  runMigrations() {
    try {
      this.db.exec('ALTER TABLE PROJECTS ADD COLUMN ISGIFT INTEGER DEFAULT 0');
    } catch (e) {
      // column already exists
    }
  }

  stmt(jsonStrOrJsonObj) {
    try {
      const json = (typeof jsonStrOrJsonObj === 'string') ? JSON.parse(jsonStrOrJsonObj) : jsonStrOrJsonObj || {};
      const statement = this.db.prepare(json.stmt);
      if (json.values) {
        statement.bind(json.values);
      }
      while (statement.step()) statement.get();
      statement.free();
      const result = this.db.exec('select last_insert_rowid();');
      this.persistSoon();
      return result[0].values[0][0];
    } catch (e) {
      console.warn('stmt failed', jsonStrOrJsonObj, e);
      return -1;
    }
  }

  query(jsonStrOrJsonObj) {
    try {
      const json = (typeof jsonStrOrJsonObj === 'string') ? JSON.parse(jsonStrOrJsonObj) : jsonStrOrJsonObj || {};
      const statement = this.db.prepare(json.stmt);
      if (json.values) {
        statement.bind(json.values);
      }
      const rows = [];
      while (statement.step()) {
        rows.push(statement.getAsObject());
      }
      statement.free();
      return rows;
    } catch (e) {
      console.warn('query failed', jsonStrOrJsonObj, e);
      return [];
    }
  }

  readProjectFile(fileMD5) {
    const rows = this.query({
      stmt: 'select CONTENTS from PROJECTFILES where MD5 = ?',
      values: [fileMD5],
    });
    return rows.length > 0 ? rows[0].CONTENTS : null;
  }

  removeProjectFile(fileMD5) {
    this.query({
      stmt: 'delete from PROJECTFILES where MD5 = ?',
      values: [fileMD5],
    });
    this.persistSoon();
  }

  saveToProjectFiles(fileMD5, content) {
    const result = this.stmt({
      stmt: 'insert or replace into projectfiles (md5, contents) values (?, ?)',
      values: [fileMD5, content],
    });
    return result >= 0;
  }

  cleanProjectFiles(fileType) {
    if (fileType === 'wav') {
      fileType = 'webm';
    }
    const allProjectFilesWithExtension = this.query({
      stmt: `select MD5 FROM PROJECTFILES WHERE MD5 LIKE "%.${fileType}"`,
    });
    for (let i = 0; i < allProjectFilesWithExtension.length; i++) {
      const currentFileToCheck = allProjectFilesWithExtension[i].MD5;
      if (!currentFileToCheck) continue;
      const projectJSON = this.query({
        stmt: `select ID from PROJECTS where json like "%${currentFileToCheck}%"`,
      });
      if (projectJSON.length > 0) continue;
      const shapeFiles = this.query({
        stmt: 'select MD5 from USERSHAPES where MD5 = ?',
        values: [currentFileToCheck],
      });
      if (shapeFiles.length > 0) continue;
      const bkgFiles = this.query({
        stmt: 'select MD5 from USERBKGS where MD5 = ?',
        values: [currentFileToCheck],
      });
      if (bkgFiles.length > 0) continue;
      this.removeProjectFile(currentFileToCheck);
    }
    this.persistSoon();
  }
}

export class WebScratchJrStore {
  constructor(databaseManager) {
    this.databaseManager = databaseManager;
    this.mediaStrings = {};
  }

  getMD5(data) {
    return SparkMD5.hash(data == null ? '' : String(data));
  }

  getDatabaseManager() {
    return this.databaseManager;
  }

  cacheMedia(key, encodedStr) {
    this.mediaStrings[key] = encodedStr;
  }

  getCachedMedia(key) {
    return this.mediaStrings[key];
  }

  removeFromMediaCache(key) {
    delete this.mediaStrings[key];
  }

  readProjectFileAsBase64EncodedString(filename) {
    return this.databaseManager.readProjectFile(filename);
  }

  removeProjectFile(filename) {
    this.databaseManager.removeProjectFile(filename);
  }

  writeProjectFile(file, contents) {
    if (this.databaseManager.saveToProjectFiles(file, contents)) {
      return file;
    }
    return -1;
  }

  getTextResource(filename) {
    const cleaned = String(filename || '').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
    return syncGet(withBase(cleaned));
  }

  getAudioDataUri(audioName) {
    const candidates = [audioName, `samples/${audioName}`, `sounds/${audioName}`];
    for (const rel of candidates) {
      const lower = rel.toLowerCase();
      const mime = lower.endsWith('.mp3') ? 'audio/mp3' : 'audio/wav';
      const uri = syncGetBinaryAsDataUri(withBase(rel.replace(/^\/+/, '')), mime);
      if (uri) return uri;
    }
    const fromDb = this.readProjectFileAsBase64EncodedString(audioName);
    if (!fromDb) return null;
    if (String(fromDb).startsWith('data:')) return fromDb;
    const ext = audioName.split('.').pop().toLowerCase();
    const mime = ext === 'mp3' ? 'audio/mp3' : ext === 'webm' ? 'audio/webm' : 'audio/wav';
    return `data:${mime};base64,${fromDb}`;
  }
}

export async function createWebStore() {
  const SQL = await initSqlJs({
    locateFile: () => sqlWasmUrl,
  });
  const saved = await idbGet(SQLITE_KEY);
  const bytes = saved ? new Uint8Array(saved) : null;
  const db = new DatabaseManager(SQL, bytes);
  return new WebScratchJrStore(db);
}
