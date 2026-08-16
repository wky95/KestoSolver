// Drives app.js against a minimal DOM shim to reproduce the reported sequence:
// solve -> Edit -> Solve, and assert the solution panel comes back intact.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

// ---------- tiny DOM ----------
class ClassList {
    constructor(el) { this.el = el; this.set = new Set(); }
    add(...c) { c.forEach(x => this.set.add(x)); }
    remove(...c) { c.forEach(x => this.set.delete(x)); }
    contains(c) { return this.set.has(c); }
    toggle(c, force) {
        const on = force === undefined ? !this.set.has(c) : !!force;
        if (on) this.set.add(c); else this.set.delete(c);
        return on;
    }
    get value() { return [...this.set].join(' '); }
}

class El {
    constructor(tag) {
        this.tagName = (tag || 'div').toUpperCase();
        this.classList = new ClassList(this);
        this.dataset = {};
        this.style = {};
        this.children = [];
        this.parent = null;
        this.handlers = {};
        this.textContent = '';
        this.title = '';
        this.disabled = false;
        this._rect = { left: 0, top: 0, width: 40, height: 40 };
    }
    set className(v) {
        this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean));
    }
    get className() { return this.classList.value; }
    set innerHTML(v) { if (v === '') this.children = []; }
    addEventListener(t, fn) { (this.handlers[t] ||= []).push(fn); }
    fire(t, ev = {}) { (this.handlers[t] || []).forEach(fn => fn({ preventDefault() {}, target: this, ...ev })); }
    appendChild(c) { c.parent = this; this.children.push(c); return c; }
    append(...cs) { cs.forEach(c => this.appendChild(c)); }
    remove() {
        if (!this.parent) return;
        const i = this.parent.children.indexOf(this);
        if (i >= 0) this.parent.children.splice(i, 1);
        this.parent = null;
    }
    replaceChildren(...cs) { this.children.forEach(c => (c.parent = null)); this.children = []; cs.forEach(c => this.appendChild(c)); }
    getBoundingClientRect() { return this._rect; }
    scrollIntoView() {}
}

const byId = new Map();
const all = [];

function mk(tag, id, classes = [], data = {}) {
    const el = new El(tag);
    if (id) { el.id = id; byId.set(id, el); }
    classes.forEach(c => el.classList.add(c));
    Object.assign(el.dataset, data);
    all.push(el);
    return el;
}

// Build exactly the ids/classes index.html declares, read from the real file so
// the shim cannot drift from the markup.
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
for (const m of html.matchAll(/<(\w+)([^>]*)\bid="([^"]+)"([^>]*)>/g)) {
    const [, tag, pre, id, post] = m;
    const attrs = pre + post;
    const cls = (attrs.match(/class="([^"]*)"/) || [, ''])[1].split(/\s+/).filter(Boolean);
    const data = {};
    for (const d of attrs.matchAll(/data-([\w-]+)="([^"]*)"/g)) data[d[1].replace(/-(\w)/g, (_, c) => c.toUpperCase())] = d[2];
    mk(tag, id, cls, data);
}
// Elements addressed only by class.
for (const m of html.matchAll(/<(\w+)([^>]*)class="([^"]*)"([^>]*)>/g)) {
    const [, tag, pre, cls, post] = m;
    const attrs = pre + post;
    if (/\bid="/.test(attrs)) continue;
    const data = {};
    for (const d of attrs.matchAll(/data-([\w-]+)="([^"]*)"/g)) data[d[1].replace(/-(\w)/g, (_, c) => c.toUpperCase())] = d[2];
    mk(tag, null, cls.split(/\s+/).filter(Boolean), data);
}

const body = mk('body', null, []);
const document = {
    body,
    getElementById: id => byId.get(id) || null,
    querySelectorAll: sel => {
        if (sel.startsWith('.')) return all.filter(e => e.classList.contains(sel.slice(1)));
        throw new Error('unsupported selector ' + sel);
    },
    createElement: tag => new El(tag),
    addEventListener(t, fn) { (this._h ||= {}); (this._h[t] ||= []).push(fn); },
    fire(t, ev = {}) { ((this._h || {})[t] || []).forEach(fn => fn({ preventDefault() {}, target: null, ...ev })); }
};

