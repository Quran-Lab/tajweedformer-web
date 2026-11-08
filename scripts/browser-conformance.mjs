// web/conformance.html in a headless browser: every build on the 35 parity clips, feature path and
// audio path, printed for the record.
//
//   node scripts/serve.mjs 8080 --data <conformance data dir> &
//   node scripts/browser-conformance.mjs [chrome|firefox] [build] [threads]
//
// Needs puppeteer-core (a dev dependency) and an installed browser; CHROME or FIREFOX name the
// executable when it is not in the usual macOS place. PORT picks the server's port (8080).
import puppeteer from 'puppeteer-core';

const [which = 'chrome', build = 'zipformer', threads = build === 'zipformer-mt' ? '4' : '1'] = process.argv.slice(2);
const port = process.env.PORT ?? '8080';
const launch = which === 'firefox'
  ? { browser: 'firefox', executablePath: process.env.FIREFOX ?? '/Applications/Firefox.app/Contents/MacOS/firefox' }
  : { executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' };
const b = await puppeteer.launch({ ...launch, headless: true });
const p = await b.newPage();
p.on('pageerror', (e) => console.error('page error:', e.message));
await p.goto(`http://localhost:${port}/internal/v3/conformance.html?build=${build}&threads=${threads}`);
await p.waitForFunction(() => /^(done|error)/.test(document.getElementById('summary').textContent), { timeout: 3600000 });
console.log(await p.$eval('#env', (e) => e.textContent));
const summary = await p.$eval('#summary', (e) => e.textContent);
console.log(summary);
await b.close();
process.exit(/features 35\/35.*audio 35\/35/.test(summary) ? 0 : 1);
