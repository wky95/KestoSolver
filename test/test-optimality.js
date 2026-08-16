// A search cut short must never claim to have proven anything. The deadline can
// now fire part-way through a level, which is exactly the situation where a
// premature "proven optimal" would slip through unnoticed.
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');

function freshSolver() {
    const sb = { console, performance, Math, Number, BigInt, Array, Set, Map, JSON, Error, String, isFinite, Infinity };
    sb.globalThis = sb; vm.createContext(sb);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'solver.js'), 'utf8') + '\nglobalThis.__S = Solver;', sb);
    return sb.__S;
}
const Solver = freshSolver();

let pass = 0, fail = 0;
const problems = [];

// Every level with a known par, swept across budgets that land mid-level.
const files = fs.readdirSync(FIXTURES).filter(x => /^puzzle-\d+\.json$/.test(x)).sort();
// Deliberately awkward values: each is likely to expire somewhere inside a
// level rather than neatly between two.
const BUDGETS = [90, 370, 1450];

let claims = 0, cut = 0;
for (const f of files) {
    const P = JSON.parse(fs.readFileSync(path.join(FIXTURES, f), 'utf8'));
    const par = P.stars && P.stars.length ? P.stars[0] : null;
    if (par === null) continue;

    for (const ms of BUDGETS) {
        for (const beamWidth of [0, 5000]) {
            let r;
            try {
                r = new Solver(P.bg, P.fg).solve({ totalTimeBudgetMs: ms, maxStates: 2000000, beamWidth });
            } catch (e) {
                fail++; problems.push(`${f} @${ms}ms beam=${beamWidth} threw: ${e.message}`);
                continue;
            }
            if (!r.success) { cut++; continue; }

            if (r.optimal) {
                claims++;
                // The only defensible claim is the true minimum.
                if (r.path.length !== par) {
                    fail++;
                    problems.push(`${f} @${ms}ms beam=${beamWidth}: claimed OPTIMAL at ${r.path.length} steps, par is ${par}`);
                } else pass++;
            } else {
                cut++;
                // An unproven answer may be long, but never shorter than the true minimum.
                if (r.path.length < par) {
                    fail++;
                    problems.push(`${f} @${ms}ms beam=${beamWidth}: ${r.path.length} steps beats par ${par} - impossible`);
                } else pass++;
            }
        }
    }
}

console.log(`runs checked:        ${pass + fail}`);
console.log(`claimed optimal:     ${claims} (all had to equal par)`);
console.log(`unproven or no answer: ${cut}`);
console.log(`\n${fail === 0 ? 'ALL PASSED' : fail + ' FAILURES'}`);
problems.slice(0, 20).forEach(p => console.log('  - ' + p));
process.exit(fail === 0 ? 0 : 1);
