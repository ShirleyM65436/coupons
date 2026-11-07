// views/detail.js - card detail: summary, details, photo, transactions, delete card.
// Route: #/card/:id  (see ARCHITECTURE.md section 9 "C").
//
// Structure: render() builds the page once. The parts that depend on the balance
// (summary + transactions) live in their own containers and are re-rendered by
// refresh() after a transaction is added/deleted, so the page never reloads.
// The "details" section is built once so a revealed PIN stays revealed.

import {
  el, icon, setHeader, headerButton, navigate, toast, confirmDialog, showDialog, copyToClipboard,
} from '../ui.js';
import {
  getCard, getTransactions, putTransaction, deleteTransaction, deleteCard, getPhoto, putCard,
} from '../db.js';
import {
  isVoucher, computeBalance, cardStatus, statusLabel, formatMoney, formatDate, daysUntil, todayIso,
  parseAmountInput, validateTransaction, CARD_TYPES,
} from '../model.js';

// Object URLs created for the photo; revoked in cleanup().
let objectUrls = [];
// Incremented on every render/cleanup so late async work from an old render is ignored.
let renderToken = 0;

/** Release object URLs. Synchronous, never throws. */
export function cleanup() {
  renderToken++;
  for (const url of objectUrls) {
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
  }
  objectUrls = [];
}

/** Render the view into container. params: { id } */
export async function render(container, params) {
  cleanup();
  const token = renderToken;
  const card = await getCard(params.id);
  if (token !== renderToken) return; // user already navigated away

  // ---- unknown id -> empty state
  if (!card) {
    setHeader({ title: 'Card', back: '#/' });
    container.append(el('div', { class: 'empty-state' },
      el('h2', {}, 'Card not found'),
      el('p', {}, 'This card does not exist (anymore).'),
      el('a', { class: 'btn btn-primary', href: '#/' }, 'Back to my cards'),
    ));
    return;
  }

  setHeader({
    title: card.merchant,
    back: '#/',
    actions: [headerButton('Edit card', 'edit', () => navigate(`#/card/${card.id}/edit`))],
  });

  // Vouchers never have transactions.
  const voucher = isVoucher(card);
  let transactions = voucher ? [] : await getTransactions(card.id);
  if (token !== renderToken) return;

  // Containers for the parts that change after add/delete (or after marking a voucher used).
  const summaryBox = el('section', { class: 'card detail-summary stack-small' });
  const txBox = el('section', { class: voucher ? 'card stack detail-voucher-action' : 'card stack detail-transactions' });
  const detailsBox = buildDetails(card);
  const photoBox = el('div', {});

  /** Re-render balance-dependent parts. `focus` = selector to focus afterwards. */
  function draw(focus) {
    const balance = computeBalance(card, transactions);
    summaryBox.replaceChildren(...buildSummary(card, balance));
    if (voucher) txBox.replaceChildren(buildVoucherAction(card, onToggleUsed));
    else txBox.replaceChildren(...buildTransactions(card, transactions, balance, onAdd, onDelete));
    if (focus) txBox.querySelector(focus)?.focus();
  }

  /** Voucher: mark as used today / back to not used. Saves, then redraws without reloading. */
  async function onToggleUsed() {
    const previous = card.usedAt;
    card.usedAt = previous ? '' : todayIso();
    try {
      await putCard(card);
    } catch {
      card.usedAt = previous; // undo the in-memory change
      toast('Could not save the change', 'error');
      return;
    }
    toast(card.usedAt ? 'Marked as used' : 'Marked as not used', 'success');
    draw('.detail-voucher-btn');
  }

  /** Reload transactions from the DB and redraw. */
  async function refresh(focus) {
    transactions = await getTransactions(card.id);
    if (token !== renderToken) return;
    draw(focus);
  }

  async function onAdd(tx) {
    await putTransaction({ cardId: card.id, date: tx.date, amount: tx.amount, note: tx.note });
    toast('Transaction added', 'success');
    await refresh('[name="amount"]:not([disabled])');
    // Form is disabled when the card is used up; focus the list heading instead.
    if (!txBox.contains(document.activeElement)) txBox.querySelector('h2')?.focus();
  }

  async function onDelete(tx) {
    const ok = await confirmDialog(
      `Delete the transaction of ${formatMoney(tx.amount, card.currency)}${tx.note ? ` (${tx.note})` : ''}?`,
      { danger: true, okLabel: 'Delete' });
    if (!ok) return;
    await deleteTransaction(tx.id);
    toast('Transaction deleted', 'success');
    await refresh('.detail-transactions h2');
  }

  draw();

  // ---- danger zone
  const dangerZone = el('section', { class: 'detail-danger stack-small' },
    el('button', {
      class: 'btn btn-danger btn-block', type: 'button', onclick: async () => {
        const ok = await confirmDialog(
          `Delete ${card.merchant}? This also deletes its transactions and photo. This cannot be undone.`,
          { danger: true, okLabel: 'Delete' });
        if (!ok) return;
        await deleteCard(card.id);
        toast('Card deleted', 'success');
        navigate('#/');
      },
    }, icon('trash'), 'Delete card'),
  );

  container.append(
    el('div', { class: 'stack' },
      summaryBox, buildActions(card), photoBox, detailsBox, txBox, dangerZone),
  );

  // ---- photo thumbnail (loaded after first paint of the rest)
  if (card.photoId) {
    try {
      const blob = await getPhoto(card.photoId);
      if (token !== renderToken) return;
      if (blob) {
        const url = URL.createObjectURL(blob);
        objectUrls.push(url);
        photoBox.append(el('button', {
          class: 'detail-photo', type: 'button', 'aria-label': 'Show photo of the card',
          onclick: () => showDialog(el('img', { style: 'width:100%;max-height:70vh;object-fit:contain', src: url, alt: `Photo of ${card.merchant} card` })),
        }, el('img', { src: url, alt: `Photo of ${card.merchant} card` })));
      }
    } catch { /* a missing photo is not fatal */ }
  }
}

