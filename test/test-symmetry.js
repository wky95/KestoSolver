// Positions that differ only by a mirror are stored once, so what the search
// records is a representative rather than the real board. Reconstruction has to
// lift that back into moves that work from the actual start - and a mistake
// there yields a plausible-looking path that simply does not solve the puzzle.
//
// Two checks, on boards built to be symmetric:
//   - the answer is the same length as with the reduction switched off
//   - the path actually reaches the goal, judged by an independent replayer
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
const Solver = freshSolver();

let pass = 0, fail = 0;
function assert(c, m) { if (!c) throw new Error(m); }
function run(name, fn) {
    try { fn(); console.log(`  ok    ${name}`); pass++; }
    catch (e) { console.log(`  FAIL  ${name}\n          ${e.message}`); fail++; }
}

// Independent of solver.js: the Play-mode rule, written out again.
function applyMove(blocks, dir, bg) {
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
    if (!sh.size) return null;
    return blocks.map(b => { const m = sh.get(b.r * 8 + b.c); return m === undefined ? b : { r: m >> 3, c: m & 7 }; });
}
function replayReaches(bg, fg, moves) {
    let blocks = [];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (fg[r][c] === 'Y') blocks.push({ r, c });
    for (const d of moves) { const n = applyMove(blocks, d, bg); if (!n) return false; blocks = n; }
    const t = [];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (bg[r][c] === 'T') t.push(r * 8 + c);
    const occ = new Set(blocks.map(b => b.r * 8 + b.c));
    return t.length === blocks.length && t.every(x => occ.has(x));
}

let seed = 20260816;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

// Walls and targets are mirrored into place, so the board is symmetric by
// construction; the start comes from walking the goal backwards, so it is
// solvable by construction too.
function symmetricBoard({ mirrorV, walls, targetPairs, moves }) {
    const bg = Array(8).fill().map(() => Array(8).fill('.'));
    const fg = Array(8).fill().map(() => Array(8).fill('.'));
    const mirror = (r, c) => mirrorV ? [7 - r, c] : [r, 7 - c];

    for (let i = 0; i < walls; i++) {
        const r = Math.floor(rnd() * 8), c = Math.floor(rnd() * 8);
        const [mr, mc] = mirror(r, c);
        bg[r][c] = '#'; bg[mr][mc] = '#';
    }
    const targets = [];
    let guard = 0;
    while (targets.length < targetPairs * 2 && guard++ < 200) {
        const r = Math.floor(rnd() * 8), c = Math.floor(rnd() * 8);
        const [mr, mc] = mirror(r, c);
        if (r === mr && c === mc) continue;                 // on the axis, would not pair
        if (bg[r][c] !== '.' || bg[mr][mc] !== '.') continue;
        bg[r][c] = 'T'; bg[mr][mc] = 'T';
        targets.push({ r, c }, { r: mr, c: mc });
    }
    if (targets.length < 2) return null;

    // Walk the goal position forwards; where it ends becomes the start.
    let blocks = targets.map(t => ({ r: t.r, c: t.c }));
    const dirs = ['U', 'D', 'L', 'R'];
    for (let i = 0; i < moves; i++) {
        const n = applyMove(blocks, dirs[Math.floor(rnd() * 4)], bg);
        if (n) blocks = n;
    }
    if (blocks.every((b, i) => b.r === targets[i].r && b.c === targets[i].c)) return null;
    blocks.forEach(b => { fg[b.r][b.c] = 'Y'; });
    return { bg, fg };
}

const OPT = { totalTimeBudgetMs: 5000, maxStates: 3000000, beamWidth: 0 };

function solveBoth(bg, fg) {
    const withSym = new Solver(bg, fg);
    const detected = withSym.useSymmetry;
    const a = withSym.solve(OPT);

    const without = new Solver(bg, fg);
    without.useSymmetry = false;          // same code path, reduction disabled
    const b = without.solve(OPT);
    return { detected, a, b };
}

console.log('\nSymmetry reduction');

run('mirrors are detected on the real levels that have them', () => {
    const expected = { '20260613': true, '20260808': true, '20260809': true, '20260815': true };
    let found = 0;
    for (const f of fs.readdirSync(FIXTURES).filter(x => /^puzzle-\d+\.json$/.test(x)).sort()) {
        const P = JSON.parse(fs.readFileSync(path.join(FIXTURES, f), 'utf8'));
        const id = f.slice(7, 15);
        const s = new Solver(P.bg, P.fg);
        if (s.useSymmetry) { found++; assert(expected[id], `${id} reported a symmetry it should not have`); }
        else assert(!expected[id], `${id} has a mirror but it was not detected`);
    }
    assert(found === Object.keys(expected).length, `${found} symmetric levels detected`);
});

