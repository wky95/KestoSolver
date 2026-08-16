// Boots app.js against a minimal DOM so its behaviour can be exercised in node.
// Each createApp() call is a fresh page load with its own localStorage.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

class ClassList {
    constructor() { this.set = new Set(); }
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
        this.classList = new ClassList();
        this.dataset = {};
        this.style = {};
        this.children = [];
        this.parent = null;
        this.handlers = {};
        this.textContent = '';
        this.title = '';
        this.value = '';
        this.disabled = false;
        this._rect = { left: 0, top: 0, width: 46, height: 46 };
    }
    set className(v) { this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get className() { return this.classList.value; }
    set innerHTML(v) { if (v === '') this.children.forEach(c => (c.parent = null)), (this.children = []); }
    addEventListener(t, fn) { (this.handlers[t] ||= []).push(fn); }
    fire(t, ev = {}) {
        (this.handlers[t] || []).forEach(fn => fn({ preventDefault() {}, target: this, ...ev }));
    }
    appendChild(c) { c.parent = this; this.children.push(c); return c; }
    append(...cs) { cs.forEach(c => this.appendChild(c)); }
    remove() {
        if (!this.parent) return;
        const i = this.parent.children.indexOf(this);
        if (i >= 0) this.parent.children.splice(i, 1);
        this.parent = null;
    }
    replaceChildren(...cs) {
        this.children.forEach(c => (c.parent = null));
        this.children = [];
        cs.forEach(c => this.appendChild(c));
    }
    getBoundingClientRect() { return this._rect; }
    scrollIntoView() {}
}

