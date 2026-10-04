const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright-core');
const esbuild = require('esbuild');

async function main() {
    const bundle = esbuild.buildSync({
        entryPoints: ['main.ts'], bundle: true, external: ['obsidian'],
        format: 'iife', globalName: 'StickyHeaders', target: 'es2018', minify: true, write: false,
    }).outputFiles[0].text;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-headers-tests-'));
    let browser;
    try {
        const tests = fs.readFileSync('tests/performance.js', 'utf8');
        const html = `<html><body><pre id="results">RUNNING</pre><script>${tests}\n${bundle}\nrunTests();</script></body></html>`;
        const file = path.join(directory, 'test.html');
        fs.writeFileSync(file, html);
        const executablePath = process.env.CHROMIUM_PATH || (process.env.PATH || '').split(path.delimiter)
            .flatMap((directory) => ['chromium', 'chromium-browser', 'google-chrome'].map((name) => path.join(directory, name)))
            .find((candidate) => fs.existsSync(candidate));
        browser = await chromium.launch({ executablePath, headless: true });
        const page = await browser.newPage();
        await page.goto(pathToFileURL(file).href);
        await page.waitForFunction(() => {
            const result = document.getElementById('results').textContent;
            return result.includes('ALL TESTS PASSED') || result.includes('FAIL ');
        }, { timeout: 30000 });
        const output = await page.locator('#results').textContent();
        console.log(output);
        assert.match(output, /ALL TESTS PASSED/);
    } finally {
        await browser?.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
