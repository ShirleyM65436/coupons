// views/list.js - the home screen (#/): all gift cards with search, filters,
// an "expiring soon" banner and a gentle backup reminder.
import { el, icon, setHeader, headerButton, navigate } from '../ui.js';
import { getAllCards, getAllTransactions, getMeta, META_LAST_EXPORT } from '../db.js';
import {
  STATUS, computeBalance, cardStatus, statusLabel, formatMoney, formatDate,
  isExpiringSoon, daysUntil, isBackupOverdue,
} from '../model.js';

// Search text and filter live at module level so they survive a trip to a card
// detail page and back (the module stays loaded until the page is reloaded).
let searchText = '';
let filter = 'active';

const FILTERS = [
  ['active', 'Active'],
  ['used', 'Used up'],
  ['expired', 'Expired'],
  ['all', 'All'],
];

/** Sort order: active/expiring first, then expired, then used up. */
const GROUP_ORDER = { [STATUS.ACTIVE]: 0, [STATUS.EXPIRING]: 0, [STATUS.EXPIRED]: 1, [STATUS.USED]: 2 };

/** Does an item with this status belong to the selected filter? */
function matchesFilter(status) {
  if (filter === 'all') return true;
  if (filter === 'active') return status === STATUS.ACTIVE || status === STATUS.EXPIRING;
  return status === filter; // 'used' | 'expired'
}

/** Sort items: by group, then soonest expiry first (no expiry last), then merchant name. */
function compareItems(a, b) {
  const g = GROUP_ORDER[a.status] - GROUP_ORDER[b.status];
  if (g) return g;
  const ea = a.card.expiryDate || '9999-99-99';
  const eb = b.card.expiryDate || '9999-99-99';
  // Expired cards: most recently expired first reads more naturally.
  if (ea !== eb) return a.status === STATUS.EXPIRED ? (ea < eb ? 1 : -1) : (ea < eb ? -1 : 1);
  return a.card.merchant.localeCompare(b.card.merchant);
}

/** "5 days left" / "Expires today" */
function daysLeftText(days) {
  if (days === 0) return 'expires today';
  return days === 1 ? '1 day left' : `${days} days left`;
}

/** One card row (a link to the detail page). */
function cardRow({ card, balance, status }) {
  const expiry = card.expiryDate ? `Expires ${formatDate(card.expiryDate)}` : 'No expiry';
  return el('a', { class: `card list-card status-${status}`, href: `#/card/${card.id}` },
    el('div', { class: 'list-card-main' },
      el('div', { class: 'list-card-merchant' }, card.merchant),
      el('div', { class: 'list-card-expiry muted small' }, expiry),
    ),
    el('div', { class: 'list-card-side' },
      el('div', { class: 'list-card-balance' }, formatMoney(balance, card.currency)),
      el('span', { class: `badge badge-${status}` }, statusLabel(status)),
    ),
  );
}

/** Banner listing cards that still have money and expire within 30 days. */
function expiringBanner(items) {
  const soon = items
    .filter((i) => i.balance > 0 && isExpiringSoon(i.card))
    .sort((a, b) => a.card.expiryDate.localeCompare(b.card.expiryDate));
  if (!soon.length) return null;
  return el('div', { class: 'banner banner-warn list-banner', role: 'status' },
    icon('alert'),
    el('div', { class: 'grow' },
      el('strong', {}, 'Expiring soon'),
      el('ul', { class: 'list-plain list-expiring' },
        soon.map((i) => el('li', {},
          el('a', { class: 'list-expiring-link', href: `#/card/${i.card.id}` },
            el('span', {}, i.card.merchant),
            el('span', {}, daysLeftText(daysUntil(i.card.expiryDate))),
          ),
        )),
      ),
    ),
  );
}

/** Low-key reminder row linking to the backup screen. */
function backupReminder(lastExport) {
  let text = 'Last backup: never – back up now';
  if (lastExport) {
    const days = Math.floor((Date.now() - new Date(lastExport)) / 86400000);
    if (Number.isFinite(days)) text = `Last backup ${days} days ago – back up now`;
  }
  return el('a', { class: 'list-backup', href: '#/backup' }, icon('database', 20), el('span', {}, text));
}

