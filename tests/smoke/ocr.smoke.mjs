// Smoke test for services/ocr.js + ocrParser.js in a real browser:
// render a card-like image, OCR it with the self-hosted Tesseract, parse the text, and check that
// nothing was fetched from any host other than the local server (= works offline).
import { openApp, check } from './helpers.mjs';

export default async function () {
  const app = await openApp();
  try {
    const { page } = app;
    const origin = new URL(app.url).origin;
    const requests = [];
    page.context().on('request', (req) => requests.push(req.url()));

    // Everything runs inside the page: draw -> Blob -> recognizeText -> parseOcrText.
    const run = (psm) => page.evaluate(async (psmArg) => {
      const { recognizeText, terminateOcr } = await import('./js/services/ocr.js');
      const { parseOcrText } = await import('./js/services/ocrParser.js');

      // 1200x750 "card": dark text on a light background.
      const canvas = document.createElement('canvas');
      canvas.width = 1200; canvas.height = 750;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#f4f0e6'; ctx.fillRect(0, 0, 1200, 750);
      ctx.fillStyle = '#1a1a1a';
      ctx.font = 'bold 90px Arial, sans-serif'; ctx.fillText('GIFT CARD', 80, 150);
      ctx.font = '64px Arial, sans-serif';
      ctx.fillText('Card No 6035 7712 3456 7890', 80, 330);
      ctx.fillText('Valid thru 12/2027', 80, 470);
      ctx.fillText('Value €25.00', 80, 610);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));

      const progress = [];
      const t0 = performance.now();
      const result = await recognizeText(blob, { psm: psmArg, onProgress: (f, s) => progress.push([f, s]) });
      const ms = Math.round(performance.now() - t0);
      const parsed = parseOcrText(result.text);
      return { text: result.text, confidence: result.confidence, ms, progress, parsed };
    }, psm);

    // ---- first call: creates the worker
    const first = await run();
    console.log('  OCR text:', JSON.stringify(first.text));
    console.log(`  first call (creates worker): ${first.ms} ms, confidence ${first.confidence.toFixed(0)}`);
    check(first.parsed.cardNumber === '6035771234567890', `card number parsed (${first.parsed.cardNumber})`);
    check(first.parsed.expiryDate === '2027-12-31', `expiry parsed (${first.parsed.expiryDate})`);
    check(first.parsed.amount === 2500, `amount parsed (${first.parsed.amount})`);
    check(first.parsed.currency === 'EUR', `currency parsed (${first.parsed.currency})`);

    const fractions = first.progress.map((p) => p[0]);
    check(fractions.length >= 4, `onProgress called ${fractions.length} times`);
    check(fractions.every((f, i) => i === 0 || f >= fractions[i - 1]), 'progress never goes backwards');
    check(fractions.every((f) => f >= 0 && f <= 1), 'progress stays within 0..1');
    check(fractions[fractions.length - 1] === 1, 'progress ends at 1');
    check(first.progress.every((p) => typeof p[1] === 'string' && p[1]), 'every progress call has a status text');
    console.log('  statuses:', [...new Set(first.progress.map((p) => p[1]))].join(' | '));

    // ---- everything came from the local server, and the OCR assets really were fetched
    const foreign = requests.filter((u) => !u.startsWith(origin) && !u.startsWith('data:') && !u.startsWith('blob:'));
    check(foreign.length === 0, `no request left the local server (${foreign.join(', ') || 'none'})`);
    for (const part of ['vendor/tesseract/worker.min.js', 'vendor/tesseract-core/', 'vendor/tessdata/eng.traineddata.gz']) {
      check(requests.some((u) => u.includes(part)), `fetched ${part} from the local server`);
    }
    const workerFetches = () => requests.filter((u) => u.includes('worker.min.js')).length;
    check(workerFetches() === 1, 'one worker script fetched');

    // ---- second call reuses the worker
    const second = await run();
    console.log(`  second call (warm worker): ${second.ms} ms`);
    check(second.parsed.cardNumber === '6035771234567890', 'second call parses the same card');
    check(workerFetches() === 1, 'second call did not create another worker');
    check(second.ms < first.ms, `second call is faster (${second.ms} < ${first.ms} ms)`);
    check(second.progress.at(-1)[0] === 1, 'second call progress ends at 1');

    // ---- queueing: two simultaneous calls both finish, still one worker
    const both = await page.evaluate(async () => {
      const { recognizeText } = await import('./js/services/ocr.js');
      const c = document.createElement('canvas'); c.width = 600; c.height = 200;
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 600, 200);
      x.fillStyle = '#000'; x.font = '60px Arial'; x.fillText('HELLO 12345', 20, 120);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      const [a, b] = await Promise.all([recognizeText(blob), recognizeText(blob)]);
      return [a.text.trim(), b.text.trim()];
    });
    check(both.every((t) => /HELLO/i.test(t)), `concurrent calls both complete (${both.join(' / ')})`);
    check(workerFetches() === 1, 'concurrent calls still use one worker');

    // ---- terminate and start over
    await page.evaluate(async () => { const { terminateOcr } = await import('./js/services/ocr.js'); await terminateOcr(); await terminateOcr(); });
    check(true, 'terminateOcr() works (also when called twice)');
    const third = await run();
    check(third.parsed.cardNumber === '6035771234567890', `works again after terminate (${third.ms} ms)`);
    check(workerFetches() === 2, 'a new worker was created after terminate');
    await page.evaluate(async () => { const { terminateOcr } = await import('./js/services/ocr.js'); await terminateOcr(); });

    // ---- optional: compare page-segmentation modes (informational)
    if (process.env.OCR_PSM_COMPARE) {
      for (const psm of ['3', '6', '11']) {
        const r = await run(psm);
        console.log(`  PSM ${psm}: ${r.ms} ms, text=${JSON.stringify(r.text)}`);
      }
      await page.evaluate(async () => { const { terminateOcr } = await import('./js/services/ocr.js'); await terminateOcr(); });
    }
  } finally {
    await app.close();
  }
}
