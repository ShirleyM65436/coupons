// services/backup.js - JSON export / import of all gift card data.
// Contract and file format: ARCHITECTURE.md section 6.
//
// Design notes
// - parseBackup() is synchronous and validates EVERYTHING (including decoding every
//   photo from base64) so that a bad file is rejected before the database is touched.
// - Replace mode = db.replaceAll(): clearing and writing happen in ONE IndexedDB
//   transaction, so a failure (e.g. storage full) leaves the existing data untouched.
// - Photos in the file that no imported card references are NOT imported (orphans).
//   Cards pointing to a photo that is not available get photoId '' instead of a dangling id.
// - Merge: records with the same id are overwritten by the file's version; records only in the
//   database are kept.

import {
  getAllCards, getAllTransactions, getAllPhotos, getCard, getPhoto,
  getMeta, setMeta, importRecords, replaceAll, META_LAST_EXPORT,
} from '../db.js';
import { downloadFile } from '../ui.js';

export const BACKUP_SCHEMA_VERSION = 1;
const APP_ID = 'gift-card-tracker';

// ---------------------------------------------------------------- base64 helpers

/** Blob -> base64 string (no "data:" prefix). Chunked so big photos never overflow the call stack. */
export async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** base64 string -> Blob. Throws if the string is not valid base64. */
export function base64ToBlob(base64, type = 'application/octet-stream') {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

// ---------------------------------------------------------------- export

/** Local date as YYYY-MM-DD (for the file name). */
function localDateStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Build the full backup object (cards, transactions, photos as base64).
 * @returns {Promise<object>} see ARCHITECTURE.md "Backup file format"
 */
export async function buildBackup() {
  const [cards, transactions, photoRecords] = await Promise.all([getAllCards(), getAllTransactions(), getAllPhotos()]);
  const photos = [];
  for (const p of photoRecords) {
    photos.push({ id: p.id, type: p.blob.type || 'image/jpeg', data: await blobToBase64(p.blob) });
  }
  return {
    app: APP_ID,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    cards,
    transactions,
    photos,
  };
}

/**
 * Build the backup, download it as giftcards-backup-YYYY-MM-DD.json and record
 * the export time in meta (META_LAST_EXPORT).
 * @returns {Promise<{ filename: string, cardCount: number }>}
 */
export async function exportBackup() {
  const backup = await buildBackup();
  const filename = `giftcards-backup-${localDateStamp()}.json`;
  downloadFile(filename, JSON.stringify(backup), 'application/json');
  await setMeta(META_LAST_EXPORT, new Date().toISOString());
  return { filename, cardCount: backup.cards.length };
}

// ---------------------------------------------------------------- parse / validate

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Parse and validate a backup file's text. Throws an Error with a user-friendly
 * message if the file is not a valid backup or has a newer schema version.
 * Pure (no DOM, no database) so it can be unit-tested in Node.
 * @param {string} jsonText
 * @returns {{ schemaVersion: number, exportedAt: string, cards: object[], transactions: object[], photos: {id:string, blob:Blob}[] }}
 */
export function parseBackup(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    throw new Error('This file is not a gift card backup.');
  }
  if (!isObject(data) || data.app !== APP_ID || data.schemaVersion === undefined) {
    throw new Error('This file is not a gift card backup.');
  }
  if (!Number.isInteger(data.schemaVersion) || data.schemaVersion < 1) {
    throw new Error('This file is not a gift card backup.');
  }
  if (data.schemaVersion > BACKUP_SCHEMA_VERSION) {
    throw new Error(`This backup was made by a newer version of the app (schema ${data.schemaVersion}). Please update the app first.`);
  }

  const cards = data.cards ?? [];
  const transactions = data.transactions ?? [];
  const photosIn = data.photos ?? [];
  if (!Array.isArray(cards) || !Array.isArray(transactions) || !Array.isArray(photosIn)) {
    throw new Error('The backup is damaged: cards, transactions or photos are not lists.');
  }

  const cardIds = new Set();
  cards.forEach((c, i) => {
    const n = i + 1;
    if (!isObject(c)) throw new Error(`The backup is damaged: card #${n} is not valid.`);
    if (!isNonEmptyString(c.id)) throw new Error(`The backup is damaged: card #${n} has no id.`);
    if (!isNonEmptyString(c.merchant)) throw new Error(`The backup is damaged: card #${n} has no merchant.`);
    // Cards without `kind` (old backups) are money cards.
    if (c.kind !== undefined && c.kind !== 'MONEY' && c.kind !== 'VOUCHER') {
      throw new Error(`The backup is damaged: card #${n} has an unknown kind.`);
    }
    if (c.kind === 'VOUCHER') {
      // A voucher has no real amount (0 is fine) but must say what it is for.
      if (!Number.isInteger(c.originalAmount) || c.originalAmount < 0) {
        throw new Error(`The backup is damaged: card #${n} (${c.merchant}) has an invalid amount.`);
      }
      if (!isNonEmptyString(c.voucherItem)) {
        throw new Error(`The backup is damaged: card #${n} (${c.merchant}) is a voucher without a description.`);
      }
    } else if (!Number.isInteger(c.originalAmount) || c.originalAmount <= 0) {
      throw new Error(`The backup is damaged: card #${n} (${c.merchant}) has an invalid amount.`);
    }
    cardIds.add(c.id);
  });

  transactions.forEach((t, i) => {
    const n = i + 1;
    if (!isObject(t)) throw new Error(`The backup is damaged: transaction #${n} is not valid.`);
    if (!isNonEmptyString(t.id)) throw new Error(`The backup is damaged: transaction #${n} has no id.`);
    if (!isNonEmptyString(t.cardId)) throw new Error(`The backup is damaged: transaction #${n} has no card.`);
    if (!isNonEmptyString(t.date)) throw new Error(`The backup is damaged: transaction #${n} has no date.`);
    if (!Number.isInteger(t.amount)) throw new Error(`The backup is damaged: transaction #${n} has an invalid amount.`);
  });

  // Decode every photo now: a corrupt photo must fail here, before anything is written.
  const photos = photosIn.map((p, i) => {
    const n = i + 1;
    if (!isObject(p) || !isNonEmptyString(p.id)) throw new Error(`The backup is damaged: photo #${n} has no id.`);
    if (!isNonEmptyString(p.data)) throw new Error(`The backup is damaged: photo #${n} has no data.`);
    try {
      return { id: p.id, blob: base64ToBlob(p.data, typeof p.type === 'string' && p.type ? p.type : 'image/jpeg') };
    } catch {
      throw new Error(`The backup is damaged: photo #${n} could not be decoded.`);
    }
  });

  return {
    schemaVersion: data.schemaVersion,
    exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : '',
    cards,
    transactions,
    photos,
  };
}

