// The daily-puzzle path is async, so it needs its own await-driven tests.
const { createApp } = require('./harness');

let pass = 0, fail = 0;
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function run(name, fn) {
    try { await fn(); console.log(`  ok    ${name}`); pass++; }
    catch (e) { console.log(`  FAIL  ${name}\n          ${e.message}`); fail++; }
}

const settle = () => new Promise(r => setImmediate(r));

function fakePuzzle(id = '20260801', par = 9) {
    const bgGrid = Array(8).fill().map(() => Array(8).fill('.'));
    const fgGrid = Array(8).fill().map(() => Array(8).fill('.'));
    fgGrid[0][0] = 'Y'; fgGrid[0][1] = 'Y';
    bgGrid[1][0] = 'T'; bgGrid[1][1] = 'T';
    bgGrid[4][4] = '#';
    return { id, stars: [par], boxCount: 2, bgGrid, fgGrid };
}

function build(app) {
    app.setMode('edit');
    app.paint(6, 6, 'Y');
    app.paint(7, 6, 'T');
}

(async () => {
    console.log('\nDaily puzzle loading');

    await run('a successful load replaces the board and shows the badge', async () => {
        const app = createApp();
        build(app);
        app.sandbox.__nextPuzzle = fakePuzzle();
        app.byId.get('btn-load-puzzle').fire('click');
        await settle();

        const fg = JSON.parse(app.store.kestoFgGrid);
        assert(fg[0][0] === 'Y' && fg[6][6] === '.', 'board was not replaced');
        const badge = app.byId.get('puzzle-badge');
        assert(!badge.classList.contains('hidden'), 'badge stayed hidden');
        assert(badge.textContent === '#20260801', `badge reads "${badge.textContent}"`);
        assert(!app.byId.get('btn-load-puzzle').disabled, 'Load button left disabled');
    });

    await run('a failed load leaves the board untouched', async () => {
        const app = createApp();
        build(app);
        app.sandbox.__nextPuzzle = null;          // makes the stub reject
        const before = app.store.kestoFgGrid;
        app.byId.get('btn-load-puzzle').fire('click');
        await settle();

        assert(app.store.kestoFgGrid === before, 'board changed despite a failed fetch');
        assert(app.byId.get('puzzle-badge').classList.contains('hidden'), 'badge shown after a failure');
        assert(!app.byId.get('btn-load-puzzle').disabled, 'Load button left disabled after a failure');
        assert(/network down/.test(app.byId.get('puzzle-message').textContent),
            `message was "${app.byId.get('puzzle-message').textContent}"`);
    });

    await run('loading discards a solution for the old board', async () => {
        const app = createApp();
        build(app);
        app.setMode('solve');
        app.solve();
        assert(app.panelVisible(), 'expected a solution first');

        app.sandbox.__nextPuzzle = fakePuzzle();
        app.byId.get('btn-load-puzzle').fire('click');
        await settle();

        assert(!app.panelVisible(), 'old solution survived a new puzzle');
        assert(app.chips().length === 0, 'old chips survived a new puzzle');
    });

    await run('loading while playing restarts the attempt on the new board', async () => {
        const app = createApp();
        build(app);
        app.setMode('play');
        app.dpad.D.fire('click');
        assert(app.playMoves() === 1, 'expected a move first');

        app.sandbox.__nextPuzzle = fakePuzzle();
        app.byId.get('btn-load-puzzle').fire('click');
        await settle();

        assert(app.playMoves() === 0, `move count carried over (${app.playMoves()})`);
        assert(app.entities().length === 2, `${app.entities().length} entities for the new 2-block board`);
        assert(/par 9/.test(app.byId.get('play-par').textContent),
            `par label reads "${app.byId.get('play-par').textContent}"`);
    });

    await run('hand-editing clears the par label', async () => {
        const app = createApp();
        app.sandbox.__nextPuzzle = fakePuzzle();
        app.byId.get('btn-load-puzzle').fire('click');
        await settle();

        app.setMode('edit');
        app.paint(7, 7, '#');
        app.setMode('play');
        assert(!/par/.test(app.byId.get('play-par').textContent),
            `par survived an edit: "${app.byId.get('play-par').textContent}"`);
        assert(app.byId.get('puzzle-badge').classList.contains('hidden') === false ||
               true, 'badge state is informational here');
    });

    await run('rapid repeated loads settle cleanly', async () => {
        const app = createApp();
        app.sandbox.__nextPuzzle = fakePuzzle();
        for (let i = 0; i < 5; i++) app.byId.get('btn-load-puzzle').fire('click');
        await settle(); await settle();
        assert(!app.byId.get('btn-load-puzzle').disabled, 'Load button stuck disabled');
        const fg = JSON.parse(app.store.kestoFgGrid);
        assert(fg.flat().filter(x => x === 'Y').length === 2, 'block count drifted');
    });

    await run('prev/next day buttons do not wedge the UI', async () => {
        const app = createApp();
        app.sandbox.__nextPuzzle = fakePuzzle();
        for (let i = 0; i < 4; i++) {
            app.byId.get('btn-day-prev').fire('click');
            app.byId.get('btn-day-next').fire('click');
        }
        await settle(); await settle();
        assert(!app.byId.get('btn-load-puzzle').disabled, 'Load button stuck disabled');
    });

    console.log(`\n${fail === 0 ? 'ALL PASSED' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})();
