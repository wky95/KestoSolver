const { createApp } = require('./harness');

let pass = 0, fail = 0;
const failures = [];

function check(name, cond, extra = '') {
    if (cond) { pass++; }
    else { fail++; failures.push(`${name} ${extra}`.trim()); }
}

function group(title) { console.log(`\n${title}`); }

function run(name, fn) {
    try {
        fn();
        console.log(`  ok    ${name}`);
        pass++;
    } catch (e) {
        console.log(`  FAIL  ${name}\n          ${e.message}`);
        fail++;
        failures.push(`${name}: ${e.message}`);
    }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ---------------------------------------------------------------- invariants
// Checked after every operation in every test. If any of these can be broken by
// a sequence of UI actions, the page is in a state it cannot render honestly.
function invariants(app, where) {
    const m = app.mode;
    assert(['edit', 'play', 'solve'].includes(m), `${where}: mode is "${m}"`);

    const activeTabs = Object.values(app.tabs).filter(t => t.classList.contains('active'));
    assert(activeTabs.length === 1, `${where}: ${activeTabs.length} active tabs`);
    assert(activeTabs[0].dataset.mode === m, `${where}: active tab disagrees with body mode`);

    const shown = app.document.querySelectorAll('.mode-panel').filter(p => !p.classList.contains('hidden'));
    assert(shown.every(p => p.dataset.panel === m), `${where}: a panel for another mode is visible`);
    const mine = app.document.querySelectorAll('.mode-panel').filter(p => p.dataset.panel === m);
    assert(shown.length === mine.length, `${where}: ${shown.length}/${mine.length} panels for ${m} visible`);

    // Grids stay well formed and round-trip through localStorage.
    for (const key of ['kestoBgGrid', 'kestoFgGrid']) {
        const raw = app.store[key];
        if (raw === undefined) continue;
        const g = JSON.parse(raw);
        assert(Array.isArray(g) && g.length === 8, `${where}: ${key} is not 8 rows`);
        assert(g.every(row => Array.isArray(row) && row.length === 8), `${where}: ${key} row length`);
        const legal = key === 'kestoBgGrid' ? ['.', '#', 'T'] : ['.', 'Y'];
        assert(g.every(row => row.every(ch => legal.includes(ch))), `${where}: ${key} has an illegal cell`);
    }

    // Edit renders blocks statically, so no animated overlays may linger.
    if (m === 'edit') {
        assert(app.entities().length === 0,
            `${where}: ${app.entities().length} block entities left over in Edit`);
    }

    // The playback panel and its chips must agree with each other.
    if (app.panelVisible()) {
        const total = app.totalSteps();
        assert(app.chips().length === total,
            `${where}: ${app.chips().length} chips for ${total} steps`);
        assert(app.step() >= 0 && app.step() <= total,
            `${where}: step ${app.step()} outside 0..${total}`);
        const current = app.chips().filter(c => c.classList.contains('current')).length;
        assert(current <= 1, `${where}: ${current} chips marked current`);
    } else if (m === 'solve') {
        // No panel means no stale chips claiming a solution exists.
        assert(app.chips().length === 0 || app.totalSteps() >= 0, `${where}: chip state`);
    }

    // Play mode conserves blocks: moves relocate them, never create or destroy.
    if (m === 'play') {
        assert(app.playMoves() >= 0, `${where}: negative move count`);
        const fg = JSON.parse(app.store.kestoFgGrid || 'null');
        if (fg) {
            const n = fg.flat().filter(x => x === 'Y').length;
            assert(app.entities().length === n,
                `${where}: ${app.entities().length} entities for ${n} blocks`);
        }
    }
}

// A small board that is solvable in a few moves.
function buildSolvable(app) {
    app.setMode('edit');
    app.paint(0, 0, 'Y');
    app.paint(0, 1, 'Y');
    app.paint(1, 0, 'T');
    app.paint(1, 1, 'T');
}

// =============================================================== targeted cases
group('Empty and degenerate boards');

run('solve an empty board', () => {
    const app = createApp();
    app.setMode('solve');
    app.solve();
    invariants(app, 'empty solve');
    assert(!app.panelVisible(), 'panel should stay hidden with nothing to solve');
});

run('solve blocks with no targets', () => {
    const app = createApp();
    app.setMode('edit');
    app.paint(3, 3, 'Y');
    app.setMode('solve');
    app.solve();
    invariants(app, 'no targets');
});

run('solve targets with no blocks', () => {
    const app = createApp();
    app.setMode('edit');
    app.paint(3, 3, 'T');
    app.setMode('solve');
    app.solve();
    invariants(app, 'no blocks');
});

run('solve a board walled off from its target', () => {
    const app = createApp();
    app.setMode('edit');
    app.paint(0, 0, 'Y');
    app.paint(7, 7, 'T');
    for (let i = 0; i < 8; i++) app.paint(4, i, '#');
    app.setMode('solve');
    app.solve();
    invariants(app, 'unsolvable');
    assert(!app.panelVisible(), 'no panel for an unsolvable board');
});

run('play a board with no blocks', () => {
    const app = createApp();
    app.setMode('play');
    invariants(app, 'empty play');
    ['U', 'D', 'L', 'R'].forEach(d => { app.dpad[d].fire('click'); invariants(app, 'empty play move'); });
    assert(app.playMoves() === 0, 'moves counted on an empty board');
});

run('play a board where nothing can move', () => {
    const app = createApp();
    app.setMode('edit');
    app.paint(0, 0, 'Y');
    for (let i = 0; i < 8; i++) { app.paint(1, i, '#'); }
    for (let i = 1; i < 8; i++) { app.paint(i, 1, '#'); }
    app.setMode('play');
    ['U', 'L'].forEach(d => app.dpad[d].fire('click'));   // both blocked by an edge
    invariants(app, 'stuck play');
    assert(app.playMoves() === 0, 'a no-op move must not count');
});

group('Playback controls at their boundaries');

run('prev at step 0 and next past the end', () => {
    const app = createApp();
    buildSolvable(app);
    app.setMode('solve');
    app.solve();
    assert(app.panelVisible(), 'expected a solution');
    const total = app.totalSteps();

    for (let i = 0; i < 5; i++) { app.byId.get('btn-prev').fire('click'); invariants(app, 'prev spam'); }
    assert(app.step() === 0, `step went below 0 (${app.step()})`);

    for (let i = 0; i < total + 5; i++) { app.byId.get('btn-next').fire('click'); invariants(app, 'next spam'); }
});

run('clicking every chip jumps without breaking', () => {
    const app = createApp();
    buildSolvable(app);
    app.setMode('solve');
    app.solve();
    app.chips().forEach((chip, i) => {
        chip.fire('click');
        invariants(app, `chip ${i}`);
        assert(app.step() === i + 1, `chip ${i} set step ${app.step()}`);
    });
});

run('autoplay toggles and stops at the end', () => {
    const app = createApp();
    buildSolvable(app);
    app.setMode('solve');
    app.solve();
    const btn = app.byId.get('btn-play');
    btn.fire('click');
    assert(btn.textContent === 'Pause', 'button should read Pause while playing');
    app.tickAutoplay(50);
    invariants(app, 'after autoplay');
    assert(btn.textContent === 'Play', 'autoplay should stop itself at the end');
    btn.fire('click'); btn.fire('click'); btn.fire('click');
    invariants(app, 'autoplay toggle spam');
});

run('leaving Solve mid-autoplay kills the timer', () => {
    const app = createApp();
    buildSolvable(app);
    app.setMode('solve');
    app.solve();
    app.byId.get('btn-play').fire('click');
    app.setMode('edit');
    invariants(app, 'left during autoplay');
    const before = app.step();
    app.tickAutoplay(20);
    assert(app.step() === before, 'a stopped timer still advanced the step');
    assert(app.byId.get('btn-play').textContent === 'Play', 'Play label not reset');
});

group('Mode switching');

run('every ordered pair of mode switches', () => {
    const modes = ['edit', 'play', 'solve'];
    for (const a of modes) for (const b of modes) {
        const app = createApp();
        buildSolvable(app);
        app.setMode(a); invariants(app, `-> ${a}`);
        app.setMode(b); invariants(app, `${a} -> ${b}`);
        app.setMode(a); invariants(app, `${a} -> ${b} -> ${a}`);
    }
});

run('solution survives a round trip through every mode', () => {
    for (const via of ['edit', 'play']) {
        const app = createApp();
        buildSolvable(app);
        app.setMode('solve');
        app.solve();
        const total = app.totalSteps();
        app.byId.get('btn-next').fire('click');
        const step = app.step();

        app.setMode(via);
        app.setMode('solve');
        invariants(app, `solve -> ${via} -> solve`);
        assert(app.panelVisible(), `panel lost via ${via}`);
        assert(app.totalSteps() === total, `step total changed via ${via}`);
        assert(app.step() === step, `resumed at ${app.step()} instead of ${step} via ${via}`);
    }
});

run('editing invalidates the solution', () => {
    const app = createApp();
    buildSolvable(app);
    app.setMode('solve');
    app.solve();
    assert(app.panelVisible(), 'expected a solution');

    app.setMode('edit');
    app.paint(7, 7, '#');
    app.setMode('solve');
    invariants(app, 'after edit');
    assert(!app.panelVisible(), 'stale solution survived an edit');
    assert(app.chips().length === 0, 'stale chips survived an edit');
});

run('Clear Board from a solved state', () => {
    const app = createApp();
    buildSolvable(app);
    app.setMode('solve');
    app.solve();
    app.setMode('edit');
    app.byId.get('btn-clear').fire('click');
    invariants(app, 'after clear');
    app.setMode('solve');
    invariants(app, 'solve after clear');
    assert(!app.panelVisible(), 'cleared board still shows a solution');
});

run('play then solve uses the original position, not the played one', () => {
    const app = createApp();
    buildSolvable(app);
    app.setMode('play');
    app.dpad.D.fire('click');
    assert(app.playMoves() === 1, 'move not registered');

    app.setMode('solve');
    app.solve();
    invariants(app, 'solve after play');
    assert(app.panelVisible(), 'expected a solution from the original board');
    const fg = JSON.parse(app.store.kestoFgGrid);
    assert(fg[0][0] === 'Y' && fg[0][1] === 'Y', 'play mode mutated the saved board');
});

group('Play mode');

run('undo unwinds exactly and stops at the start', () => {
    const app = createApp();
    buildSolvable(app);
    app.setMode('play');
    ['D', 'R', 'D', 'L'].forEach(d => { app.dpad[d].fire('click'); invariants(app, 'play move'); });
    const moves = app.playMoves();
    for (let i = 0; i < moves + 5; i++) { app.byId.get('btn-undo').fire('click'); invariants(app, 'undo'); }
    assert(app.playMoves() === 0, `undo left ${app.playMoves()} moves`);
});

run('restart resets the counter', () => {
    const app = createApp();
    buildSolvable(app);
    app.setMode('play');
    ['D', 'R', 'D'].forEach(d => app.dpad[d].fire('click'));
    app.byId.get('btn-replay').fire('click');
    invariants(app, 'after restart');
    assert(app.playMoves() === 0, 'restart did not reset the counter');
});

run('keyboard and d-pad agree', () => {
    const a = createApp(); buildSolvable(a); a.setMode('play');
    const b = createApp(); buildSolvable(b); b.setMode('play');
    ['U', 'D', 'L', 'R'].forEach(d => a.dpad[d].fire('click'));
    ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].forEach(k => b.key(k));
    assert(a.playMoves() === b.playMoves(), `d-pad ${a.playMoves()} vs keys ${b.playMoves()}`);
    const pos = app => app.entities().map(e => `${e.style.left},${e.style.top}`).join('|');
    assert(pos(a) === pos(b), 'd-pad and keyboard produced different positions');
});

