// The beam fallback runs when the exact search cannot prove anything. It must
// never dress its answer up as a proven-optimal one, and it must never cost the
// exact search anything - it used to be gated behind a switch that carved 40%
// off the exact budget up front, which could turn a proven answer into none.
const fs = require('fs'), vm = require('vm'), path = require('path');
const { createApp } = require('./harness');
const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');

let pass = 0, fail = 0;
function assert(c, m) { if (!c) throw new Error(m); }
function run(name, fn) {
    try { fn(); console.log(`  ok    ${name}`); pass++; }
    catch (e) { console.log(`  FAIL  ${name}\n          ${e.message}`); fail++; }
}
function freshSolver() {
    const sb = { console, performance, Math, Number, BigInt, Array, Set, Map, JSON, Error, String };
    sb.globalThis = sb; vm.createContext(sb);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'solver.js'), 'utf8') + '\nglobalThis.__S = Solver;', sb);
    return sb.__S;
}

// Independent replayer: mirrors the Play-mode rule, not the solver's own code.
function replayReaches(bg, fg, moves) {
    let blocks = [];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (fg[r][c] === 'Y') blocks.push({ r, c });
    for (const dir of moves) {
        const isRow = dir === 'L' || dir === 'R', step = (dir === 'U' || dir === 'L') ? -1 : 1;
        const occ = new Set(blocks.map(b => b.r * 8 + b.c)), sh = new Map();
        for (let line = 0; line < 8; line++) {
            const at = i => isRow ? { r: line, c: i } : { r: i, c: line };
            const has = i => { const p = at(i); return occ.has(p.r * 8 + p.c); };
            const wall = i => { const p = at(i); return bg[p.r][p.c] === '#'; };
            let i = 0;
            while (i < 8) {
                if (!has(i)) { i++; continue; }
                let j = i; while (j + 1 < 8 && has(j + 1)) j++;
                const lead = step > 0 ? j : i, ahead = lead + step;
                if (ahead >= 0 && ahead <= 7 && !wall(ahead)) {
                    for (let k = i; k <= j; k++) { const f = at(k), t = at(k + step); sh.set(f.r * 8 + f.c, t.r * 8 + t.c); }
                }
                i = j + 1;
            }
        }
        if (!sh.size) return false;
        blocks = blocks.map(b => { const m = sh.get(b.r * 8 + b.c); return m === undefined ? b : { r: m >> 3, c: m & 7 }; });
    }
    const t = [];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (bg[r][c] === 'T') t.push(r * 8 + c);
    const occ = new Set(blocks.map(b => b.r * 8 + b.c));
    return t.length === blocks.length && t.every(x => occ.has(x));
}

const HARD = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'puzzle-20260815.json'), 'utf8'));
const Solver = freshSolver();
const BUDGET = { totalTimeBudgetMs: 4000, maxStates: 3000000 };

console.log('\nBeam fallback');

let offResult, onResult;

run('with no fallback, the hard board is reported unsolved rather than guessed at', () => {
    offResult = new Solver(HARD.bg, HARD.fg).solve({ ...BUDGET, beamWidth: 0 });
    assert(offResult.success === false, 'exact search claimed success on a board it cannot finish');
    assert(/higher search strength/.test(offResult.message), `unhelpful message: "${offResult.message}"`);
});

run('with the fallback, the same board returns a solution', () => {
    onResult = new Solver(HARD.bg, HARD.fg).solve({ ...BUDGET, beamWidth: 20000 });
    assert(onResult.success === true, `the fallback found nothing: "${onResult.message}"`);
    assert(onResult.path.length > 0, 'empty path');
});

run('a fallback answer is never labelled optimal', () => {
    assert(onResult.optimal === false, 'a beam result claimed to be optimal');
    assert(!/[Oo]ptimal/.test(onResult.message), `message implies optimality: "${onResult.message}"`);
    assert(/not proven shortest/.test(onResult.message), `message must say so plainly: "${onResult.message}"`);
});

run('the returned path actually solves the board', () => {
    assert(replayReaches(HARD.bg, HARD.fg, onResult.path),
        `a ${onResult.path.length}-move path did not reach the goal`);
});

run('states line up with the path', () => {
    assert(onResult.states.length === onResult.path.length + 1,
        `${onResult.states.length} states for ${onResult.path.length} moves`);
});

