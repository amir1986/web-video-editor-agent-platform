const DB_NAME = "video-editor-db";
const DB_VERSION = 2;
const STORE_NAME = "project-state";
const FILES_STORE = "project-files";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
      if (!db.objectStoreNames.contains(FILES_STORE)) {
        db.createObjectStore(FILES_STORE);
      }
    };
    request.onsuccess = (e) => resolve((e.target as IDBOpenDBRequest).result);
    request.onerror = (e) => reject((e.target as IDBOpenDBRequest).error);
  });
}

export async function saveProjectState(state: unknown): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(state, "current");
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject((e.target as IDBTransaction).error);
  });
}

export async function loadProjectState(): Promise<unknown> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get("current");
    request.onsuccess = (e) => resolve((e.target as IDBRequest).result);
    request.onerror = (e) => reject((e.target as IDBRequest).error);
  });
}

export async function saveFile(clipId: string, file: File): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILES_STORE, "readwrite");
    tx.objectStore(FILES_STORE).put(file, clipId);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject((e.target as IDBTransaction).error);
  });
}

export async function loadFile(clipId: string): Promise<File | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILES_STORE, "readonly");
    const request = tx.objectStore(FILES_STORE).get(clipId);
    request.onsuccess = (e) => resolve((e.target as IDBRequest).result || null);
    request.onerror = (e) => reject((e.target as IDBRequest).error);
  });
}