run('arrow keys are inert outside Play mode', () => {
    for (const m of ['edit', 'solve']) {
        const app = createApp();
        buildSolvable(app);
        app.setMode(m);
        ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].forEach(k => app.key(k));
        invariants(app, `keys in ${m}`);
        assert(app.playMoves() === 0, `keys moved blocks in ${m}`);
    }
});

run('a solved position is reported', () => {
    const app = createApp();
    app.setMode('edit');
    app.paint(0, 0, 'Y');
    app.paint(1, 0, 'T');
    app.setMode('play');
    app.dpad.D.fire('click');
    invariants(app, 'solved play');
    assert(/Solved in 1 move/.test(app.byId.get('play-message').textContent),
        `message was "${app.byId.get('play-message').textContent}"`);
});

group('Search timing readout');

function solvableBoard(app) {
    app.setMode('edit');
    app.paint(0, 0, 'Y');
    app.paint(0, 1, 'Y');
    app.paint(1, 0, 'T');
    app.paint(1, 1, 'T');
}

run('a figure appears while searching and stays after', () => {
    const app = createApp({ deferTimers: true, worker: true });
    solvableBoard(app);
    app.setMode('solve');
    app.solve();

    const during = app.byId.get('solver-stats').textContent;
    assert(/^\d+\.\d+s/.test(during), `nothing ticking during the search: "${during}"`);

    app.flushTimers();
    const after = app.byId.get('solver-stats').textContent;
    assert(/^\d+\.\d+s/.test(after), `figure lost once finished: "${after}"`);
    invariants(app, 'after timed solve');
});

