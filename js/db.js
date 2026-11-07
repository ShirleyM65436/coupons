// db.js - all IndexedDB access lives here. Views and services never open
// IndexedDB themselves; they call these functions.
//
// Object stores (database "giftcards", version 1):
//   cards         keyPath "id"                      GiftCard records
//   transactions  keyPath "id", index "cardId"      Transaction records
//   photos        keyPath "id"                      { id, blob }  (blob = JPEG Blob)
//   meta          keyPath "key"                     { key, value } small settings, e.g. last export date
//
// Every function returns a Promise.

import { normalizeCard, newId } from './model.js';

const DB_NAME = 'giftcards';
const DB_VERSION = 1;

/** meta key: ISO timestamp of the last successful JSON export. */
export const META_LAST_EXPORT = 'lastExportAt';

let dbPromise = null;

/** Open (and create/upgrade if needed) the database. Cached after the first call. */
export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Version 1 schema. For future versions, add `if (event.oldVersion < 2) {...}` blocks.
      if (!db.objectStoreNames.contains('cards')) db.createObjectStore('cards', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('transactions')) {
        const tx = db.createObjectStore('transactions', { keyPath: 'id' });
        tx.createIndex('cardId', 'cardId', { unique: false });
      }
      if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

/** Turn an IDBRequest into a Promise. */
function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Run `work(stores)` inside one IndexedDB transaction and resolve when it commits.
 * `stores` is an object like { cards: IDBObjectStore, ... } for the requested names.
 */
async function withTx(storeNames, mode, work) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    const stores = {};
    for (const name of storeNames) stores[name] = tx.objectStore(name);
    let result;
    Promise.resolve(work(stores)).then((r) => { result = r; }, (err) => { tx.abort(); reject(err); });
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

// ---------------------------------------------------------------- cards

/** All cards, newest first (by createdAt). */
export async function getAllCards() {
  const cards = await withTx(['cards'], 'readonly', (s) => promisify(s.cards.getAll()));
  return cards.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

/** One card by id, or undefined. */
export function getCard(id) {
  return withTx(['cards'], 'readonly', (s) => promisify(s.cards.get(id)));
}

/**
 * Insert or update a card. Missing fields are filled by normalizeCard()
 * (a new id and createdAt are assigned if absent). Returns the saved card.
 * Does NOT validate - call validateCard() from model.js first.
 */
export async function putCard(card) {
  const clean = normalizeCard(card);
  await withTx(['cards'], 'readwrite', (s) => promisify(s.cards.put(clean)));
  return clean;
}

/** Delete a card together with all its transactions and its photo. */
export async function deleteCard(id) {
  const card = await getCard(id);
  await withTx(['cards', 'transactions', 'photos'], 'readwrite', async (s) => {
    s.cards.delete(id);
    const keys = await promisify(s.transactions.index('cardId').getAllKeys(id));
    for (const key of keys) s.transactions.delete(key);
    if (card?.photoId) s.photos.delete(card.photoId);
  });
}

// ---------------------------------------------------------------- transactions

/** Transactions of one card, newest date first. */
export async function getTransactions(cardId) {
  const list = await withTx(['transactions'], 'readonly', (s) => promisify(s.transactions.index('cardId').getAll(cardId)));
  return sortTransactions(list);
}

/** Every transaction of every card (used by the list view and backup). */
export async function getAllTransactions() {
  const list = await withTx(['transactions'], 'readonly', (s) => promisify(s.transactions.getAll()));
  return sortTransactions(list);
}

function sortTransactions(list) {
  // Newest date first; same date -> most recently created first.
  return list.sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || ''));
}

/**
 * Insert or update a transaction { id?, cardId, date, amount, note }.
 * Assigns id and createdAt if missing. Returns the saved transaction.
 * Does NOT validate - call validateTransaction() from model.js first.
 */
export async function putTransaction(tx) {
  const clean = {
    id: tx.id || newId(),
    cardId: tx.cardId,
    date: tx.date,
    amount: Number(tx.amount),
    note: tx.note ? String(tx.note).trim() : '',
    createdAt: tx.createdAt || new Date().toISOString(),
  };
  await withTx(['transactions'], 'readwrite', (s) => promisify(s.transactions.put(clean)));
  return clean;
}

export function deleteTransaction(id) {
  return withTx(['transactions'], 'readwrite', (s) => promisify(s.transactions.delete(id)));
}

// ---------------------------------------------------------------- photos

/** Store a photo Blob. Returns its id (pass `id` to overwrite an existing photo). */
export async function putPhoto(blob, id = newId()) {
  await withTx(['photos'], 'readwrite', (s) => promisify(s.photos.put({ id, blob })));
  return id;
}

/** The photo Blob for an id, or undefined. */
export async function getPhoto(id) {
  if (!id) return undefined;
  const rec = await withTx(['photos'], 'readonly', (s) => promisify(s.photos.get(id)));
  return rec?.blob;
}

export function deletePhoto(id) {
  return withTx(['photos'], 'readwrite', (s) => promisify(s.photos.delete(id)));
}

/** Every photo as [{ id, blob }] (used by backup). */
export function getAllPhotos() {
  return withTx(['photos'], 'readonly', (s) => promisify(s.photos.getAll()));
}

// ---------------------------------------------------------------- meta (small settings)

export async function getMeta(key) {
  const rec = await withTx(['meta'], 'readonly', (s) => promisify(s.meta.get(key)));
  return rec?.value;
}

export function setMeta(key, value) {
  return withTx(['meta'], 'readwrite', (s) => promisify(s.meta.put({ key, value })));
}

// ---------------------------------------------------------------- bulk (backup / restore)

/** Delete all cards, transactions and photos. Meta (e.g. last export date) is kept. */
export function clearAll() {
  return withTx(['cards', 'transactions', 'photos'], 'readwrite', (s) => {
    s.cards.clear();
    s.transactions.clear();
    s.photos.clear();
  });
}

/**
 * Write many records in ONE transaction (all succeed or nothing is written).
 * Records with an existing id are overwritten. Used by backup import.
 * @param {{cards?: object[], transactions?: object[], photos?: {id:string, blob:Blob}[]}} data
 */
export function importRecords({ cards = [], transactions = [], photos = [] }) {
  return withTx(['cards', 'transactions', 'photos'], 'readwrite', (s) => putAll(s, { cards, transactions, photos }));
}

/**
 * Delete all cards/transactions/photos and write the given records, in ONE transaction:
 * if anything fails (e.g. storage full), nothing is deleted. Meta is kept.
 * Used by backup import in "replace" mode.
 */
export function replaceAll({ cards = [], transactions = [], photos = [] }) {
  return withTx(['cards', 'transactions', 'photos'], 'readwrite', (s) => {
    s.cards.clear();
    s.transactions.clear();
    s.photos.clear();
    putAll(s, { cards, transactions, photos });
  });
}

/** Queue puts for many records on already-open stores (shared by importRecords/replaceAll). */
function putAll(s, { cards, transactions, photos }) {
  for (const c of cards) s.cards.put(normalizeCard(c));
  for (const t of transactions) s.transactions.put(t);
  for (const p of photos) s.photos.put({ id: p.id, blob: p.blob });
}

// ---------------------------------------------------------------- storage persistence

/**
 * Ask the browser not to evict our data under storage pressure.
 * Resolves true if storage is (now) persistent. Safe to call on every start.
 */
export async function requestPersistence() {
  if (!navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
