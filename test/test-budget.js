// The interface tells you how long a search may take. This checks the search
// actually honours that, on the boards that push it hardest.
//
// Every other suite here asserts on what the solver *returns*. None of them
// would notice a search that quietly runs twice as long as the label promises,
// and that is exactly what happened: the weighted A* ladder inherited whatever
// time the exact search left unused, so when the exact search bailed early on
// memory the ladder took the remainder, found nothing, and pushed a "90s" solve
// to 106s.
//
// Slow by nature - it runs real searches to completion - so it lives behind
// KESTO_SLOW with the rest.
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');

const SRC = fs.readFileSync(path.join(ROOT, 'solver.js'), 'utf8');
function freshSandbox() {
    const sb = { console, performance, Math, Number, BigInt, Array, Set, Map, JSON, Error, String, isFinite, Infinity };
    sb.globalThis = sb; vm.createContext(sb);
    vm.runInContext(SRC + '\nglobalThis.__S = Solver; globalThis.__SHARE = BEAM_TIME_SHARE;', sb);
    return sb;
}

// Read from solver.js rather than restated here, so this cannot drift from the
// value the search and the interface both use.
const BEAM_TIME_SHARE = freshSandbox().__SHARE;

let pass = 0, fail = 0;
function assert(c, m) { if (!c) throw new Error(m); }
function run(name, fn) {
    try { fn(); console.log(`  ok    ${name}`); pass++; }
    catch (e) { console.log(`  FAIL  ${name}\n          ${e.message}`); fail++; }
}

function board(id) {
    return JSON.parse(fs.readFileSync(path.join(FIXTURES, `puzzle-${id}.json`), 'utf8'));
}

// A search cannot preempt itself in the middle of an allocation or a rehash, so
// a small tail past the deadline is expected. Anything beyond this is the
// scheduling being wrong, not the granularity.
const OVERRUN_ALLOWANCE_MS = 3000;

function timeSolve(id, options) {
    const P = board(id);
    const sb = freshSandbox();
    const t = Date.now();
    const r = new sb.__S(P.bg, P.fg).solve(options);
    return { elapsed: Date.now() - t, result: r };
}

console.log('\nTime budgets');
console.log(`  (fallback share read from solver.js: ${BEAM_TIME_SHARE})`);

// Presets as app.js configures them, including what a memory-constrained device
// gets. The 16-block board is the one that exposed the overrun.
const CASES = [
    ['20260815', 'Fast', { totalTimeBudgetMs: 3000, maxStates: 3000000, beamWidth: 20000 }],
    ['20260815', 'Balanced', { totalTimeBudgetMs: 20000, maxStates: 12000000, beamWidth: 100000 }],
    ['20260614', 'Balanced', { totalTimeBudgetMs: 20000, maxStates: 12000000, beamWidth: 100000 }],
    // What a phone gets for Thorough: the unlimited clock becomes finite.
    ['20260815', 'Thorough on a phone', { totalTimeBudgetMs: 60000, maxStates: 7500000, beamWidth: 25000 }],
];

for (const [id, label, options] of CASES) {
    const claimMs = options.totalTimeBudgetMs * (1 + BEAM_TIME_SHARE);
    run(`${id} at ${label} finishes inside the ${Math.round(claimMs / 1000)}s it advertises`, () => {
        const { elapsed, result } = timeSolve(id, options);
        const over = elapsed - claimMs;
        console.log(`          took ${(elapsed / 1000).toFixed(1)}s of ${(claimMs / 1000).toFixed(0)}s` +
            `  ${result.success ? result.path.length + ' steps' : 'no solution'}`);
        assert(over <= OVERRUN_ALLOWANCE_MS,
            `ran ${(over / 1000).toFixed(1)}s past the advertised ${(claimMs / 1000).toFixed(0)}s`);
    });
}

// An unlimited budget has no clock to overrun, but the weaker engine still must
// not outlast the stronger one - that was the other half of the same bug.
run('with no clock, the A* ladder never outlasts the exact search', () => {
    const P = board('20260815');
    const sb = freshSandbox();
    const marks = [];
    const t = Date.now();
    new sb.__S(P.bg, P.fg).solve({
        totalTimeBudgetMs: Infinity, maxStates: 8000000, beamWidth: 25000,
        onPhase: p => marks.push({ p, at: Date.now() - t }),
    });

    const exact = marks.find(m => m.p === 'exact');
    const refine = marks.find(m => m.p === 'refine');
    const fallback = marks.find(m => m.p === 'fallback');
    assert(exact, 'the exact phase never started');
    if (!refine || !fallback) return;          // ladder skipped entirely, which is fine

    const exactMs = refine.at - exact.at;
    const ladderMs = fallback.at - refine.at;
    console.log(`          exact ${(exactMs / 1000).toFixed(1)}s, A* ladder ${(ladderMs / 1000).toFixed(1)}s`);
    assert(ladderMs <= exactMs + OVERRUN_ALLOWANCE_MS,
        `A* ran ${(ladderMs / 1000).toFixed(1)}s after an exact phase of only ${(exactMs / 1000).toFixed(1)}s`);
});

console.log(`\n${fail === 0 ? 'ALL PASSED' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
