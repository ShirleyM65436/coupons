// views/merchantPicker.js - the Merchant field of the Add/Edit form:
// a normal text box with a "quick options" list that drops down below it.
//
//  - Focusing the box (or tapping the ▾ button) opens the list; typing filters it.
//  - Tapping an option puts it in the box. Any other name can simply be typed.
//  - "+ Add '<typed name>' to quick list" saves a new option; × removes one.
//  - The list is stored in IndexedDB (db.getMerchantOptions / setMerchantOptions),
//    starting from DEFAULT_MERCHANT_OPTIONS in model.js.

import { el, icon } from '../ui.js';
import { getMerchantOptions, setMerchantOptions } from '../db.js';

/**
 * Build the merchant field.
 * @param {string} value  initial merchant name
 * @returns {Promise<{ root: HTMLElement, input: HTMLInputElement }>}
 *   root goes into the form; input is the text box (id "merchant", read its .value on save)
 */
export async function merchantPicker(value = '') {
  let options = await getMerchantOptions();

  const input = el('input', {
    id: 'merchant', name: 'merchant', type: 'text', value, autocomplete: 'off', 'aria-required': 'true',
    placeholder: 'Type a name or pick one below', role: 'combobox', 'aria-autocomplete': 'list',
    'aria-expanded': 'false', 'aria-controls': 'merchant-options',
  });
  const toggle = el('button', {
    type: 'button', class: 'btn btn-icon merchant-toggle', 'aria-label': 'Show quick options', title: 'Quick options',
  }, '▾');
  const list = el('ul', { id: 'merchant-options', class: 'list-plain merchant-options', role: 'listbox', hidden: true });

  // Keep the text box focused while tapping inside the list (otherwise it would close first).
  list.addEventListener('pointerdown', (e) => e.preventDefault());

  function open() {
    draw();
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }
  function close() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
  }

  /** Put a name in the box as if the user typed it (so form listeners notice). */
  function choose(name) {
    input.value = name;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    close();
  }

  /** Re-draw the list: options matching the typed text, plus "Add …" for a new name. */
  function draw() {
    const typed = input.value.trim();
    const q = typed.toLowerCase();
    // Show everything when the box is empty or holds exactly one of the options.
    const exact = options.some((o) => o.toLowerCase() === q);
    const shown = !q || exact ? options : options.filter((o) => o.toLowerCase().includes(q));

    const rows = shown.map((name) => el('li', { class: 'merchant-option', role: 'option' },
      el('button', { type: 'button', class: 'merchant-option-pick', onclick: () => choose(name) }, name),
      el('button', {
        type: 'button', class: 'btn btn-icon btn-ghost merchant-option-remove',
        'aria-label': `Remove ${name} from quick options`, title: 'Remove from quick options',
        onclick: async () => {
          options = await setMerchantOptions(options.filter((o) => o !== name));
          draw();
        },
      }, icon('close', 18)),
    ));

    if (typed && !exact) {
      rows.push(el('li', { class: 'merchant-option merchant-option-add' },
        el('button', {
          type: 'button', class: 'merchant-option-pick', onclick: async () => {
            options = await setMerchantOptions([...options, typed]);
            choose(typed);
          },
        }, icon('plus', 18), `Add "${typed}" to quick options`)));
    }
    if (!rows.length) rows.push(el('li', { class: 'merchant-option muted small' }, 'No quick options yet – type a name to add one.'));
    list.replaceChildren(...rows);
  }

  input.addEventListener('focus', open);
  input.addEventListener('click', () => { if (list.hidden) open(); }); // re-open after picking
  input.addEventListener('input', () => { if (!list.hidden) draw(); else open(); });
  input.addEventListener('blur', close);
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  toggle.addEventListener('pointerdown', (e) => e.preventDefault()); // keep focus in the box
  toggle.addEventListener('click', () => {
    if (list.hidden) { input.focus(); open(); } else close();
  });

  const root = el('div', { class: 'merchant-picker' },
    el('div', { class: 'merchant-row' }, input, toggle),
    list);
  return { root, input };
}