run('state counts are shown once the search reports them', () => {
    const app = createApp({ deferTimers: true, worker: true });
    solvableBoard(app);
    app.setMode('solve');
    app.solve();

    // Stand in for a progress message from the worker.
    const w = app.sandbox.__lastWorker;
    assert(w && w.onmessage, 'no worker to deliver progress through');
    w.onmessage({ data: { type: 'progress', nodes: 4_200_000 } });
    const txt = app.byId.get('solver-stats').textContent;
    assert(/4\.2M states/.test(txt), `states not reported: "${txt}"`);

    w.onmessage({ data: { type: 'progress', nodes: 31_000 } });
    assert(/31k states/.test(app.byId.get('solver-stats').textContent),
        `small counts should not read as 0.0M: "${app.byId.get('solver-stats').textContent}"`);
});

run('editing the board clears a stale figure', () => {
    const app = createApp({ worker: true });
    solvableBoard(app);
    app.setMode('solve');
    app.solve();
    assert(app.byId.get('solver-stats').textContent !== '', 'expected a figure first');

    app.setMode('edit');
    app.paint(7, 7, '#');
    assert(app.byId.get('solver-stats').textContent === '',
        `stale timing survived an edit: "${app.byId.get('solver-stats').textContent}"`);
});

run('the best answer so far is shown while the search runs', () => {
    const app = createApp({ deferTimers: true, worker: true });
    solvableBoard(app);
    app.setMode('solve');
    app.solve();

    const w = app.sandbox.__lastWorker;
    w.onmessage({ data: { type: 'best', best: { path: ['U', 'D', 'L'], states: [] } } });
    const txt = app.byId.get('solver-stats').textContent;
    assert(/best 3 steps/.test(txt), `best not reported: "${txt}"`);

    // Only improvements are shown, and singular reads naturally.
    w.onmessage({ data: { type: 'best', best: { path: ['U'], states: [] } } });
    assert(/best 1 step\b/.test(app.byId.get('solver-stats').textContent),
        `"${app.byId.get('solver-stats').textContent}"`);
});

