const workspaceEvents = new Map();
let ready;
class Plugin {
    app = { workspace: {
        onLayoutReady(callback) { ready = callback; },
        on(name, callback) { workspaceEvents.set(name, callback); return name; },
    } };
    disposers = [];
    registerEvent(name) { this.disposers.push(() => workspaceEvents.delete(name)); }
    registerDomEvent(target, name, callback) {
        target.addEventListener(name, callback);
        this.disposers.push(() => target.removeEventListener(name, callback));
    }
    unload() { this.onunload(); this.disposers.forEach((dispose) => dispose()); }
}
function require(name) {
    if (name !== 'obsidian') throw new Error(`Unexpected import: ${name}`);
    return { Plugin };
}

let nextFrame = 0;
const frames = new Map();
const NativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
window.requestAnimationFrame = (callback) => { frames.set(++nextFrame, callback); return nextFrame; };
window.cancelAnimationFrame = (id) => frames.delete(id);
function flushFrame() {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback());
}
const tick = () => Promise.resolve();
const NativeResizeObserver = window.ResizeObserver;
const NativeIntersectionObserver = window.IntersectionObserver;

class TestObserver {
    static instances = [];
    targets = new Set();
    constructor(callback, options) {
        this.callback = callback;
        this.options = options;
        this.constructor.instances.push(this);
    }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
    fire() { if (this.targets.size) this.callback([]); }
}
window.ResizeObserver = class extends TestObserver { static instances = []; };
window.IntersectionObserver = class extends TestObserver { static instances = []; };

let scans = 0;
const queryAll = document.querySelectorAll.bind(document);
document.querySelectorAll = (...args) => { scans++; return queryAll(...args); };
let intervals = 0;
const originalInterval = window.setInterval;
window.setInterval = (...args) => { intervals++; return originalInterval(...args); };

function assert(condition, message) { if (!condition) throw new Error(message); }
function equal(actual, expected, message) {
    assert(actual === expected, `${message}: expected ${expected}, received ${actual}`);
}
function rect(left, top, width, height) {
    return { left, top, width, height, right: left + width, bottom: top + height };
}
function fixture({ withTable = true, sticky = true, count = 1, livePreview = false } = {}) {
    const root = document.createElement('div');
    root.className = 'workspace-leaf-content';
    root.innerHTML = `<div class="markdown-preview-view"><p>Text</p>${withTable ?
        '<div class="horizontal" style="overflow-x:auto"><table><thead><tr><th>One</th><th>Two</th></tr></thead><tbody><tr><td>A</td><td>B</td></tr></tbody></table></div>'.repeat(count) : ''}</div>`;
    document.body.appendChild(root);
    const scroller = root.firstElementChild;
    if (livePreview) {
        scroller.className = 'cm-scroller';
        scroller.querySelectorAll('.horizontal').forEach((element) => element.classList.add('cm-table-widget'));
    }
    const text = scroller.querySelector('p');
    const tables = [...root.querySelectorAll('table')];
    const metrics = { reads: 0, cellReads: 0 };
    const geometry = { left: 20, top: sticky ? -20 : 50, width: 200, height: 500, headerHeight: 30 };
    root.getBoundingClientRect = () => rect(0, 0, 300, 400);
    scroller.getBoundingClientRect = () => { metrics.reads++; return rect(0, 0, 300, 400); };
    function measure(table) {
        table.getBoundingClientRect = () => {
            metrics.reads++;
            return rect(geometry.left, geometry.top, geometry.width, geometry.height);
        };
        const head = table.querySelector('thead');
        head.getBoundingClientRect = () => {
            metrics.reads++;
            return rect(geometry.left, geometry.top, geometry.width, geometry.headerHeight);
        };
        head.querySelectorAll('th').forEach((cell) => {
            cell.getBoundingClientRect = () => {
                metrics.cellReads++;
                return rect(0, 0, geometry.width / 2, geometry.headerHeight);
            };
        });
    }
    tables.forEach(measure);
    const plugin = new StickyHeaders.default();
    plugin.onload();
    ready();
    flushFrame();
    return { root, scroller, text, tables, plugin, metrics, geometry, measure,
        wrapper: () => document.querySelector('.tsh-clone-wrapper'),
        cleanup: () => { plugin.unload(); root.remove(); } };
}