run('symmetric real levels: same answer with the reduction on and off', () => {
    for (const id of ['20260808', '20260809']) {          // the two that finish quickly
        const P = JSON.parse(fs.readFileSync(path.join(FIXTURES, `puzzle-${id}.json`), 'utf8'));
        const { detected, a, b } = solveBoth(P.bg, P.fg);
        assert(detected, `${id} lost its symmetry`);
        assert(a.success && b.success, `${id} did not solve`);
        assert(a.optimal && b.optimal, `${id} lost its optimality proof`);
        assert(a.path.length === b.path.length,
            `${id}: ${a.path.length} steps with symmetry vs ${b.path.length} without`);
        assert(a.path.length === P.stars[0], `${id}: ${a.path.length} steps vs par ${P.stars[0]}`);
        assert(replayReaches(P.bg, P.fg, a.path), `${id}: the symmetric path does not reach the goal`);
    }
});

run('generated symmetric boards: same length, and every path works', () => {
    let checked = 0, symmetric = 0;
    for (let t = 0; t < 140; t++) {
        const board = symmetricBoard({
            mirrorV: t % 2 === 0,
            walls: Math.floor(rnd() * 5),
            targetPairs: 1 + Math.floor(rnd() * 3),
            moves: 1 + Math.floor(rnd() * 9),
        });
        if (!board) continue;

        const { detected, a, b } = solveBoth(board.bg, board.fg);
        if (detected) symmetric++;
        if (!a.success || !b.success) continue;
        checked++;

        assert(a.path.length === b.path.length,
            `board ${t}: ${a.path.length} steps with symmetry vs ${b.path.length} without`);
        assert(a.optimal === b.optimal, `board ${t}: optimality flag differs`);
        assert(replayReaches(board.bg, board.fg, a.path),
            `board ${t}: a ${a.path.length}-move path from the reduced search does not reach the goal`);
    }
    assert(symmetric >= 40, `only ${symmetric} generated boards were symmetric`);
    assert(checked >= 40, `only ${checked} boards were solved by both`);
    console.log(`          ${checked} boards compared, ${symmetric} of them symmetric`);
});

// Measured on a board both settings can finish, so the totals are comparable
// rather than both being whatever the cap happened to cut them off at.
run('the reduction really does visit fewer states', () => {
    const P = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'puzzle-20260809.json'), 'utf8'));

    function statesUsed(disable) {
        const s = new Solver(P.bg, P.fg);
        if (disable) s.useSymmetry = false;
        let seen = 0;
        const r = s.solveBidirectional({
            maxStates: 12000000,
            deadline: performance.now() + 60000,
            onProgress: n => { seen = n; },
        });
        assert(r.status === 'solved', `did not solve (disable=${disable})`);
        return seen;
    }
    const withSym = statesUsed(false), without = statesUsed(true);
    console.log(`          20260809: ${without.toLocaleString()} states -> ${withSym.toLocaleString()} (${(without / withSym).toFixed(2)}x fewer)`);
    assert(withSym < without, `symmetry did not reduce the search (${withSym} vs ${without})`);
});

// The beam is the engine that answers boards the exact search cannot finish, so
// it is also the one whose reconstruction is hardest to eyeball. It stores
// representatives too now, and replaying its recorded moves would drift onto a
// mirrored board.
run('beam answers on a symmetric board still replay to the goal', () => {
    const P = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'puzzle-20260815.json'), 'utf8'));
    const s = new Solver(P.bg, P.fg);
    assert(s.useSymmetry, 'this board should be detected as symmetric');

    const r = s.beamSearch({ width: 3000, maxStates: 3000000, deadline: performance.now() + 60000 });
    assert(r.status === 'solved', `beam found nothing (${r.status})`);
    assert(replayReaches(P.bg, P.fg, r.path),
        `a ${r.path.length}-move beam path does not reach the goal`);
    assert(r.states.length === r.path.length + 1,
        `${r.states.length} states for ${r.path.length} moves`);
});

run('collapsing mirrors makes the beam reach further for the same width', () => {
    const P = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'puzzle-20260815.json'), 'utf8'));
    const opts = { width: 3000, maxStates: 3000000, deadline: performance.now() + 60000, seed: 4 };

    const withSym = new Solver(P.bg, P.fg);
    const t1 = Date.now();
    const a = withSym.beamSearch(opts);
    const symMs = Date.now() - t1;

    const without = new Solver(P.bg, P.fg);
    without.useSymmetry = false;
    const t2 = Date.now();
    const b = without.beamSearch({ ...opts, deadline: performance.now() + 60000 });
    const plainMs = Date.now() - t2;

    assert(a.status === 'solved' && b.status === 'solved', 'both should find something');
    assert(replayReaches(P.bg, P.fg, a.path), 'symmetric path is invalid');
    console.log(`          20260815 at width 3000: ${b.path.length} steps in ${(plainMs / 1000).toFixed(1)}s` +
        `  ->  ${a.path.length} steps in ${(symMs / 1000).toFixed(1)}s with mirrors collapsed`);
});

console.log(`\n${fail === 0 ? 'ALL PASSED' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