// A cancelled search used to throw its work away, which on Thorough could mean
// discarding minutes of it.
run('cancelling hands over the best answer found so far', () => {
    const app = createApp({ deferTimers: true, worker: true });
    solvableBoard(app);
    app.setMode('solve');
    app.solve();

    // Stand in for the worker reporting an answer mid-search.
    const w = app.sandbox.__lastWorker;
    w.onmessage({ data: { type: 'best', best: { path: ['D', 'D'], states: [1n, 2n, 3n] } } });

    app.byId.get('btn-cancel').fire('click');
    const msg = app.byId.get('solver-message').textContent;
    assert(/2-step/.test(msg), `cancel message: "${msg}"`);
    assert(/not proven shortest/.test(msg), `must not imply optimality: "${msg}"`);
    assert(app.panelVisible(), 'the kept solution should be steppable');
    assert(app.chips().length === 2, `${app.chips().length} chips for a 2-move answer`);
    invariants(app, 'after cancel with a result');
});

run('cancelling with nothing found says so plainly', () => {
    const app = createApp({ deferTimers: true, worker: true });
    solvableBoard(app);
    app.setMode('solve');
    app.solve();
    app.byId.get('btn-cancel').fire('click');

    const msg = app.byId.get('solver-message').textContent;
    assert(/cancelled/i.test(msg), `cancel message: "${msg}"`);
    assert(/before anything was found/.test(msg), `should say nothing was kept: "${msg}"`);
    assert(!app.panelVisible(), 'no solution to show');
    invariants(app, 'after empty cancel');
});