// Block count is not a difficulty proxy: 20260613 has 8 blocks and still needs
// Thorough. Whether the exact search finishes in budget is the real dividing
// line, so ask it first and only hold the beam runs to the same standard.
run('every board the exact search can finish keeps its optimality proof', () => {
    let checked = 0;
    for (const f of fs.readdirSync(FIXTURES).filter(x => /^puzzle-\d+\.json$/.test(x)).sort()) {
        const P = JSON.parse(fs.readFileSync(path.join(FIXTURES, f), 'utf8'));
        const exact = new Solver(P.bg, P.fg).solve({ ...BUDGET, beamWidth: 0 });
        if (!(exact.success && exact.optimal)) continue;   // beam territory, covered above
        checked++;

        const withBeam = new Solver(P.bg, P.fg).solve({ ...BUDGET, beamWidth: 20000 });
        assert(withBeam.success && withBeam.optimal, `${f} lost its optimality proof`);
        assert(withBeam.path.length === exact.path.length,
            `${f}: ${withBeam.path.length} steps with the switch on vs ${exact.path.length} off`);
        assert(withBeam.path.length === P.stars[0], `${f}: ${withBeam.path.length} steps vs par ${P.stars[0]}`);
    }
    assert(checked >= 25, `only ${checked} boards were exercised`);
});

run('the fallback does not slow down boards the exact search can finish', () => {
    const P = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'puzzle-20260813.json'), 'utf8'));
    const t0 = Date.now();
    new Solver(P.bg, P.fg).solve({ ...BUDGET, beamWidth: 20000 });
    const withBeam = Date.now() - t0;
    assert(withBeam < 2000, `took ${withBeam}ms with the fallback on an easy board`);
});

// The driver widens the beam for several rounds, then re-samples at the cap
// with fresh seeds. Both phases share one "rounds since the answer improved"
// counter, and the widening rounds are narrow enough that they routinely fail
// to beat whatever the exact search already found. Without a reset on the way
// in, the counter is already spent when sampling begins and the loop takes
// exactly one sample - which is how a reachable 23-step answer on 20260614 was
// being missed while a later seed would have found it.
run('sampling at the width cap gets a fresh stall allowance', () => {
    const P = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'puzzle-20260815.json'), 'utf8'));
    const CAP = 200000;

    const calls = [];
    const real = Solver.prototype.beamSearch;
    Solver.prototype.beamSearch = function (opts) {
        calls.push(opts.width);
        return { status: 'timeout' };      // never improves, so the counter only climbs
    };
    try {
        // Unlimited time with a tiny state cap: the exact phases give up almost
        // at once, leaving the beam driver as the thing under test.
        new Solver(P.bg, P.fg).solve({ totalTimeBudgetMs: Infinity, maxStates: 50000, beamWidth: CAP });
    } finally {
        Solver.prototype.beamSearch = real;
    }

    const atCap = calls.filter(w => w === CAP).length;
    assert(calls.length > 0, 'the beam driver never ran');
    assert(calls[0] < CAP, `first round should be narrow, got ${calls[0]}`);
    assert(atCap >= 2,
        `only ${atCap} sample(s) at the cap out of ${calls.length} rounds (${calls.join(', ')})`);
});

console.log('\nBudget');

