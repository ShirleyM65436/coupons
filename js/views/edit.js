// views/edit.js - Add / Edit card form.
// Serves two routes with one module:
//   #/add              params {}        (optionally pre-filled from the scan draft)
//   #/card/:id/edit    params { id }
// See ARCHITECTURE.md sections 4, 7 and 9 "B".

import { el, setHeader, navigate, toast } from '../ui.js';
import {
  CARD_TYPES, CARD_KINDS, DEFAULT_CURRENCY,
  validateCard, parseAmountInput, minorToInputString, totalSpent,
} from '../model.js';
import {
  getCard, getTransactions, putCard, putPhoto, getPhoto, deletePhoto,
} from '../db.js';
import { getDraft, clearDraft } from '../draft.js';
import { downscaleImage } from '../services/photo.js';
import { BARCODE_FORMATS } from '../services/scanner.js';
import { merchantPicker } from './merchantPicker.js';

// Fields whose OCR confidence below this value are marked "please check".
const LOW_CONFIDENCE = 0.6;
// Order in which fields appear (used to focus the first invalid one).
const FIELD_ORDER = ['merchant', 'kind', 'type', 'link', 'originalAmount', 'voucherItem', 'usedAt', 'issueDate', 'expiryDate'];

// The app uses a single currency (shekel), so there is no currency picker.
const CURRENCY = DEFAULT_CURRENCY;

// Object URLs created by this view; revoked in cleanup().
let objectUrls = [];

/** Create an object URL and remember it so cleanup() can revoke it. */
function makeUrl(blob) {
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  return url;
}
function revokeUrl(url) {
  if (!url) return;
  try { URL.revokeObjectURL(url); } catch { /* ignore */ }
  objectUrls = objectUrls.filter((u) => u !== url);
}

// Bumped by cleanup() so a render that resumes after the user left does nothing.
let renderToken = 0;