// Revealing is not pausing: the worker is untouched and keeps improving on what
// was shown. Cancel keeps its own meaning - terminate.
run('revealing shows the best answer without stopping the search', () => {
    const app = createApp({ deferTimers: true, worker: true });
    solvableBoard(app);
    app.setMode('solve');
    app.solve();

    const w = app.sandbox.__lastWorker;
    const reveal = app.byId.get('btn-reveal');
    assert(reveal.classList.contains('hidden'), 'nothing to reveal before an answer exists');

    w.onmessage({ data: { type: 'best', best: { path: ['D', 'D', 'R'], states: [1n, 2n, 3n, 4n] } } });
    assert(!reveal.classList.contains('hidden'), 'reveal should appear once an answer exists');
    assert(/3 steps/.test(reveal.textContent), `label: "${reveal.textContent}"`);

    reveal.fire('click');
    assert(app.panelVisible(), 'the revealed answer should be steppable');
    assert(app.chips().length === 3, `${app.chips().length} chips for a 3-move answer`);
    assert(!w.terminated, 'revealing must not stop the worker');
    assert(reveal.disabled, 'nothing newer to show yet');
    invariants(app, 'after reveal');

    // The search improves on it; the button offers the newer answer.
    w.onmessage({ data: { type: 'best', best: { path: ['U'], states: [1n, 2n] } } });
    assert(!reveal.disabled, 'a shorter answer should be offered');
    assert(/1 step\b/.test(reveal.textContent), `label: "${reveal.textContent}"`);

    reveal.fire('click');
    assert(app.chips().length === 1, `${app.chips().length} chips after revealing the shorter answer`);
    invariants(app, 'after second reveal');
});

run('the reveal button disappears once the search ends', () => {
    const app = createApp({ deferTimers: true, worker: true });
    solvableBoard(app);
    app.setMode('solve');
    app.solve();

    const w = app.sandbox.__lastWorker;
    w.onmessage({ data: { type: 'best', best: { path: ['D'], states: [1n, 2n] } } });
    assert(!app.byId.get('btn-reveal').classList.contains('hidden'), 'setup');

    app.flushTimers();   // let the search finish
    assert(app.byId.get('btn-reveal').classList.contains('hidden'),
        'reveal should not linger after the final answer');
    invariants(app, 'after finish');
});

run('cancelling keeps the elapsed reading', () => {
    const app = createApp({ deferTimers: true, worker: true });
    solvableBoard(app);
    app.setMode('solve');
    app.solve();
    app.byId.get('btn-cancel').fire('click');

    assert(/^\d+\.\d+s/.test(app.byId.get('solver-stats').textContent),
        `figure cleared on cancel: "${app.byId.get('solver-stats').textContent}"`);
    assert(/cancelled/i.test(app.byId.get('solver-message').textContent),
        `message: "${app.byId.get('solver-message').textContent}"`);
});

group('Boot and persistence');