// The regression this guards: the fallback used to be opt-in and reserved 40%
// of the budget the moment it was enabled, weakening the exact search before it
// had failed at anything. On 20260613 at the 20s budget that turned a proven
// 36-step answer into no answer at all.
//
// Asserted on the deadline the exact search is handed, not on whether some board
// happens to finish. Outcome-based versions of this test are flaky: 20260613 sits
// about 7% inside its deadline, so it proves or fails depending on machine load,
// which says nothing about whether the budget was split.
run('the fallback never shortens the exact search deadline', () => {
    const P = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'puzzle-20260613.json'), 'utf8'));
    const BUDGET_MS = 20000;

    function exactDeadlineFor(beamWidth) {
        const solver = new Solver(P.bg, P.fg);
        let allowance = null;
        const real = Solver.prototype.solveBidirectional;
        Solver.prototype.solveBidirectional = function (opts) {
            // How long the exact search was given, relative to when it started.
            if (allowance === null) allowance = opts.deadline - performance.now();
            return { status: 'timeout' };        // stop here; only the budget matters
        };
        const realAStar = Solver.prototype.runAStar;
        Solver.prototype.runAStar = function () { return { status: 'timeout', nodesExplored: 0 }; };
        const realBeam = Solver.prototype.beamSearch;
        Solver.prototype.beamSearch = function () { return { status: 'timeout' }; };
        try {
            solver.solve({ totalTimeBudgetMs: BUDGET_MS, maxStates: 12000000, beamWidth });
        } finally {
            Solver.prototype.solveBidirectional = real;
            Solver.prototype.runAStar = realAStar;
            Solver.prototype.beamSearch = realBeam;
        }
        assert(allowance !== null, 'the exact search never ran');
        return allowance;
    }

    const alone = exactDeadlineFor(0);
    const withFallback = exactDeadlineFor(100000);

    // A few ms of drift between the two calls is measurement, not a carve-out.
    assert(Math.abs(alone - withFallback) < 200,
        `exact search got ${Math.round(alone)}ms alone but ${Math.round(withFallback)}ms with the fallback`);
    // And it should be a real share of the budget, not a rounding artefact.
    assert(alone > BUDGET_MS * 0.5,
        `exact search only got ${Math.round(alone)}ms of a ${BUDGET_MS}ms budget`);
});

// The beam is paid for with extra time, so a board that cannot be proved takes
// longer than the stated budget rather than eating into it.
run('the fallback runs on time added after the budget, not taken from it', () => {
    const P = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'puzzle-20260815.json'), 'utf8'));
    const BUDGET_MS = 3000;

    const t0 = Date.now();
    const r = new Solver(P.bg, P.fg).solve({ totalTimeBudgetMs: BUDGET_MS, maxStates: 3000000, beamWidth: 20000 });
    const elapsed = Date.now() - t0;

    assert(r.success && !r.optimal, `expected an unproven answer, got "${r.message}"`);
    assert(elapsed > BUDGET_MS, `finished in ${elapsed}ms, so the exact search cannot have used its ${BUDGET_MS}ms`);
    assert(elapsed < BUDGET_MS * 2.5, `took ${elapsed}ms, far beyond budget plus the beam's half`);
});

run('Thorough reports an unlimited search without leaking "Infinity"', () => {
    // Worker path: what a real browser runs. Cancel is available, so an
    // unbounded search is safe and the message should say memory is the limit.
    const w = createApp({ strength: 'thorough', deferTimers: true, worker: true });
    w.setMode('edit'); w.paint(0, 0, 'Y'); w.paint(1, 0, 'T');
    w.setMode('solve'); w.solve();
    const wMsg = w.solverText();
    assert(!/Infinity|NaN|undefined/.test(wMsg), `worker message reads "${wMsg}"`);
    assert(/memory/.test(wMsg), `should name the real bound: "${wMsg}"`);
    w.flushTimers();
    assert(/Optimal solution in 1 step\b/.test(w.solverText()),
        `worker solve ended with "${w.solverText()}"`);

    // Fallback path: blocks the page, so Cancel cannot be reached. It must
    // impose a finite cap of its own rather than inherit the unlimited one.
    const f = createApp({ strength: 'thorough', deferTimers: true });
    f.setMode('edit'); f.paint(0, 0, 'Y'); f.paint(1, 0, 'T');
    f.setMode('solve'); f.solve();
    const fMsg = f.solverText();
    assert(!/Infinity|NaN|undefined/.test(fMsg), `fallback message reads "${fMsg}"`);
    assert(/\d+s/.test(fMsg), `fallback must state a finite cap: "${fMsg}"`);
    f.flushTimers();
});

run('step and move counts read naturally at one', () => {
    const app = createApp({ worker: true });
    app.setMode('edit'); app.paint(0, 0, 'Y'); app.paint(1, 0, 'T');
    app.setMode('solve'); app.solve();
    assert(/in 1 step\b/.test(app.solverText()), `solver said "${app.solverText()}"`);

    app.setMode('play');
    app.dpad.D.fire('click');
    const pm = app.byId.get('play-message').textContent;
    assert(/in 1 move\b/.test(pm), `play said "${pm}"`);
});

console.log(`\n${fail === 0 ? 'ALL PASSED' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