// ---------------------------------------------------------------- summary

/** Merchant, balance, original amount, status badge, expiry line. */
function buildSummary(card, balance) {
  const status = cardStatus(card, balance);
  const head = el('div', { class: 'spread' },
    el('h2', { class: 'detail-merchant' }, card.merchant),
    el('span', { class: `badge badge-${status}` }, statusLabel(status, card)),
  );
  if (isVoucher(card)) {
    // A voucher shows what it is for instead of a balance.
    return [
      head,
      el('div', { class: 'muted small' }, 'Voucher'),
      el('div', { class: 'detail-voucher-item', 'data-testid': 'voucher-item' }, card.voucherItem),
      el('div', { class: 'detail-used' }, card.usedAt ? `Used on ${formatDate(card.usedAt)}` : 'Not used yet'),
      el('div', { class: 'detail-expiry' }, expiryText(card.expiryDate)),
    ];
  }
  return [
    head,
    el('div', { class: 'detail-balance', 'aria-label': 'Current balance' }, formatMoney(balance, card.currency)),
    el('div', { class: 'muted' }, `of ${formatMoney(card.originalAmount, card.currency)}`),
    el('div', { class: 'detail-expiry' }, expiryText(card.expiryDate)),
  ];
}

/** "Expires 31 Dec 2027 · in 400 days", "Expires today", "Expired 5 days ago", "No expiry date". */
function expiryText(expiryDate) {
  const days = daysUntil(expiryDate);
  if (!expiryDate || days === null) return 'No expiry date';
  const date = formatDate(expiryDate);
  const n = (d) => `${d} ${d === 1 ? 'day' : 'days'}`;
  if (days === 0) return `Expires today · ${date}`;
  if (days > 0) return `Expires ${date} · in ${n(days)}`;
  return `Expired ${n(-days)} ago · ${date}`;
}

// ---------------------------------------------------------------- action buttons

/** "Show barcode" and "Open card link" (only when applicable). */
function buildActions(card) {
  const buttons = [];
  if (card.barcodeValue) {
    buttons.push(el('a', { class: 'btn btn-primary', href: `#/card/${card.id}/barcode` }, icon('barcode'), 'Show barcode'));
  }
  if (card.type === CARD_TYPES.ELECTRONIC && card.link) {
    buttons.push(el('a', { class: 'btn', href: card.link, target: '_blank', rel: 'noopener noreferrer' }, icon('external'), 'Open card link'));
  }
  return buttons.length ? el('div', { class: 'detail-actions' }, ...buttons) : el('div', { hidden: true });
}

// ---------------------------------------------------------------- details

/** Built once: card number, PIN, type, dates, amount, notes. Empty fields are hidden. */
function buildDetails(card) {
  const rows = [];

  if (card.cardNumber) {
    rows.push(detailRow('Card number', el('span', { class: 'mono' }, card.cardNumber),
      copyButton('Copy card number', card.cardNumber, 'Card number copied')));
  }

  if (card.pin) {
    // PIN is masked until the user taps "Show"; Copy always copies the real PIN.
    const pinText = el('span', { class: 'mono', 'data-testid': 'pin' }, '••••');
    let shown = false;
    const toggle = el('button', {
      class: 'btn btn-small', type: 'button', 'aria-pressed': 'false', onclick: () => {
        shown = !shown;
        pinText.textContent = shown ? card.pin : '••••';
        toggle.textContent = shown ? 'Hide' : 'Show';
        toggle.setAttribute('aria-pressed', String(shown));
      },
    }, 'Show');
    rows.push(detailRow('PIN', pinText, toggle, copyButton('Copy PIN', card.pin, 'PIN copied')));
  }

  if (card.owner) rows.push(detailRow('Owner', card.owner));
  rows.push(detailRow('Type', card.type === CARD_TYPES.ELECTRONIC ? 'Electronic' : 'Physical'));
  if (card.issueDate) rows.push(detailRow('Issue date', formatDate(card.issueDate)));
  if (isVoucher(card)) rows.push(detailRow('Voucher for', card.voucherItem));
  else rows.push(detailRow('Original amount', formatMoney(card.originalAmount, card.currency)));
  if (card.createdAt) rows.push(detailRow('Added on', formatDate(card.createdAt.slice(0, 10))));
  if (card.notes) rows.push(detailRow('Notes', el('span', { class: 'detail-notes' }, card.notes))); // line breaks via CSS

  return el('section', { class: 'card stack-small' }, el('h2', {}, 'Details'), el('div', { class: 'detail-list' }, ...rows));
}