// ---------------------------------------------------------------- import

/**
 * Write parsed backup data into the database.
 * 'replace' deletes all existing cards/transactions/photos first;
 * 'merge' keeps existing data and overwrites records with the same id.
 * @param {ReturnType<typeof parseBackup>} data
 * @param {'merge'|'replace'} mode
 * @returns {Promise<{ cards: number, transactions: number, photos: number }>} counts written
 */
export async function importBackup(data, mode) {
  if (mode !== 'merge' && mode !== 'replace') throw new Error('Unknown import mode.');
  const replace = mode === 'replace';

  const fileCardIds = new Set(data.cards.map((c) => c.id));
  const filePhotoIds = new Set(data.photos.map((p) => p.id));

  // Transactions: keep those whose card is in the file, or (merge) already in the database.
  const transactions = [];
  const dbCardChecks = new Map();
  for (const t of data.transactions) {
    let ok = fileCardIds.has(t.cardId);
    if (!ok && !replace) {
      if (!dbCardChecks.has(t.cardId)) dbCardChecks.set(t.cardId, !!(await getCard(t.cardId)));
      ok = dbCardChecks.get(t.cardId);
    }
    if (ok) {
      transactions.push({
        id: t.id,
        cardId: t.cardId,
        date: t.date,
        amount: t.amount,
        note: typeof t.note === 'string' ? t.note : '',
        createdAt: typeof t.createdAt === 'string' && t.createdAt ? t.createdAt : new Date().toISOString(),
      });
    }
  }

  // Cards: drop a photoId that points nowhere (not in the file, and not in the DB for merge).
  const cards = [];
  for (const c of data.cards) {
    let card = c;
    if (c.photoId && !filePhotoIds.has(c.photoId)) {
      const inDb = !replace && !!(await getPhoto(c.photoId));
      if (!inDb) card = { ...c, photoId: '' };
    }
    cards.push(card);
  }

  // Photos: only those referenced by an imported card (orphans are skipped).
  const usedPhotoIds = new Set(cards.map((c) => c.photoId).filter(Boolean));
  const photos = data.photos.filter((p) => usedPhotoIds.has(p.id));

  // Replace runs as one atomic transaction (db.replaceAll): if writing fails, the old data stays.
  if (replace) await replaceAll({ cards, transactions, photos });
  else await importRecords({ cards, transactions, photos });
  return { cards: cards.length, transactions: transactions.length, photos: photos.length };
}

/** ISO timestamp of the last export, or null if never exported. */
export async function getLastExportDate() {
  return (await getMeta(META_LAST_EXPORT)) ?? null;
}
