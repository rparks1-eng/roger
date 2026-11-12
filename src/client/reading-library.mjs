import { DOCUMENT_LIMITS } from '/client/documents.mjs';

const DATABASE = 'roger-readings';

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      request.result.createObjectStore('originals', { keyPath: 'id' });
      request.result.createObjectStore('work', { keyPath: 'id' });
    };
    request.onblocked = () => {
      blocked = true;
      reject(new Error('Close older Roger tabs and reload.'));
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      if (blocked) {
        database.close();
        return;
      }
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

function transact(database, mode, operation) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(['originals', 'work'], mode);
    const originals = transaction.objectStore('originals');
    const work = transaction.objectStore('work');
    let result, failure;
    const set = (value) => (result = value);
    const stop = (message) => {
      failure = new Error(message);
      transaction.abort();
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () =>
      reject(failure ?? transaction.error ?? new Error('Reading storage was interrupted.'));
    operation(originals, work, set, stop);
  });
}

export async function openReadingLibrary() {
  const database = await openDatabase();
  return {
    load() {
      return transact(database, 'readonly', (originals, work, set) => {
        const files = originals.getAll(undefined, DOCUMENT_LIMITS.files);
        const saved = work.getAll(undefined, DOCUMENT_LIMITS.files);
        saved.onsuccess = () => {
          const edits = new Map(saved.result.map((item) => [item.id, item]));
          set(
            files.result.map(({ file, ...original }) => ({
              ...original,
              ...edits.get(original.id),
              saved: true,
              url: original.isPdf ? URL.createObjectURL(file) : null,
            })),
          );
        };
      });
    },
    save(doc, file) {
      const { id, revision, title, text, pages, isPdf, kind } = doc;
      return transact(database, 'readwrite', (originals, _work, _set, stop) => {
        const existing = originals.getKey(id);
        existing.onsuccess = () => {
          if (existing.result) {
            stop('This reading was already saved in another Roger tab. Reload to open it.');
            return;
          }
          const count = originals.count();
          count.onsuccess = () => {
            if (count.result >= DOCUMENT_LIMITS.files)
              stop('The saved library holds eight readings.');
            else originals.add({ id, revision, title, text, pages, isPdf, kind, notes: '', file });
          };
        };
      });
    },
    update(id, patch) {
      return transact(database, 'readwrite', (originals, work, _set, stop) => {
        const exists = originals.getKey(id);
        exists.onsuccess = () => {
          if (!exists.result) {
            stop('This reading was removed in another Roger tab.');
            return;
          }
          const previous = work.get(id);
          previous.onsuccess = () => work.put({ ...previous.result, ...patch, id });
        };
      });
    },
    remove(id) {
      return transact(database, 'readwrite', (originals, work) => {
        originals.delete(id);
        work.delete(id);
      });
    },
    original(id) {
      return transact(database, 'readonly', (originals, _work, set) => {
        const read = originals.get(id);
        read.onsuccess = () => set(read.result?.file);
      });
    },
  };
}