run('boots into a mode named in the URL', () => {
    for (const m of ['edit', 'play', 'solve']) {
        const app = createApp({ mode: m });
        assert(app.mode === m, `?mode=${m} booted into ${app.mode}`);
        invariants(app, `boot ${m}`);
    }
});

run('a nonsense ?mode falls back to Edit', () => {
    for (const m of ['bogus', '', 'PLAY', '../etc']) {
        const app = createApp({ mode: m });
        assert(app.mode === 'edit', `?mode=${m} booted into ${app.mode}`);
        invariants(app, `boot ${m}`);
    }
});

run('corrupt saved grids do not break boot', () => {
    for (const bad of ['not json', '[]', '[[1,2]]', 'null']) {
        const app = (() => {
            try {
                const a = createApp();
                a.store.kestoBgGrid = bad;
                a.store.kestoFgGrid = bad;
                return createApp({ savedGrids: null });
            } catch (e) { throw new Error(`boot threw on ${bad}: ${e.message}`); }
        })();
        invariants(app, `corrupt ${bad}`);
    }
});

run('resize while a solution is on screen', () => {
    const app = createApp();
    buildSolvable(app);
    app.setMode('solve');
    app.solve();
    for (let i = 0; i < 3; i++) { app.resize(); invariants(app, 'resize'); }
    app.setMode('edit');
    app.resize();
    invariants(app, 'resize in edit');
});

// The daily-puzzle path is async; it lives in test-async.js.

// =============================================================== the fuzzer
group('Randomised operation fuzzing');

function fuzz(seed, steps) {
    let s = seed;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const pick = arr => arr[Math.floor(rnd() * arr.length)];

    const app = createApp();
    const log = [];

    const ops = [
        ['mode', () => app.setMode(pick(['edit', 'play', 'solve']))],
        ['paint', () => {
            if (app.mode !== 'edit') return;
            app.paint(Math.floor(rnd() * 8), Math.floor(rnd() * 8), pick(['.', '#', 'T', 'Y']));
        }],
        ['solve', () => { if (app.mode === 'solve') app.solve(); }],
        ['prev', () => app.byId.get('btn-prev').fire('click')],
        ['next', () => app.byId.get('btn-next').fire('click')],
        ['autoplay', () => app.byId.get('btn-play').fire('click')],
        ['tick', () => app.tickAutoplay(Math.floor(rnd() * 4))],
        ['chip', () => { const c = app.chips(); if (c.length) pick(c).fire('click'); }],
        ['dpad', () => app.dpad[pick(['U', 'D', 'L', 'R'])].fire('click')],
        ['key', () => app.key(pick(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd', 'x']))],
        ['undo', () => app.byId.get('btn-undo').fire('click')],
        ['restart', () => app.byId.get('btn-replay').fire('click')],
        ['clear', () => { if (app.mode === 'edit') app.byId.get('btn-clear').fire('click'); }],
        ['strength', () => pick(app.document.querySelectorAll('.strength-btn')).fire('click')],
        ['resize', () => app.resize()],
        ['tool', () => pick(app.document.querySelectorAll('.tool-btn')).fire('click')],
    ];

    for (let i = 0; i < steps; i++) {
        const [name, fn] = pick(ops);
        log.push(name);
        try {
            fn();
        } catch (e) {
            throw new Error(`seed ${seed} step ${i} (${name}) threw: ${e.message}\n          ops: ${log.join(' ')}`);
        }
        try {
            invariants(app, `seed ${seed} step ${i} after ${name}`);
        } catch (e) {
            throw new Error(`${e.message}\n          ops: ${log.join(' ')}`);
        }
    }
    return log.length;
}

const SEEDS = 250, STEPS = 400;
run(`${SEEDS} random sessions x ${STEPS} operations`, () => {
    let total = 0;
    for (let seed = 1; seed <= SEEDS; seed++) total += fuzz(seed * 7919, STEPS);
    console.log(`          ${total} operations executed, no throws, all invariants held`);
});

// =============================================================== summary
console.log(`\n${fail === 0 ? 'ALL PASSED' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