/** Empty state when there are no cards at all. */
function emptyAll() {
  return el('div', { class: 'empty-state' },
    el('h2', {}, 'No gift cards yet'),
    el('p', {}, 'Scan a card to fill in the details automatically, or add one by hand.'),
    el('div', { class: 'list-empty-actions' },
      el('a', { class: 'btn btn-primary btn-block', href: '#/scan' }, icon('camera'), 'Scan card'),
      el('a', { class: 'btn btn-block', href: '#/add' }, icon('plus'), 'Add card'),
    ),
  );
}

export async function render(container, params) {
  setHeader({
    title: 'Gift Cards',
    back: false,
    actions: [headerButton('Backup', 'database', () => navigate('#/backup'))],
  });

  // Load everything once; searching and filtering below only touch memory.
  const [cards, transactions, lastExport] = await Promise.all([
    getAllCards(), getAllTransactions(), getMeta(META_LAST_EXPORT),
  ]);

  if (!cards.length) {
    container.append(emptyAll());
    return;
  }

  // Group transactions by card, then compute balance + status per card.
  const byCard = new Map();
  for (const tx of transactions) {
    if (!byCard.has(tx.cardId)) byCard.set(tx.cardId, []);
    byCard.get(tx.cardId).push(tx);
  }
  const items = cards.map((card) => {
    const balance = computeBalance(card, byCard.get(card.id) || []);
    return { card, balance, status: cardStatus(card, balance) };
  }).sort(compareItems);

  // --- static parts (not re-created while typing, so the input keeps focus)
  const summary = el('p', { class: 'list-summary muted small', 'aria-live': 'polite' });
  const listBox = el('div', { class: 'list-cards' });

  const searchInput = el('input', {
    id: 'list-search-input', type: 'search', placeholder: 'Search by merchant', 'aria-label': 'Search by merchant',
    value: searchText, autocomplete: 'off',
    oninput: (e) => { searchText = e.target.value; update(); },
  });

  const chipButtons = FILTERS.map(([key, label]) => el('button', {
    type: 'button', class: 'chip', 'aria-pressed': String(key === filter),
    onclick: () => { filter = key; update(); },
  }, label));

  /** Re-draw only the chips, summary and list from the in-memory items. */
  function update() {
    chipButtons.forEach((btn, i) => btn.setAttribute('aria-pressed', String(FILTERS[i][0] === filter)));

    const q = searchText.trim().toLowerCase();
    const shown = items.filter((i) => matchesFilter(i.status) && i.card.merchant.toLowerCase().includes(q));

    // Summary: count, plus total remaining balance per currency of the shown usable cards.
    const totals = new Map();
    for (const i of shown) {
      if (i.status === STATUS.ACTIVE || i.status === STATUS.EXPIRING) {
        totals.set(i.card.currency, (totals.get(i.card.currency) || 0) + i.balance);
      }
    }
    const totalText = [...totals].map(([cur, sum]) => formatMoney(sum, cur)).join(' + ');
    summary.textContent = `${shown.length} ${shown.length === 1 ? 'card' : 'cards'}` + (totalText ? ` · ${totalText} available` : '');

    if (!shown.length) {
      listBox.replaceChildren(el('div', { class: 'empty-state' },
        el('h2', {}, 'No cards match'),
        el('p', {}, 'Try a different search, or choose another filter such as "All".'),
      ));
    } else {
      listBox.replaceChildren(...shown.map(cardRow));
    }
  }

  container.append(
    el('div', { class: 'stack' },
      expiringBanner(items),
      el('a', { class: 'btn btn-primary btn-block list-scan', href: '#/scan' }, icon('camera'), 'Scan card'),
      el('div', { class: 'field list-search' },
        el('label', { class: 'visually-hidden', for: 'list-search-input' }, 'Search'),
        searchInput,
      ),
      el('div', { class: 'chips', role: 'group', 'aria-label': 'Filter cards' }, chipButtons),
      summary,
      listBox,
      isBackupOverdue(lastExport) ? backupReminder(lastExport) : null,
    ),
    el('a', { class: 'fab', href: '#/add', 'aria-label': 'Add card' }, icon('plus'), 'Add'),
  );
  update();
}

/** Nothing to release. */
export function cleanup() {}