export async function render(container, params = {}) {
  const token = ++renderToken;
  const editingId = params.id || null;
  const isEdit = Boolean(editingId);
  const backHash = isEdit ? `#/card/${editingId}` : '#/';
  setHeader({ title: isEdit ? 'Edit card' : 'Add card', back: isEdit ? backHash : '#/' });

  // ------------------------------------------------------------ load data
  let existing = null;
  let spent = 0;
  let txCount = 0; // a money card with transactions cannot become a voucher
  if (isEdit) {
    existing = await getCard(editingId);
    if (!existing) {
      container.append(el('div', { class: 'empty-state' },
        el('h2', {}, 'Card not found'),
        el('a', { class: 'btn btn-primary', href: '#/' }, 'Back to my cards')));
      return;
    }
    const txs = await getTransactions(editingId);
    spent = totalSpent(txs);
    txCount = txs.length;
  }

  // The scan draft only applies to "add".
  const draft = isEdit ? null : getDraft();
  const draftCard = draft?.card || {};
  const confidence = draft?.confidence || {};

  // Initial values: the existing card, else draft values, else defaults.
  const src = existing || draftCard;
  const initial = {
    merchant: src.merchant || '',
    // Scan drafts are always money; only a stored card can be a voucher.
    kind: existing && existing.kind === CARD_KINDS.VOUCHER ? CARD_KINDS.VOUCHER : CARD_KINDS.MONEY,
    voucherItem: existing?.voucherItem || '',
    usedAt: existing?.usedAt || '',
    type: src.type === CARD_TYPES.ELECTRONIC ? CARD_TYPES.ELECTRONIC : CARD_TYPES.PHYSICAL,
    link: src.link || '',
    cardNumber: src.cardNumber || '',
    pin: src.pin || '',
    issueDate: src.issueDate || '',
    expiryDate: src.expiryDate || '',
    barcodeValue: src.barcodeValue || '',
    barcodeFormat: src.barcodeFormat || 'code_128',
    notes: src.notes || '',
  };
  initial.amount = src.originalAmount != null && src.originalAmount !== ''
    ? minorToInputString(src.originalAmount, CURRENCY) : '';

  // Photo state. `blob` = new photo to store; `removed` = existing photo to drop.
  const photo = { blob: null, url: '', removed: false };
  if (isEdit && existing.photoId) {
    const blob = await getPhoto(existing.photoId);
    if (blob) photo.url = makeUrl(blob);
  } else if (draft?.photoBlob) {
    photo.blob = draft.photoBlob;
    photo.url = makeUrl(draft.photoBlob);
  }

  // ------------------------------------------------------------ field helpers
  const errorEls = {}; // field name -> <p class="error-text">
  const fieldEls = {}; // field name -> .field wrapper

  /** Build a labelled .field. `control` must already have the matching id. */
  function field(name, label, control, { hint, labelFor } = {}) {
    const errorEl = el('p', { class: 'error-text', id: `err-${name}`, hidden: true, role: 'alert' });
    errorEls[name] = errorEl;
    const wrap = el('div', { class: 'field', dataset: { field: name } },
      el('label', { for: labelFor || control.id }, label),
      control,
      hint ? el('p', { class: 'hint' }, hint) : null,
      errorEl);
    fieldEls[name] = wrap;
    // Low-confidence OCR value: highlight and explain.
    const conf = confidence[name] ?? (name === 'originalAmount' ? confidence.amount : undefined);
    const filled = draftCard[name] != null && draftCard[name] !== '';
    if (!isEdit && filled && typeof conf === 'number' && conf < LOW_CONFIDENCE) {
      wrap.classList.add('needs-check');
      wrap.insertBefore(el('p', { class: 'hint' }, 'Read by text recognition – please check'), errorEl);
      // Once the user edits the value they have checked it.
      control.addEventListener('input', () => wrap.classList.remove('needs-check'), { once: true });
      control.addEventListener('change', () => wrap.classList.remove('needs-check'), { once: true });
    }
    // Editing a field clears its error.
    const clear = () => clearError(name);
    control.addEventListener('input', clear);
    control.addEventListener('change', clear);
    return wrap;
  }

  function setError(name, message) {
    const wrap = fieldEls[name];
    const input = wrap?.querySelector('input, select, textarea');
    wrap.classList.add('has-error');
    errorEls[name].textContent = message;
    errorEls[name].hidden = false;
    wrap.querySelectorAll('input, select, textarea').forEach((i) => {
      i.setAttribute('aria-invalid', 'true');
      i.setAttribute('aria-describedby', `err-${name}`);
    });
    return input;
  }
  function clearError(name) {
    const wrap = fieldEls[name];
    if (!wrap) return;
    wrap.classList.remove('has-error');
    errorEls[name].hidden = true;
    errorEls[name].textContent = '';
    wrap.querySelectorAll('input, select, textarea').forEach((i) => {
      i.removeAttribute('aria-invalid');
      i.removeAttribute('aria-describedby');
    });
  }

  const textInput = (id, value, attrs = {}) => el('input', { id, name: id, type: 'text', value, ...attrs });

  // ------------------------------------------------------------ controls
  // Merchant: text box + user-editable quick options list below it (see merchantPicker.js).
  const { root: merchantBox, input: merchant } = await merchantPicker(initial.merchant);
  // The user may have left while we were loading: cleanup() already revoked our photo URL,
  // so do not build a form that would point an <img> at a revoked blob.
  if (token !== renderToken) return;

  // Type: segmented radios.
  const typeRadios = [[CARD_TYPES.PHYSICAL, 'Physical'], [CARD_TYPES.ELECTRONIC, 'Electronic']].map(([value, text]) =>
    el('label', {},
      el('input', { type: 'radio', name: 'type', value, id: `type-${value}`, checked: initial.type === value }),
      el('span', {}, text)));
  const typeGroup = el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Type', id: 'type-group' }, ...typeRadios);

  // Kind: Money (default) or Voucher. Voucher is disabled for a money card that has transactions.
  const voucherLocked = isEdit && initial.kind === CARD_KINDS.MONEY && txCount > 0;
  const kindRadios = [[CARD_KINDS.MONEY, 'Money'], [CARD_KINDS.VOUCHER, 'Voucher']].map(([value, text]) =>
    el('label', {},
      el('input', {
        type: 'radio', name: 'kind', value, id: `kind-${value}`, checked: initial.kind === value,
        disabled: value === CARD_KINDS.VOUCHER && voucherLocked,
      }),
      el('span', {}, text)));
  const kindGroup = el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Kind', id: 'kind-group' }, ...kindRadios);

  // Voucher-only fields.
  const voucherItem = el('input', { id: 'voucherItem', name: 'voucherItem', type: 'text', value: initial.voucherItem, placeholder: 'Movie ticket + popcorn + drink', autocomplete: 'off', 'aria-required': 'true' });
  const usedAt = el('input', { id: 'usedAt', name: 'usedAt', type: 'date', value: initial.usedAt });

  const link = el('input', { id: 'link', name: 'link', type: 'url', value: initial.link, placeholder: 'https://…', autocomplete: 'off' });

  const amount = el('input', { id: 'originalAmount', name: 'originalAmount', type: 'text', inputmode: 'decimal', value: initial.amount, placeholder: '0.00', autocomplete: 'off', 'aria-required': 'true' });

  const cardNumber = textInput('cardNumber', initial.cardNumber, { autocomplete: 'off', autocapitalize: 'characters' });
  const pin = textInput('pin', initial.pin, { autocomplete: 'off' }); // text: PINs may contain letters
  const issueDate = el('input', { id: 'issueDate', name: 'issueDate', type: 'date', value: initial.issueDate });
  const expiryDate = el('input', { id: 'expiryDate', name: 'expiryDate', type: 'date', value: initial.expiryDate });
  const barcodeValue = textInput('barcodeValue', initial.barcodeValue, { autocomplete: 'off' });
  const formats = BARCODE_FORMATS.includes(initial.barcodeFormat) ? BARCODE_FORMATS : [initial.barcodeFormat, ...BARCODE_FORMATS];
  const barcodeFormat = el('select', { id: 'barcodeFormat', name: 'barcodeFormat' },
    ...formats.map((f) => el('option', { value: f, selected: f === initial.barcodeFormat }, f)));
  const notes = el('textarea', { id: 'notes', name: 'notes', rows: '3' }, initial.notes);

  // ------------------------------------------------------------ photo
  const preview = el('img', { class: 'edit-photo-preview', alt: 'Card photo preview' });
  const previewBox = el('div', { class: 'edit-photo' }, preview);
  const removeBtn = el('button', { type: 'button', class: 'btn btn-small', onclick: () => {
    // Drop the new/current photo. If a stored photo existed it is deleted on save.
    revokeUrl(photo.url);
    photo.url = '';
    photo.blob = null;
    photo.removed = Boolean(existing?.photoId);
    fileInput.value = '';
    refreshPhoto();
  } }, 'Remove photo');
  const fileInput = el('input', { id: 'photo', name: 'photo', type: 'file', accept: 'image/*', onchange: async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const blob = await downscaleImage(file);
      revokeUrl(photo.url);
      photo.blob = blob;
      photo.removed = false;
      photo.url = makeUrl(blob);
      refreshPhoto();
    } catch {
      toast('Could not read that image', 'error');
    }
  } });
  function refreshPhoto() {
    previewBox.hidden = !photo.url;
    removeBtn.hidden = !photo.url;
    if (photo.url) preview.src = photo.url; else preview.removeAttribute('src');
  }

  // ------------------------------------------------------------ assemble form
  const linkField = field('link', 'Link', link, { hint: 'Where the card can be redeemed (https://…)' });
  const syncLinkVisibility = () => {
    linkField.hidden = form.querySelector('input[name="type"]:checked')?.value !== CARD_TYPES.ELECTRONIC;
  };

  const amountField = field('originalAmount', 'Amount (₪)', amount);
  const voucherItemField = field('voucherItem', 'What is it for?', voucherItem);
  const usedAtField = field('usedAt', 'Used on', usedAt, { hint: 'Leave empty if not used yet' });
  const kindHint = voucherLocked ? el('p', { class: 'hint', id: 'kind-hint' }, 'Delete its transactions first to turn it into a voucher') : null;
  const kindField = field('kind', 'Kind', kindGroup, { labelFor: 'kind-MONEY' });
  if (kindHint) kindField.insertBefore(kindHint, errorEls.kind);
  const currentKind = () => form.querySelector('input[name="kind"]:checked')?.value || CARD_KINDS.MONEY;
  /** Show Amount for money, or item + used-on for a voucher. */
  const syncKindVisibility = () => {
    const voucher = currentKind() === CARD_KINDS.VOUCHER;
    amountField.hidden = voucher;
    voucherItemField.hidden = !voucher;
    usedAtField.hidden = !voucher;
  };

  const saveBtn = el('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Save');
  const cancelBtn = el('button', { type: 'button', class: 'btn btn-block', onclick: () => {
    clearDraft();
    navigate(backHash);
  } }, 'Cancel');

  const form = el('form', { class: 'stack', novalidate: true, autocomplete: 'off' },
    draft ? el('div', { class: 'banner' }, 'Check the details read from your card, then save.') : null,
    field('merchant', 'Merchant', merchantBox, { labelFor: 'merchant' }),
    kindField,
    field('type', 'Type', typeGroup, { labelFor: 'type-PHYSICAL' }),
    linkField,
    amountField,
    voucherItemField,
    usedAtField,
    field('cardNumber', 'Card number', cardNumber),
    field('pin', 'PIN', pin),
    el('div', { class: 'edit-date-row' },
      field('issueDate', 'Issue date', issueDate),
      field('expiryDate', 'Expiry date', expiryDate)),
    el('div', { class: 'edit-barcode-row' },
      field('barcodeValue', 'Barcode value', barcodeValue),
      field('barcodeFormat', 'Barcode format', barcodeFormat)),
    el('div', { class: 'field' },
      el('label', { for: 'photo' }, 'Photo (optional)'),
      previewBox,
      fileInput,
      removeBtn),
    draft?.ocrText ? el('details', { class: 'edit-ocr' }, el('summary', {}, 'Recognized text'), el('pre', {}, draft.ocrText)) : null,
    field('notes', 'Notes', notes),
    el('div', { class: 'stack-small' }, saveBtn, cancelBtn));

  // Type radios: toggle link visibility.
  form.querySelectorAll('input[name="type"]').forEach((r) => r.addEventListener('change', () => { syncLinkVisibility(); clearError('type'); clearError('link'); }));
  syncLinkVisibility();
  // Kind radios: swap Amount <-> voucher fields.
  form.querySelectorAll('input[name="kind"]').forEach((r) => r.addEventListener('change', () => { syncKindVisibility(); clearError('kind'); }));
  syncKindVisibility();
  refreshPhoto();

  // ------------------------------------------------------------ submit
  let saving = false;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (saving) return;

    // Clear previous errors, then collect values.
    Object.keys(fieldEls).forEach(clearError);
    const type = form.querySelector('input[name="type"]:checked')?.value || CARD_TYPES.PHYSICAL;
    const cur = CURRENCY;
    const amountText = amount.value.trim();
    const parsedAmount = amountText ? parseAmountInput(amountText, cur) : null;
    const bcValue = barcodeValue.value.trim();

    const voucher = currentKind() === CARD_KINDS.VOUCHER;

    const card = {
      merchant: merchant.value.trim(),
      kind: voucher ? CARD_KINDS.VOUCHER : CARD_KINDS.MONEY,
      type,
      link: type === CARD_TYPES.ELECTRONIC ? link.value.trim() : '', // hidden field is ignored
      // Hidden fields are neither validated nor saved (normalizeCard clears them too).
      originalAmount: voucher ? 0 : parsedAmount,
      voucherItem: voucher ? voucherItem.value.trim() : '',
      usedAt: voucher ? usedAt.value : '',
      currency: cur,
      cardNumber: cardNumber.value.trim(),
      pin: pin.value.trim(),
      issueDate: issueDate.value,
      expiryDate: expiryDate.value,
      barcodeValue: bcValue,
      barcodeFormat: bcValue ? (barcodeFormat.value || 'code_128') : '',
      notes: notes.value.trim(),
    };

    const { valid, errors } = validateCard(card, voucher ? 0 : spent);
    if (!voucher && amountText && parsedAmount === null) errors.originalAmount = 'Enter a valid amount';
    if (!valid || Object.keys(errors).length) {
      for (const name of Object.keys(errors)) if (fieldEls[name]) setError(name, errors[name]);
      const first = FIELD_ORDER.find((n) => errors[n]);
      const target = first === 'type' ? form.querySelector('input[name="type"]:checked') : fieldEls[first]?.querySelector('input, select, textarea');
      target?.focus();
      return;
    }

    // Valid: save. Disable the button so a double tap cannot save twice.
    saving = true;
    saveBtn.disabled = true;
    let newPhotoId = '';
    try {
      let photoId = existing?.photoId || '';
      let oldPhotoToDelete = '';
      if (photo.blob) {
        newPhotoId = await putPhoto(photo.blob);
        if (photoId) oldPhotoToDelete = photoId;
        photoId = newPhotoId;
      } else if (photo.removed && photoId) {
        oldPhotoToDelete = photoId;
        photoId = '';
      }
      const saved = await putCard({
        ...card,
        photoId,
        ...(existing ? { id: existing.id, createdAt: existing.createdAt } : {}),
      });
      if (oldPhotoToDelete) await deletePhoto(oldPhotoToDelete);
      clearDraft();
      toast('Card saved', 'success');
      navigate(`#/card/${saved.id}`);
    } catch (err) {
      console.warn('Saving card failed', err);
      if (newPhotoId) { try { await deletePhoto(newPhotoId); } catch { /* ignore */ } }
      toast('Could not save the card', 'error');
      saving = false;
      saveBtn.disabled = false;
    }
  });

  container.append(form);
  // Autofocus Merchant only when adding a blank card (a draft already has content to review).
  if (!isEdit && !draft) merchant.focus();
}

/**
 * Revoke object URLs created for photo previews, and forget any scan draft:
 * the draft only belongs to the Add form currently on screen, so leaving it by any
 * route (Save, Cancel, header back arrow, browser back) must not leave it behind
 * for a later manual "Add".
 */
export function cleanup() {
  renderToken++;
  clearDraft();
  for (const url of objectUrls) {
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
  }
  objectUrls = [];
}
