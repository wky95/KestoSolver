// Every real Kesto level in fixtures/, solved exactly and checked against the
// par the game itself publishes. Par is ground truth the solver cannot fudge:
// if it claims a proven-optimal answer of a different length, one of them is
// wrong and it is not Kesto.
//
// Levels the exact search cannot finish inside the budget are reported but not
// failed - that is a known limit, not a regression. Add KESTO_SLOW=1 to give
// them the Thorough budget instead.
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');

const SRC = fs.readFileSync(path.join(ROOT, 'solver.js'), 'utf8');
function freshSolver() {
    const sb = { console, performance, Math, Number, BigInt, Array, Set, Map, JSON, Error, String, isFinite, Infinity };
    sb.globalThis = sb; vm.createContext(sb);
    vm.runInContext(SRC + '\nglobalThis.__S = Solver;', sb);
    return sb.__S;
}

const SLOW = process.env.KESTO_SLOW === '1';
const OPT = SLOW
    ? { totalTimeBudgetMs: 90000, maxStates: 30000000, beamWidth: 0 }
    : { totalTimeBudgetMs: 20000, maxStates: 12000000, beamWidth: 0 };

const files = fs.readdirSync(FIXTURES).filter(x => /^puzzle-\d+\.json$/.test(x)).sort();
if (files.length === 0) {
    console.log('no fixtures - run: node test/fetch-fixtures.js');
    process.exit(1);
}

let solved = 0, unfinished = 0, wrong = 0;
const problems = [];

console.log(`level     blocks  par   time      result${SLOW ? '   (KESTO_SLOW)' : ''}`);
for (const f of files) {
    const P = JSON.parse(fs.readFileSync(path.join(FIXTURES, f), 'utf8'));
    const id = f.slice(7, 15);
    const par = P.stars && P.stars.length ? P.stars[0] : null;

    const Solver = freshSolver();
    const t = Date.now();
    let r;
    try { r = new Solver(P.bg, P.fg).solve(OPT); }
    catch (e) { r = { success: false, message: 'threw: ' + e.message }; }
    const ms = Date.now() - t;

    let note = '';
    if (r.success && r.optimal) {
        solved++;
        if (par !== null && r.path.length !== par) {
            wrong++;
            note = `  *** ${r.path.length} steps but Kesto says par is ${par} ***`;
            problems.push(`${id}: proven-optimal ${r.path.length} vs par ${par}`);
        }
    } else if (r.success) {
        // Unproven answers may be longer than par, never shorter.
        unfinished++;
        if (par !== null && r.path.length < par) {
            wrong++;
            note = `  *** ${r.path.length} beats par ${par} - impossible ***`;
            problems.push(`${id}: ${r.path.length} steps beats par ${par}`);
        }
    } else {
        unfinished++;
    }

    const outcome = r.success
        ? `${String(r.path.length).padStart(3)} steps ${r.optimal ? 'proven' : 'approx'}`
        : '  not finished';
    console.log(`${id}    ${String(P.boxCount).padStart(4)}  ${String(par ?? '-').padStart(3)}  ${String(ms + 'ms').padStart(7)}  ${outcome}${note}`);
}

console.log(`\nlevels ${files.length}   proven optimal ${solved}   not finished in budget ${unfinished}   WRONG ${wrong}`);
problems.forEach(p => console.log('  - ' + p));
process.exit(wrong === 0 ? 0 : 1);