const store = {};
const sandbox = {
    console, document, performance,
    window: { addEventListener() {}, location: { href: 'http://x/', search: '' } },
    history: { replaceState() {} },
    localStorage: {
        getItem: k => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
    },
    URL, URLSearchParams, Set, Map, HTMLInputElement: class {},
    setInterval: () => 0, clearInterval: () => {}, setTimeout: (f) => { f(); return 0; },
    Worker: undefined,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// Real solver, plus stubs for the kesto API app.js expects.
vm.runInContext(fs.readFileSync(path.join(ROOT, 'solver.js'), 'utf8'), sandbox);
vm.runInContext(`
    function fetchKestoPuzzle() { throw new Error('not used'); }
    const KESTO_FIRST_LEVEL = '20260523';
    function kestoTodayId() { return '20260815'; }
    function kestoIdToInputValue(id) { return id; }
    function kestoInputValueToId(v) { return v; }
    function kestoShiftId(id) { return id; }
`, sandbox);

// Worker construction must fail so app.js takes its synchronous fallback.
vm.runInContext(`globalThis.Worker = function () { throw new Error('no workers here'); };`, sandbox);

vm.runInContext(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'), sandbox);

// ---------- run ----------
const grid = byId.get('grid');
grid._rect = { left: 0, top: 0, width: 400, height: 400 };

document.fire('DOMContentLoaded');

// initGrid() built 64 cells; give them positions so measurement works.
grid.children.forEach((cell, i) => {
    const r = Math.floor(i / 8), c = i % 8;
    cell._rect = { left: c * 50, top: r * 50, width: 46, height: 46 };
});

const tabs = Object.fromEntries(document.querySelectorAll('.mode-tab').map(t => [t.dataset.mode, t]));
const controls = byId.get('solution-controls');
const pathDisplay = byId.get('path-display');
const solverMessage = byId.get('solver-message');

let failures = 0;
function check(name, cond, extra = '') {
    if (cond) { console.log(`  ok   ${name}`); }
    else { failures++; console.log(`  FAIL ${name} ${extra}`); }
}

// A tiny solvable board: two blocks, two targets one square away.
function paint(cellIndex, tool) {
    document.querySelectorAll('.tool-btn').find(b => b.dataset.tool === tool).fire('click');
    grid.children[cellIndex].fire('mousedown');
}

console.log('build a board in Edit mode');
paint(0, 'Y');          // block at (0,0)
paint(1, 'Y');          // block at (0,1)
paint(8, 'T');          // target at (1,0)
paint(9, 'T');          // target at (1,1)

console.log('switch to Solve and solve');
tabs.solve.fire('click');
byId.get('btn-solve').fire('click');

check('solution panel visible after solving', !controls.classList.contains('hidden'));
check('move chips rendered', pathDisplay.children.length > 0, `(got ${pathDisplay.children.length})`);
const chipsAfterSolve = pathDisplay.children.length;
const messageAfterSolve = solverMessage.textContent;

console.log('switch to Edit');
tabs.edit.fire('click');
check('panel hidden while in Edit', controls.classList.contains('hidden'));

console.log('switch back to Solve');
tabs.solve.fire('click');
check('solution panel visible again', !controls.classList.contains('hidden'));
check('move chips still there', pathDisplay.children.length === chipsAfterSolve,
    `(expected ${chipsAfterSolve}, got ${pathDisplay.children.length})`);
check('status message preserved', solverMessage.textContent === messageAfterSolve,
    `(got "${solverMessage.textContent}")`);

console.log('edit the board, then return to Solve');
tabs.edit.fire('click');
paint(63, '#');         // a real change
tabs.solve.fire('click');
check('stale solution discarded after an edit', controls.classList.contains('hidden'));
check('chips cleared after an edit', pathDisplay.children.length === 0,
    `(got ${pathDisplay.children.length})`);
check('solve button available again', !byId.get('btn-solve').classList.contains('hidden'));

console.log(`\n${failures === 0 ? 'all checks passed' : failures + ' FAILURES'}`);
process.exit(failures === 0 ? 0 : 1);
