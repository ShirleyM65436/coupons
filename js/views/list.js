// views/list.js - the home screen (#/): all gift cards with search, filters,
// an "expiring soon" banner and a gentle backup reminder.
import { el, icon, setHeader, headerButton, navigate } from '../ui.js';
import { getAllCards, getAllTransactions, getMeta, META_LAST_EXPORT } from '../db.js';
import {
  STATUS, computeBalance, cardStatus, statusLabel, formatMoney, formatDate,
  isExpiringSoon, daysUntil, isBackupOverdue, isVoucher, hasValueLeft,
} from '../model.js';

// Search text and filter live at module level so they survive a trip to a card
// detail page and back (the module stays loaded until the page is reloaded).
let searchText = '';
let filter = 'active';

// "cards" (one row per card) or "merchants" (one row per merchant). Also saved in
// localStorage so the choice survives a reload; storage can be blocked, so never throw.
const MODE_KEY = 'giftcards.listMode';
function loadMode() {
  try { return localStorage.getItem(MODE_KEY) === 'merchants' ? 'merchants' : 'cards'; } catch { return 'cards'; }
}
function saveMode(mode) {
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* storage unavailable: keep in memory only */ }
}
let listMode = loadMode();
// Merchant (lower-case key) currently opened in "By merchant" mode, or '' for the group rows.
let drilled = '';

/** Case-insensitive, trimmed grouping key for a merchant name. */
const merchantKey = (card) => card.merchant.trim().toLowerCase();

/** "1 card" / "3 cards" */
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Sum what is still usable in a list of items, per currency (money cards that are
 * active or expiring; expired and used-up money does not count). Vouchers are counted.
 */
function summarize(list) {
  const totals = new Map();
  let vouchers = 0, expiring = 0, money = 0;
  for (const i of list) {
    if (i.status === STATUS.EXPIRING) expiring++;
    if (isVoucher(i.card)) { vouchers++; continue; }
    money++;
    if (i.status === STATUS.ACTIVE || i.status === STATUS.EXPIRING) {
      totals.set(i.card.currency, (totals.get(i.card.currency) || 0) + i.balance);
    }
  }
  const totalText = [...totals].map(([cur, sum]) => formatMoney(sum, cur)).join(' + ');
  const sum = [...totals.values()].reduce((a, b) => a + b, 0);
  return { totalText, sum, vouchers, expiring, money };
}

/** Build merchant groups from the filtered items, biggest available total first. */
function buildGroups(list) {
  const map = new Map(); // key -> { key, spellings: Map(name -> count), items }
  for (const i of list) {
    const key = merchantKey(i.card);
    if (!map.has(key)) map.set(key, { key, spellings: new Map(), items: [] });
    const g = map.get(key);
    g.items.push(i);
    const name = i.card.merchant.trim();
    g.spellings.set(name, (g.spellings.get(name) || 0) + 1);
  }
  const groups = [...map.values()].map((g) => {
    // Most common spelling wins; Map keeps insertion order, so ties go to the first seen.
    let name = '', best = 0;
    for (const [n, c] of g.spellings) if (c > best) { name = n; best = c; }
    return { key: g.key, name, items: g.items, ...summarize(g.items) };
  });
  return groups.sort((a, b) => (b.sum - a.sum) || a.name.localeCompare(b.name));
}

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
      card.owner ? el('div', { class: 'list-card-owner small' }, card.owner) : null,
      el('div', { class: 'list-card-expiry muted small' }, expiry),
    ),
    el('div', { class: 'list-card-side' },
      // Vouchers show what they are for (and a "Voucher" tag) instead of a balance.
      isVoucher(card)
        ? el('div', { class: 'list-card-voucher' },
          el('span', { class: 'list-card-item' }, card.voucherItem),
          el('span', { class: 'list-voucher-tag' }, 'Voucher'))
        : el('div', { class: 'list-card-balance' }, formatMoney(balance, card.currency)),
      el('span', { class: `badge badge-${status}` }, statusLabel(status, card)),
    ),
  );
}