/** One label + value row with optional trailing buttons. */
function detailRow(label, value, ...buttons) {
  return el('div', { class: 'detail-row' },
    el('div', { class: 'grow' }, el('div', { class: 'muted small' }, label), el('div', { class: 'detail-value' }, value)),
    buttons.length ? el('div', { class: 'row' }, ...buttons) : null,
  );
}

/** Icon button that copies `text` and shows a toast. */
function copyButton(label, text, successMessage) {
  return el('button', {
    class: 'btn btn-icon', type: 'button', 'aria-label': label, title: label, onclick: async () => {
      const ok = await copyToClipboard(text);
      if (ok) toast(successMessage, 'success');
      else toast('Could not copy to clipboard', 'error');
    },
  }, icon('copy'));
}

// ---------------------------------------------------------------- voucher action

/** Big "Mark as used" / "Mark as not used" button (replaces the Transactions section). */
function buildVoucherAction(card, onToggle) {
  const used = Boolean(card.usedAt);
  return el('button', {
    class: `btn btn-block detail-voucher-btn ${used ? '' : 'btn-primary'}`, type: 'button', onclick: onToggle,
  }, used ? 'Mark as not used' : 'Mark as used');
}

// ---------------------------------------------------------------- transactions

/** Add form first, then the list (newest first as returned by the DB). */
function buildTransactions(card, transactions, balance, onAdd, onDelete) {
  const heading = el('h2', { tabindex: '-1' }, 'Transactions');
  const list = transactions.length
    ? el('ul', { class: 'list-plain detail-tx-list' }, ...transactions.map((tx) =>
      el('li', { class: 'detail-tx' },
        el('div', { class: 'grow' },
          el('div', { class: 'detail-tx-date' }, formatDate(tx.date)),
          tx.note ? el('div', { class: 'muted small detail-tx-note' }, tx.note) : null,
        ),
        el('div', { class: 'detail-tx-amount' }, '−' + formatMoney(tx.amount, card.currency)),
        el('button', {
          class: 'btn btn-icon btn-ghost', type: 'button', 'aria-label': 'Delete transaction',
          title: 'Delete transaction', onclick: () => onDelete(tx),
        }, icon('trash')),
      )))
    : el('p', { class: 'muted' }, 'No transactions yet');

  return [heading, buildTxForm(card, balance, onAdd), list];
}

/** Add-transaction form: date, amount, note. */
function buildTxForm(card, balance, onAdd) {
  const noBalance = balance <= 0;
  const dateInput = el('input', { type: 'date', name: 'date', value: todayIso(), disabled: noBalance, required: true });
  const amountInput = el('input', {
    type: 'text', inputmode: 'decimal', name: 'amount', autocomplete: 'off',
    placeholder: formatMoney(0, card.currency), disabled: noBalance, 'aria-label': 'Amount',
  });
  const noteInput = el('input', { type: 'text', name: 'note', autocomplete: 'off', disabled: noBalance, maxlength: '200' });
  const addBtn = el('button', { class: 'btn btn-primary', type: 'submit', disabled: noBalance }, icon('plus'), 'Add');

  const dateField = field('Date', dateInput);
  const amountField = field('Amount spent', amountInput);
  const noteField = field('Note (optional)', noteInput);

  /** Show/clear an inline error under a field. */
  function setError(f, message) {
    f.classList.toggle('has-error', Boolean(message));
    f.querySelector('.error-text')?.remove();
    if (message) f.append(el('div', { class: 'error-text', role: 'alert' }, message));
  }

  const form = el('form', {
    class: 'stack-small detail-tx-form', novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      const tx = { date: dateInput.value, amount: parseAmountInput(amountInput.value, card.currency) };
      const { valid, errors } = validateTransaction(tx, balance);
      setError(dateField, errors.date);
      // A blank/unparseable amount gets a clearer message than "must be greater than 0".
      setError(amountField, errors.amount && tx.amount == null ? 'Enter the amount spent.' : errors.amount);
      if (!valid) {
        (errors.date ? dateInput : amountInput).focus();
        return;
      }
      addBtn.disabled = true; // prevent double submit
      try {
        await onAdd({ ...tx, note: noteInput.value.trim() });
      } catch (err) {
        addBtn.disabled = false;
        toast('Could not save the transaction', 'error');
      }
    },
  },
  noBalance ? el('p', { class: 'muted' }, 'No balance left') : null,
  el('div', { class: 'detail-tx-fields' }, dateField, amountField),
  noteField,
  addBtn);
  return form;
}

/** Label + control wrapper using base.css .field. */
function field(label, input) {
  const id = 'tx-' + (input.name || 'x');
  input.id = id;
  return el('div', { class: 'field' }, el('label', { for: id }, label), input);
}
