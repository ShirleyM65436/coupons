// Phase 0 smoke test: the shell loads, every route renders without errors,
// and the dev seed works.
import { openApp, check } from './helpers.mjs';

export default async function () {
  const app = await openApp();
  try {
    await app.seed();
    const ids = await app.cardIds();
    check(Object.keys(ids).length === 6, 'seed created 6 demo cards');
    const id = ids.BookNook;

    for (const hash of ['#/', '#/add', '#/scan', '#/backup', `#/card/${id}`, `#/card/${id}/edit`, `#/card/${id}/barcode`]) {
      await app.goto(hash);
      const text = await app.page.locator('#view').innerText();
      check(!text.includes('Something went wrong'), `route ${hash} renders`);
    }
    await app.goto('#/nope');
    check((await app.page.locator('#app-title').innerText()) === 'Not found', 'unknown route shows Not found');
  } finally {
    await app.close();
  }
}