async function runTests() {
    const output = document.getElementById('results');
    const results = [];
    const test = async (name, callback) => {
        await callback();
        results.push(`PASS ${name}`);
        output.textContent = results.join('\n');
    };
    try {
        await test('1,341 ordinary typing mutations schedule no scans or visual work (with and without tables)', async () => {
            for (const options of [{ withTable: false }, { withTable: true }, { livePreview: true }]) {
                const f = fixture(options);
                const withTable = options.withTable !== false;
                await tick(); // Deliver clone insertion records, too.
                equal(frames.size, 0, 'clone insertion must not queue another frame');
                const beforeScans = scans;
                const beforeReads = f.metrics.reads;
                for (let i = 0; i < 1341; i++) {
                    const node = i % 2 === 0 ? document.createElement('span') : document.createTextNode('');
                    node.textContent = `Typing ${i}`;
                    f.text.replaceChildren(node);
                    await tick();
                }
                equal(scans, beforeScans, 'typing must not scan the document');
                equal(frames.size, 0, 'typing must not schedule frames');
                equal(f.metrics.reads, beforeReads, 'typing must not measure tables');
                workspaceEvents.get('layout-change')();
                if (!withTable) equal(frames.size, 0, 'layout events without tables must not queue work');
                equal(intervals, 0, 'no periodic polling');
                f.cleanup();
            }
        });
        await test('scroll bursts across multiple tables share one frame and reuse column widths', async () => {
            const f = fixture({ count: 3 });
            await tick();
            const beforeReads = f.metrics.reads;
            const beforeCellReads = f.metrics.cellReads;
            const writes = new MutationObserver(() => {});
            queryAll('.tsh-clone-wrapper').forEach((wrapper) => writes.observe(wrapper, {
                attributes: true, childList: true, subtree: true,
            }));
            for (let i = 0; i < 100; i++) {
                f.scroller.dispatchEvent(new Event('scroll'));
                f.root.querySelector('.horizontal').dispatchEvent(new Event('scroll'));
                window.dispatchEvent(new Event('resize')); // Invalidation is also coalesced.
            }
            equal(frames.size, 1, 'one shared frame');
            flushFrame();
            equal(f.metrics.reads - beforeReads, 9, 'each table updates once');
            equal(f.metrics.cellReads - beforeCellReads, 6, 'each table measures columns once after resize');
            equal(writes.takeRecords().length, 0, 'unchanged geometry must not write to clones');
            const cached = f.metrics.cellReads;
            for (let i = 0; i < 100; i++) f.scroller.dispatchEvent(new Event('scroll'));
            flushFrame();
            equal(f.metrics.cellReads, cached, 'scrolling must reuse cached column widths');
            writes.disconnect();
            f.cleanup();
        });
        await test('sticky visibility and horizontal clipping follow table geometry', () => {
            const f = fixture({ sticky: false });
            assert(!f.wrapper().classList.contains('tsh-visible'), 'header initially in view');
            f.geometry.top = -20;
            f.geometry.left = -80;
            f.scroller.dispatchEvent(new Event('scroll'));
            flushFrame();
            assert(f.wrapper().classList.contains('tsh-visible'), 'header sticks after scrolling');
            equal(f.wrapper().style.left, '0px', 'clip left at leaf boundary');
            equal(f.wrapper().style.width, '120px', 'clip visible table width');
            equal(f.wrapper().firstElementChild.style.marginLeft, '-80px', 'horizontal offset');
            assert(!f.wrapper().querySelector('tbody'), 'only header is cloned');
            f.geometry.top = -480;
            f.scroller.dispatchEvent(new Event('scroll'));
            flushFrame();
            assert(!f.wrapper().classList.contains('tsh-visible'), 'stop before bottom of table');
            f.cleanup();
        });
        await test('table text edits and header replacement refresh the pinned header', async () => {
            const f = fixture();
            f.tables[0].querySelector('th').firstChild.data = 'Edited';
            await tick();
            equal(frames.size, 1, 'table edit schedules one frame');
            flushFrame();
            equal(f.wrapper().querySelector('th').textContent, 'Edited', 'characterData edit is reflected');
            const replacement = f.tables[0].querySelector('thead').cloneNode(true);
            replacement.querySelector('th').textContent = 'Replacement';
            f.tables[0].querySelector('thead').replaceWith(replacement);
            f.measure(f.tables[0]);
            await tick();
            flushFrame();
            equal(f.wrapper().querySelector('th').textContent, 'Replacement', 'new header is reflected');
            f.cleanup();
        });
        await test('resize and position-only boundary crossings update headers without timers', () => {
            const f = fixture({ sticky: false });
            const boundary = IntersectionObserver.instances.find((observer) => observer.targets.has(f.tables[0]));
            equal(boundary.options.rootMargin, '-30px 0px 0px 0px', 'boundary includes header height');
            f.geometry.top = -20;
            boundary.fire();
            flushFrame();
            assert(f.wrapper().classList.contains('tsh-visible'), 'position-only crossing shows header');
            f.geometry.width = 240;
            f.geometry.headerHeight = 40;
            const resize = ResizeObserver.instances.find((observer) => observer.targets.has(f.tables[0]));
            resize.fire();
            flushFrame();
            equal(f.wrapper().querySelector('th').style.width, '120px', 'resize updates cell width');
            equal(f.wrapper().style.height, '40px', 'resize updates header height');
            const nextBoundary = IntersectionObserver.instances.find((observer) => observer.targets.has(f.tables[0]));
            equal(nextBoundary.options.rootMargin, '-40px 0px 0px 0px', 'boundary follows resized header');
            f.cleanup();
        });
        await test('inserted tables are discovered locally and removed tables release resources', async () => {
            const f = fixture();
            const newTable = f.tables[0].cloneNode(true);
            f.root.querySelector('.horizontal').appendChild(newTable);
            f.measure(newTable);
            const beforeScans = scans;
            await tick();
            equal(frames.size, 1, 'insertion schedules one frame');
            flushFrame();
            equal(queryAll('.tsh-clone-wrapper').length, 2, 'new table is initialized');
            equal(scans, beforeScans, 'insertion does not scan the document');
            await tick();
            equal(frames.size, 0, 'clone mutations do not schedule work');
            newTable.remove();
            await tick();
            flushFrame();
            equal(queryAll('.tsh-clone-wrapper').length, 1, 'removed table clone is deleted');
            assert(!ResizeObserver.instances.some((observer) => observer.targets.has(newTable)), 'resize observer released');
            assert(!IntersectionObserver.instances.some((observer) => observer.targets.has(newTable)), 'boundary observer released');
            f.root.querySelector('.horizontal').appendChild(newTable);
            await tick();
            flushFrame();
            equal(queryAll('.tsh-clone-wrapper').length, 2, 'reinserted table is initialized again');
            f.cleanup();
        });
        await test('tables without headers can initialize later, and markmap tables are excluded', async () => {
            const f = fixture({ withTable: false });
            const table = document.createElement('table');
            f.scroller.appendChild(table);
            await tick();
            flushFrame();
            assert(!f.wrapper(), 'headerless table is not initialized');
            table.innerHTML = '<thead><tr><th>Added</th></tr></thead>';
            f.measure(table);
            await tick();
            flushFrame();
            assert(f.wrapper(), 'later header insertion retries setup');
            const excluded = document.createElement('div');
            excluded.className = 'markmap';
            excluded.appendChild(table.cloneNode(true));
            f.scroller.appendChild(excluded);
            await tick();
            flushFrame();
            equal(queryAll('.tsh-clone-wrapper').length, 1, 'markmap table excluded');
            f.cleanup();
        });
        await test('moving a table to another pane rebinds its scroll listeners', async () => {
            const first = fixture();
            const secondRoot = document.createElement('div');
            secondRoot.className = 'workspace-leaf-content';
            secondRoot.innerHTML = '<div class="markdown-preview-view"></div>';
            document.body.appendChild(secondRoot);
            const secondScroller = secondRoot.firstElementChild;
            secondScroller.appendChild(first.tables[0]);
            await tick();
            flushFrame();
            equal(queryAll('.tsh-clone-wrapper').length, 1, 'moved table has one clone');
            await tick();
            const beforeReads = first.metrics.reads;
            first.scroller.dispatchEvent(new Event('scroll'));
            equal(frames.size, 0, 'old pane listener removed');
            secondScroller.dispatchEvent(new Event('scroll'));
            equal(frames.size, 1, 'new pane listener installed');
            flushFrame();
            assert(first.metrics.reads > beforeReads, 'new pane scroll updates moved table');
            first.cleanup();
            secondRoot.remove();
        });
        await test('unload cancels pending work, observers, and late layout-ready callbacks', async () => {
            const f = fixture();
            f.scroller.dispatchEvent(new Event('scroll'));
            equal(frames.size, 1, 'pending frame');
            const lateReady = ready;
            f.cleanup();
            equal(frames.size, 0, 'frame cancelled');
            lateReady();
            equal(frames.size, 0, 'late ready callback ignored');
            equal(queryAll('.tsh-clone-wrapper').length, 0, 'all wrappers removed');
            equal(ResizeObserver.instances.filter((observer) => observer.targets.size).length, 0, 'all resize observers disconnected');
            equal(IntersectionObserver.instances.filter((observer) => observer.targets.size).length, 0, 'all boundary observers disconnected');
            await tick();
            equal(frames.size, 0, 'unload does not leave background work');
        });
        await test('native browser observers detect layout movement without scroll or table resize', async () => {
            const FakeResizeObserver = window.ResizeObserver;
            const FakeIntersectionObserver = window.IntersectionObserver;
            window.ResizeObserver = NativeResizeObserver;
            window.IntersectionObserver = NativeIntersectionObserver;
            const root = document.createElement('div');
            root.className = 'workspace-leaf-content';
            root.style.cssText = 'position:fixed;top:20px;left:20px';
            root.innerHTML = '<div class="markdown-preview-view" style="position:relative;width:300px;height:150px;overflow:auto;overflow-anchor:none"><div class="spacer" style="height:100px"></div><table style="border-collapse:collapse"><thead><tr><th style="height:30px">Header</th></tr></thead><tbody><tr><td style="height:300px">Body</td></tr></tbody></table></div>';
            document.body.appendChild(root);
            const scroller = root.firstElementChild;
            scroller.scrollTop = 50;
            const plugin = new StickyHeaders.default();
            try {
                plugin.onload();
                ready();
                flushFrame();
                const settle = async (condition) => {
                    for (let i = 0; i < 50; i++) {
                        await new Promise(NativeRequestAnimationFrame);
                        flushFrame();
                        if (condition()) return;
                    }
                    throw new Error(`Native observer did not update the header: scroll=${scroller.scrollTop}, tableTop=${root.querySelector('table').getBoundingClientRect().top}, containerTop=${scroller.getBoundingClientRect().top}, visible=${document.querySelector('.tsh-clone-wrapper').className}`);
                };
                const wrapper = document.querySelector('.tsh-clone-wrapper');
                await settle(() => !wrapper.classList.contains('tsh-visible'));
                root.querySelector('.spacer').style.height = '0px';
                // No scroll event, table edit, or table/header size change.
                await settle(() => wrapper.classList.contains('tsh-visible'));
                root.querySelector('.spacer').style.height = '100px';
                await settle(() => !wrapper.classList.contains('tsh-visible'));
            } finally {
                plugin.unload();
                root.remove();
                window.ResizeObserver = FakeResizeObserver;
                window.IntersectionObserver = FakeIntersectionObserver;
            }
        });
        output.textContent = [...results, 'ALL TESTS PASSED'].join('\n');
    } catch (error) {
        output.textContent = [...results, `FAIL ${error.stack}`].join('\n');
    }
}