/** Banner listing cards that still have money (or an unused voucher) and expire within 30 days. */
function expiringBanner(items) {
  const soon = items
    .filter((i) => hasValueLeft(i.card, i.balance) && isExpiringSoon(i.card))
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
    id: 'list-search-input', type: 'search', placeholder: 'Search merchant or owner', 'aria-label': 'Search by merchant or owner',
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
    // Search matches the merchant or the owner (case-insensitive).
    const matchesSearch = (card) => card.merchant.toLowerCase().includes(q) || (card.owner || '').toLowerCase().includes(q);
    const shown = items.filter((i) => matchesFilter(i.status) && matchesSearch(i.card));

    modeRadios.forEach((r) => { r.checked = r.value === listMode; });

    const noMatch = () => el('div', { class: 'empty-state' },
      el('h2', {}, 'No cards match'),
      el('p', {}, 'Try a different search, or choose another filter such as "All".'),
    );

    // Summary: count, plus total remaining balance per currency of the shown usable cards.
    // Money totals count money cards only; vouchers are just counted.
    const describe = (s, head) => head
      + (s.totalText ? ` · ${s.totalText} available` : '')
      + (s.vouchers ? ` · ${plural(s.vouchers, 'voucher')}` : '');

    if (listMode === 'cards') {
      summary.textContent = describe(summarize(shown), plural(shown.length, 'card'));
      listBox.replaceChildren(...(shown.length ? shown.map(cardRow) : [noMatch()]));
      return;
    }

    // --- "By merchant" mode
    const groups = buildGroups(shown);
    const open = drilled ? groups.find((g) => g.key === drilled) : null;

    if (drilled) {
      // Drill-down: a header bar with a back control, then the normal card rows.
      // If the filters removed every card of this merchant, keep the bar and show the empty state.
      const name = open ? open.name : (items.find((i) => merchantKey(i.card) === drilled)?.card.merchant.trim() || '');
      summary.textContent = open ? describe(open, plural(open.items.length, 'card')) : '0 cards';
      listBox.replaceChildren(
        el('div', { class: 'list-drill' },
          el('button', { type: 'button', class: 'btn list-drill-back', onclick: () => { drilled = ''; update(); } }, '← All merchants'),
          el('div', { class: 'list-drill-title' },
            el('div', { class: 'list-card-merchant' }, name),
            open ? el('div', { class: 'list-group-total' }, groupTotal(open)) : null),
        ),
        ...(open ? open.items.map(cardRow) : [noMatch()]),
      );
      return;
    }

    summary.textContent = describe(summarize(shown), plural(groups.length, 'merchant'));
    listBox.replaceChildren(...(groups.length ? groups.map(groupRow) : [noMatch()]));
  }

  /** What the group row/header shows as its amount: money available, or the voucher count. */
  function groupTotal(g) {
    if (g.money) return `${g.totalText || formatMoney(0)} available`;
    return plural(g.vouchers, 'voucher');
  }

  /** One merchant row: name, available total, "6 cards · 2 vouchers". Opens the drill-down. */
  function groupRow(g) {
    const parts = [plural(g.items.length, 'card')];
    if (g.vouchers && g.money) parts.push(plural(g.vouchers, 'voucher'));
    // A voucher-only group already says "2 vouchers" as its main text, so show plain count there.
    const detail = g.money ? parts.join(' · ') : '';
    return el('button', {
      type: 'button', class: `card list-card list-group${g.expiring ? ' status-expiring' : ''}`,
      onclick: () => { drilled = g.key; update(); window.scrollTo(0, 0); },
    },
      el('div', { class: 'list-card-main' },
        el('div', { class: 'list-card-merchant' }, g.name),
        detail ? el('div', { class: 'muted small' }, detail) : null,
        g.expiring ? el('div', { class: 'small list-group-warn' }, `${g.expiring} expiring soon`) : null,
      ),
      el('div', { class: 'list-card-side' },
        el('div', { class: 'list-card-balance' }, g.money ? (g.totalText || formatMoney(0)) : plural(g.vouchers, 'voucher')),
        g.money ? el('span', { class: 'small muted' }, 'available') : null,
        g.money ? null : el('span', { class: 'small muted' }, plural(g.items.length, 'card')),
      ),
    );
  }

  // Cards | By merchant toggle (radios inside the shared .segmented component).
  const modeRadios = [['cards', 'Cards', 'mode-cards'], ['merchants', 'By merchant', 'mode-merchant']].map(([value, , id]) =>
    el('input', {
      type: 'radio', name: 'list-mode', id, value, checked: value === listMode,
      onchange: () => { listMode = value; saveMode(value); if (value === 'cards') drilled = ''; update(); },
    }));
  const modeToggle = el('div', { class: 'segmented list-mode', role: 'radiogroup', 'aria-label': 'List view' },
    el('label', {}, modeRadios[0], el('span', {}, 'Cards')),
    el('label', {}, modeRadios[1], el('span', {}, 'By merchant')),
  );

  container.append(
    el('div', { class: 'stack' },
      expiringBanner(items),
      el('a', { class: 'btn btn-primary btn-block list-scan', href: '#/scan' }, icon('camera'), 'Scan card'),
      modeToggle,
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