const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SOLVER_SRC = fs.readFileSync(path.join(ROOT, 'solver.js'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

function camel(s) { return s.replace(/-(\w)/g, (_, c) => c.toUpperCase()); }

// deferTimers holds setTimeout callbacks in a queue instead of running them
// inline, so a test can inspect the UI mid-operation (the "Solving..." message)
// before releasing the work.
function createApp({ mode = null, strength = 'fast', savedGrids = null, deferTimers = false, worker = false,
                     deviceMemory = undefined, coarsePointer = false } = {}) {
    const byId = new Map();
    const all = [];

    const mk = (tag, id, classes, data) => {
        const el = new El(tag);
        if (id) { el.id = id; byId.set(id, el); }
        classes.forEach(c => el.classList.add(c));
        Object.assign(el.dataset, data);
        all.push(el);
        return el;
    };

    // Mirror index.html so the shim cannot drift from the real markup.
    for (const m of HTML.matchAll(/<(\w+)([^>]*)\bid="([^"]+)"([^>]*)>/g)) {
        const attrs = m[2] + m[4];
        const cls = (attrs.match(/class="([^"]*)"/) || [, ''])[1].split(/\s+/).filter(Boolean);
        const data = {};
        for (const d of attrs.matchAll(/data-([\w-]+)="([^"]*)"/g)) data[camel(d[1])] = d[2];
        mk(m[1], m[3], cls, data);
    }
    for (const m of HTML.matchAll(/<(\w+)([^>]*)class="([^"]*)"([^>]*)>/g)) {
        const attrs = m[2] + m[4];
        if (/\bid="/.test(attrs)) continue;
        const data = {};
        for (const d of attrs.matchAll(/data-([\w-]+)="([^"]*)"/g)) data[camel(d[1])] = d[2];
        mk(m[1], null, m[3].split(/\s+/).filter(Boolean), data);
    }

    const body = mk('body', null, [], {});
    const docHandlers = {};
    const document = {
        body,
        getElementById: id => byId.get(id) || null,
        querySelectorAll: sel => {
            if (!sel.startsWith('.')) throw new Error('unsupported selector ' + sel);
            return all.filter(e => e.classList.contains(sel.slice(1)));
        },
        createElement: tag => new El(tag),
        addEventListener(t, fn) { (docHandlers[t] ||= []).push(fn); },
        fire(t, ev = {}) { (docHandlers[t] || []).forEach(fn => fn({ preventDefault() {}, target: null, ...ev })); },
    };

    const store = {};
    if (strength) store.kestoStrength = strength;
    if (savedGrids) {
        store.kestoBgGrid = JSON.stringify(savedGrids.bg);
        store.kestoFgGrid = JSON.stringify(savedGrids.fg);
    }

    const winHandlers = {};
    const timers = new Map();
    const deferred = [];
    let nextTimer = 1;

    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        performance,
        document,
        window: {
            addEventListener(t, fn) { (winHandlers[t] ||= []).push(fn); },
            location: { href: `http://local/${mode ? '?mode=' + mode : ''}`, search: mode ? '?mode=' + mode : '' },
            // Only the media query app.js actually asks about.
            matchMedia: (q) => ({ matches: q === '(pointer: coarse)' ? coarsePointer : false }),
        },
        navigator: { deviceMemory },
        history: { replaceState() {} },
        localStorage: {
            getItem: k => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); },
        },
        URL, URLSearchParams, HTMLInputElement: class {},
        setInterval: (fn, ms) => { const id = nextTimer++; timers.set(id, fn); return id; },
        clearInterval: id => { timers.delete(id); },
        setTimeout: fn => { if (deferTimers) deferred.push(fn); else fn(); return 0; },
    };
    sandbox.globalThis = sandbox;
    sandbox.__useWorker = worker;
    // Worker replies are asynchronous in a browser; route them through the same
    // queue as setTimeout so tests can look at the page mid-search.
    sandbox.__deliver = fn => { if (deferTimers) deferred.push(fn); else fn(); };
    vm.createContext(sandbox);

    vm.runInContext(SOLVER_SRC, sandbox);
    vm.runInContext(`
        globalThis.__fetchCalls = [];
        function fetchKestoPuzzle(id) {
            globalThis.__fetchCalls.push(id);
            return globalThis.__nextPuzzle
                ? Promise.resolve(globalThis.__nextPuzzle)
                : Promise.reject(new Error('network down'));
        }
        const KESTO_FIRST_LEVEL = '20260523';
        function kestoTodayId() { return '20260815'; }
        function kestoIdToInputValue(id) { return id; }
        function kestoInputValueToId(v) { return v; }
        function kestoShiftId(id, d) { return String(Number(id) + d); }
        // Off by default so app.js takes its synchronous path; with worker:true
        // a stand-in exercises the branch real browsers actually use, running
        // the solver inline and delivering the result through onmessage.
        if (globalThis.__useWorker) {
            globalThis.Worker = function () {
                const self = this;
                globalThis.__lastWorker = self;
                self.onmessage = null; self.onerror = null; self.terminated = false;
                self.postMessage = (data) => {
                    self.lastOptions = data.options;   // what the page actually asked for
                    globalThis.__deliver(() => {
                        if (self.terminated || !self.onmessage) return;
                        try {
                            const solver = new Solver(data.bgGrid, data.fgGrid);
                            const result = solver.solve({
                                ...data.options,
                                // Same channel the real worker uses, so the
                                // best-so-far display and cancelling are covered.
                                onBest: (best) => {
                                    if (!self.terminated && self.onmessage) {
                                        self.onmessage({ data: { type: 'best', best } });
                                    }
                                },
                                onPhase: (phase) => {
                                    if (!self.terminated && self.onmessage) {
                                        self.onmessage({ data: { type: 'phase', phase } });
                                    }
                                },
                            });
                            self.onmessage({ data: { type: 'done', result } });
                        } catch (err) {
                            self.onmessage({ data: { type: 'error', message: err.message } });
                        }
                    });
                };
                self.terminate = () => { self.terminated = true; };
            };
        } else {
            globalThis.Worker = function () { throw new Error('no workers in node'); };
        }
    `, sandbox);
    vm.runInContext(APP_SRC, sandbox);

    document.fire('DOMContentLoaded');

    const grid = byId.get('grid');
    grid._rect = { left: 0, top: 0, width: 400, height: 400 };
    grid.children.forEach((cell, i) => {
        cell._rect = { left: (i % 8) * 50, top: Math.floor(i / 8) * 50, width: 46, height: 46 };
    });

    const tabs = {};
    document.querySelectorAll('.mode-tab').forEach(t => (tabs[t.dataset.mode] = t));
    const tools = {};
    document.querySelectorAll('.tool-btn').forEach(t => (tools[t.dataset.tool] = t));
    const dpad = {};
    document.querySelectorAll('.dpad-btn').forEach(b => (dpad[b.dataset.dir] = b));

    return {
        document, byId, all, sandbox, store, winHandlers, timers, grid, tabs, tools, dpad,

        get mode() { return body.dataset.mode; },
        cell(r, c) { return grid.children[r * 8 + c]; },
        entities() { return grid.children.filter(c => c.classList.contains('block-entity')); },
        chips() { return byId.get('path-display').children; },
        panelVisible() { return !byId.get('solution-controls').classList.contains('hidden'); },
        step() { return Number(byId.get('current-step').textContent); },
        totalSteps() { return Number(byId.get('total-steps').textContent); },
        playMoves() { return Number(byId.get('play-move-count').textContent); },
        staticBlocks() { return grid.children.filter(c => c.classList.contains('block') && c.classList.contains('cell')).length; },

        setMode(m) { tabs[m].fire('click'); },
        paint(r, c, tool) { tools[tool].fire('click'); this.cell(r, c).fire('mousedown'); },
        solve() { byId.get('btn-solve').fire('click'); },
        key(k) { document.fire('keydown', { key: k }); },
        tickAutoplay(n = 1) { for (let i = 0; i < n; i++) [...timers.values()].forEach(fn => fn()); },
        flushTimers() { const q = deferred.splice(0); q.forEach(fn => fn()); return q.length; },
        solverText() { return byId.get('solver-message').textContent; },
        resize() { (winHandlers.resize || []).forEach(fn => fn({})); },
    };
}

module.exports = { createApp };
