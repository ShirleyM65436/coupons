// views/backup.js - route #/backup: export, import and calendar export.
import { el, setHeader, toast, confirmDialog, icon } from '../ui.js';
import { getAllCards, getAllTransactions, getAllPhotos } from '../db.js';
import { isBackupOverdue, formatDate, toIsoDate } from '../model.js';
import { exportBackup, parseBackup, importBackup, getLastExportDate } from '../services/backup.js';
import { downloadExpiryIcs } from '../services/ics.js';

/** "3 Nov 2026 (4 days ago)" for an ISO timestamp, or "Never". */
function describeLastExport(iso) {
  if (!iso) return 'Never';
  const d = new Date(iso);
  if (isNaN(d)) return 'Never';
  const days = Math.max(0, Math.floor((Date.now() - d) / 86400000));
  const ago = days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  return `${formatDate(toIsoDate(d))} (${ago})`;
}

export async function render(container) {
  setHeader({ title: 'Backup', back: '#/' });

  // ---- live elements that get updated after actions
  const countsEl = el('p', { class: 'muted', 'data-testid': 'counts' });
  const persistEl = el('p', { class: 'muted small' });
  const lastExportEl = el('p', { 'data-testid': 'last-export' });
  const reminderSlot = el('div');
  const importError = el('p', { class: 'error-text', role: 'alert', hidden: true });
  const importSummary = el('div', { class: 'card stack', hidden: true });

  let cardCount = 0;

  /** Reload counts, last-export text and the reminder banner from the database. */
  async function refresh() {
    const [cards, txs, photos, last] = await Promise.all([getAllCards(), getAllTransactions(), getAllPhotos(), getLastExportDate()]);
    cardCount = cards.length;
    countsEl.textContent = `Stored on this device: ${cards.length} card${cards.length === 1 ? '' : 's'}, ${txs.length} transaction${txs.length === 1 ? '' : 's'}, ${photos.length} photo${photos.length === 1 ? '' : 's'}.`;
    lastExportEl.textContent = `Last export: ${describeLastExport(last)}`;
    reminderSlot.replaceChildren();
    if (cards.length && isBackupOverdue(last)) {
      reminderSlot.append(el('div', { class: 'banner banner-warn', role: 'status' }, icon('alert', 20),
        last ? 'It has been a while since your last backup. Please export a new one.' : 'You have not made a backup yet. Please export one.'));
    }
  }

  // ---- export
  const exportBtn = el('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: async () => {
    exportBtn.disabled = true;
    try {
      const { cardCount: n } = await exportBackup();
      toast(`Backup exported (${n} card${n === 1 ? '' : 's'})`, 'success');
      await refresh();
    } catch (err) {
      toast('Export failed: ' + (err?.message || err), 'error');
    } finally {
      exportBtn.disabled = false;
    }
  } }, icon('download'), 'Export backup');

  // ---- import
  const fileInput = el('input', { type: 'file', accept: 'application/json,.json', class: 'visually-hidden', 'data-testid': 'import-input' });
  const importLabel = el('label', { class: 'btn btn-block' }, icon('upload'), 'Import backup', fileInput);

  function showImportError(message) {
    importError.textContent = message;
    importError.hidden = false;
    importSummary.hidden = true;
    importSummary.replaceChildren();
    toast(message, 'error');
  }

  /** Confirm and run the import in the chosen mode. */
  async function runImport(parsed, mode) {
    const replace = mode === 'replace';
    const ok = await confirmDialog(
      replace
        ? 'All your current cards, transactions and photos will be deleted and replaced by the contents of this backup. This cannot be undone. Tip: export a backup of your current cards first.'
        : 'Cards from this backup will be added. Cards that already exist on this device are overwritten by the backup version.',
      { okLabel: replace ? 'Replace all' : 'Merge', danger: replace, title: replace ? 'Replace all cards?' : 'Merge backup?' },
    );
    if (!ok) return;
    try {
      const counts = await importBackup(parsed, mode);
      toast(`Imported ${counts.cards} card${counts.cards === 1 ? '' : 's'}`, 'success');
      importSummary.hidden = true;
      importSummary.replaceChildren();
      await refresh();
    } catch (err) {
      showImportError('Import failed: ' + (err?.message || err));
    }
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    importError.hidden = true;
    importSummary.hidden = true;
    importSummary.replaceChildren();
    if (!file) return;
    try {
      let parsed;
      try {
        parsed = parseBackup(await file.text());
      } catch (err) {
        showImportError(err.message);
        return;
      }
      const when = parsed.exportedAt && !isNaN(new Date(parsed.exportedAt)) ? formatDate(toIsoDate(new Date(parsed.exportedAt))) : 'unknown date';
      importSummary.replaceChildren(
        el('h3', {}, 'Backup file ready'),
        el('p', {}, `Exported: ${when}`),
        el('p', {}, `${parsed.cards.length} card${parsed.cards.length === 1 ? '' : 's'}, ${parsed.transactions.length} transaction${parsed.transactions.length === 1 ? '' : 's'}, ${parsed.photos.length} photo${parsed.photos.length === 1 ? '' : 's'}`),
        el('button', { class: 'btn btn-primary btn-block', type: 'button', 'data-testid': 'merge', onclick: () => runImport(parsed, 'merge') }, 'Merge with my cards'),
        el('button', { class: 'btn btn-danger btn-block', type: 'button', 'data-testid': 'replace', onclick: () => runImport(parsed, 'replace') }, 'Replace all my cards'),
      );
      importSummary.hidden = false;
    } finally {
      // Reset so choosing the same file again fires "change" again.
      fileInput.value = '';
    }
  });

  // ---- calendar
  const icsBtn = el('button', { class: 'btn btn-block', type: 'button', onclick: async () => {
    icsBtn.disabled = true;
    try {
      const n = await downloadExpiryIcs();
      if (!n) toast('No cards with an upcoming expiry date');
      else toast(`Calendar file with ${n} reminder${n === 1 ? '' : 's'} downloaded`, 'success');
    } catch (err) {
      toast('Could not create the calendar file: ' + (err?.message || err), 'error');
    } finally {
      icsBtn.disabled = false;
    }
  } }, icon('calendar'), 'Export expiry dates (.ics)');

  container.append(
    el('div', { class: 'stack' },
      el('section', { class: 'card stack' },
        el('h2', {}, 'Your data'),
        el('p', {}, 'Your cards are stored only in this browser on this device. Export a backup regularly and keep the file somewhere safe (e.g. cloud drive or email it to yourself).'),
        countsEl, persistEl),
      el('section', { class: 'card stack' },
        el('h2', {}, 'Export'),
        reminderSlot, lastExportEl, exportBtn),
      el('section', { class: 'card stack' },
        el('h2', {}, 'Import'),
        el('p', { class: 'muted' }, 'Restore cards from a backup file made by this app.'),
        importLabel, importError, importSummary),
      el('section', { class: 'card stack' },
        el('h2', {}, 'Calendar reminders'),
        el('p', { class: 'muted' }, 'Adds an event on each expiry date with reminders 30 and 7 days before. Open the file to add it to your calendar. Re-export after adding cards.'),
        icsBtn),
    ),
  );

  await refresh();
  // Storage persistence status (informational only).
  try {
    if (navigator.storage?.persisted) {
      const p = await navigator.storage.persisted();
      persistEl.textContent = p ? 'Browser storage is marked persistent.' : 'Browser storage may be cleared by the browser when the device is low on space, so keep backups.';
    }
  } catch { /* ignore */ }
}

/** Nothing to release. */
export function cleanup() {}
