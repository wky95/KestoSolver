// Replays solver-produced solutions through app.js's applyMove(). If the two
// move rules disagree, a replayed optimal path will not land on the targets.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

// Load solver.js as a script into a sandbox to get Solver.
const sandbox = { console, self: undefined, performance };
vm.createContext(sandbox);
// `class Solver` is lexical, so it never lands on the context object; export it.
vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'solver.js'), 'utf8') + '\nglobalThis.__Solver = Solver;',
    sandbox
);
const Solver = sandbox.__Solver;

// --- copied verbatim from app.js applyMove(), with bgGrid passed in ---
function applyMove(blocks, dir, bgGrid) {
    const isRow = dir === 'L' || dir === 'R';
    const step = (dir === 'U' || dir === 'L') ? -1 : +1;

    const occupied = new Set(blocks.map(b => b.r * 8 + b.c));
    const shifted = new Map();

    for (let line = 0; line < 8; line++) {
        const at = i => (isRow ? { r: line, c: i } : { r: i, c: line });
        const hasBlock = i => { const p = at(i); return occupied.has(p.r * 8 + p.c); };
        const isWall = i => { const p = at(i); return bgGrid[p.r][p.c] === '#'; };

        let i = 0;
        while (i < 8) {
            if (!hasBlock(i)) { i++; continue; }
            let j = i;
            while (j + 1 < 8 && hasBlock(j + 1)) j++;

            const lead = step > 0 ? j : i;
            const ahead = lead + step;
            const canMove = ahead >= 0 && ahead <= 7 && !isWall(ahead);

            if (canMove) {
                for (let k = i; k <= j; k++) {
                    const from = at(k);
                    const to = at(k + step);
                    shifted.set(from.r * 8 + from.c, to.r * 8 + to.c);
                }
            }
            i = j + 1;
        }
    }

    if (shifted.size === 0) return null;

    return blocks.map(b => {
        const moved = shifted.get(b.r * 8 + b.c);
        return moved === undefined ? b : { r: Math.floor(moved / 8), c: moved % 8 };
    });
}
// --- end copy ---

// Deterministic PRNG so failures are reproducible.
let seed = 12345;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }

// Build a board that is solvable *by the Play-mode rule*: scatter blocks and
// walls, walk a few random moves with applyMove, and make the squares it lands
// on the targets. If the solver's rule matched, it must find a path; if it then
// replays correctly under applyMove, the two rules agree in both directions.
function makeSolvableBoard(nBlocks, nWalls, nMoves) {
    const bg = Array(8).fill().map(() => Array(8).fill('.'));
    const fg = Array(8).fill().map(() => Array(8).fill('.'));
    const free = [];
    for (let i = 0; i < 64; i++) free.push(i);
    for (let i = free.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [free[i], free[j]] = [free[j], free[i]];
    }
    let k = 0;
    for (let i = 0; i < nWalls; i++) { const p = free[k++]; bg[(p / 8) | 0][p % 8] = '#'; }

    let blocks = [];
    for (let i = 0; i < nBlocks; i++) {
        const p = free[k++];
        blocks.push({ r: (p / 8) | 0, c: p % 8 });
        fg[(p / 8) | 0][p % 8] = 'Y';
    }

    const DIRS = ['U', 'D', 'L', 'R'];
    let cur = blocks;
    for (let i = 0; i < nMoves; i++) {
        const next = applyMove(cur, DIRS[Math.floor(rnd() * 4)], bg);
        if (next) cur = next;
    }
    // A move can merge two blocks onto one square only if they were already
    // stacked, which cannot happen; but bail out if the walk went nowhere.
    const same = cur.every((b, i) => b.r === blocks[i].r && b.c === blocks[i].c);
    if (same) return null;

    cur.forEach(b => { bg[b.r][b.c] = 'T'; });
    // A wall can never also be a target, and the walk never enters walls.
    return { bg, fg };
}

let solved = 0, checked = 0, mismatches = 0, unsolvable = 0;

for (let t = 0; t < 400; t++) {
    const board = makeSolvableBoard(2 + Math.floor(rnd() * 3), Math.floor(rnd() * 8), 1 + Math.floor(rnd() * 6));
    if (!board) continue;
    const { bg, fg } = board;

    let result;
    try {
        result = new Solver(bg, fg).solve({ totalTimeBudgetMs: 2000, maxStates: 800000 });
    } catch (e) { console.log('solver threw:', e.message); continue; }

    if (!result.success) {
        // The board is solvable under the Play rule by construction, so the
        // solver failing means the rules disagree.
        unsolvable++;
        console.log(`MISMATCH t=${t}: solver says "${result.message}" on a board reachable under the Play rule`);
        continue;
    }
    if (!result.path || result.path.length === 0) continue;
    solved++;

    // Replay the solver's path with the Play-mode rule.
    let blocks = [];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (fg[r][c] === 'Y') blocks.push({ r, c });

    let broke = null;
    for (let i = 0; i < result.path.length; i++) {
        const next = applyMove(blocks, result.path[i], bg);
        if (!next) { broke = `move ${i + 1} (${result.path[i]}) was a no-op`; break; }
        blocks = next;
    }

    checked++;
    if (broke) { mismatches++; console.log(`MISMATCH t=${t}: ${broke}`); continue; }

    const targets = [];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (bg[r][c] === 'T') targets.push(r * 8 + c);
    const occ = new Set(blocks.map(b => b.r * 8 + b.c));
    const ok = targets.length === blocks.length && targets.every(x => occ.has(x));
    if (!ok) {
        mismatches++;
        console.log(`MISMATCH t=${t}: replay of a ${result.path.length}-move optimal path did not reach the targets`);
    }
}

console.log(`\nsolved: ${solved}, replayed: ${checked}, replay mismatches: ${mismatches}, solver-said-unsolvable: ${unsolvable}`);
process.exit(mismatches === 0 && unsolvable === 0 && checked > 20 ? 0 : 1);
