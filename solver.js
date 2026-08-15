// JS implementation of the A* Bitboard Kesto Solver

const ROW0_MASK = 0x00000000000000FFn;
const ROW7_MASK = 0xFF00000000000000n;
const COL0_MASK = 0x0101010101010101n;
const COL7_MASK = 0x8080808080808080n;

const NOT_COL7_MASK = 0x7F7F7F7F7F7F7F7Fn;
const NOT_COL0_MASK = 0xFEFEFEFEFEFEFEFEn;
const MASK_64 = 0xFFFFFFFFFFFFFFFFn;

const INF = 10000;

const DIR_CHARS = ['U', 'D', 'L', 'R'];

// Open-addressed hash table for visited states, packed into typed arrays.
//
// A Map<BigInt, {parent, move, d}> costs ~200 bytes per state once the BigInt
// objects, Map entries and value objects are counted, and memory is what caps
// the search. Storing the board as two 32-bit halves with the parent held as a
// slot index gets that to ~14 bytes of payload, so the same RAM holds roughly
// an order of magnitude more states.
class StateTable {
    constructor(capacityLog2 = 16) {
        this.allocate(capacityLog2);
        this.size = 0;
    }

    allocate(capacityLog2) {
        this.capacityLog2 = capacityLog2;
        this.capacity = 1 << capacityLog2;
        this.mask = this.capacity - 1;
        // (0,0) is never a real board: block count is invariant and non-zero,
        // so an all-zero key doubles as the empty-slot marker.
        this.keyLo = new Uint32Array(this.capacity);
        this.keyHi = new Uint32Array(this.capacity);
        this.slotOf = new Int32Array(this.capacity).fill(-1);
        this.growAt = (this.capacity * 3) >> 2;   // grow past 75% load
    }

    ensureEntryArrays(minimum) {
        if (this.entryLo && this.entryLo.length >= minimum) return;
        const next = Math.max(1024, minimum, this.entryLo ? this.entryLo.length * 2 : 1024);
        const lo = new Uint32Array(next), hi = new Uint32Array(next);
        const parent = new Int32Array(next), move = new Uint8Array(next), depth = new Uint8Array(next);
        if (this.entryLo) {
            lo.set(this.entryLo); hi.set(this.entryHi);
            parent.set(this.entryParent); move.set(this.entryMove); depth.set(this.entryDepth);
        }
        this.entryLo = lo; this.entryHi = hi;
        this.entryParent = parent; this.entryMove = move; this.entryDepth = depth;
    }

    hash(lo, hi) {
        let h = Math.imul(lo, 0x9E3779B1) ^ Math.imul(hi, 0x85EBCA6B);
        h ^= h >>> 15;
        h = Math.imul(h, 0x2545F491);
        return (h ^ (h >>> 13)) & this.mask;
    }

    find(lo, hi) {
        let i = this.hash(lo, hi);
        while (true) {
            const slot = this.slotOf[i];
            if (slot === -1) return -1;
            if (this.keyLo[i] === lo && this.keyHi[i] === hi) return slot;
            i = (i + 1) & this.mask;
        }
    }

    rehash() {
        const oldLo = this.entryLo, oldHi = this.entryHi, count = this.size;
        this.allocate(this.capacityLog2 + 1);
        for (let s = 0; s < count; ++s) {
            let i = this.hash(oldLo[s], oldHi[s]);
            while (this.slotOf[i] !== -1) i = (i + 1) & this.mask;
            this.keyLo[i] = oldLo[s]; this.keyHi[i] = oldHi[s]; this.slotOf[i] = s;
        }
    }

    // Returns the slot index, or -1 if the state was already present.
    add(lo, hi, parent, move, depth) {
        if (this.size >= this.growAt) this.rehash();
        let i = this.hash(lo, hi);
        while (true) {
            const slot = this.slotOf[i];
            if (slot === -1) break;
            if (this.keyLo[i] === lo && this.keyHi[i] === hi) return -1;
            i = (i + 1) & this.mask;
        }
        const slot = this.size++;
        this.ensureEntryArrays(this.size);
        this.keyLo[i] = lo; this.keyHi[i] = hi; this.slotOf[i] = slot;
        this.entryLo[slot] = lo; this.entryHi[slot] = hi;
        this.entryParent[slot] = parent; this.entryMove[slot] = move; this.entryDepth[slot] = depth;
        return slot;
    }

    boardAt(slot) {
        return (BigInt(this.entryHi[slot]) << 32n) | BigInt(this.entryLo[slot]);
    }
}

const loOf = (board) => Number(board & 0xFFFFFFFFn) >>> 0;
const hiOf = (board) => Number(board >> 32n) >>> 0;
// A move only ever shifts blocks along one axis, so it decomposes into eight
// independent 1-D lines: rows for L/R, columns for U/D.
const IS_ROW_LINE = [false, false, true, true];
const LINE_STEP = [-1, +1, -1, +1];   // U and L move toward lower indices

// One line of the board: each maximal run of blocks shifts by one iff the cell
// just ahead of its leading block is on-board and not a wall. (A run's leading
// cell is never occupied, by maximality, so blocks only ever block each other
// through this run structure.)
function lineStep(blocks, walls, step) {
    let result = 0;
    let i = 0;
    while (i < 8) {
        if (!(blocks & (1 << i))) { i++; continue; }
        let j = i;
        while (j + 1 < 8 && (blocks & (1 << (j + 1)))) j++;
        const lead = step > 0 ? j : i;
        const ahead = lead + step;
        const canMove = ahead >= 0 && ahead <= 7 && !(walls & (1 << ahead));
        for (let k = i; k <= j; k++) result |= 1 << (canMove ? k + step : k);
        i = j + 1;
    }
    return result;
}

function extractLine(board, dir, idx) {
    if (IS_ROW_LINE[dir]) return Number((board >> BigInt(idx * 8)) & 0xFFn);
    let m = 0;
    for (let r = 0; r < 8; r++) if ((board >> BigInt(r * 8 + idx)) & 1n) m |= 1 << r;
    return m;
}

function insertLine(board, dir, idx, mask) {
    if (IS_ROW_LINE[dir]) return board | (BigInt(mask) << BigInt(idx * 8));
    let b = board;
    for (let r = 0; r < 8; r++) if (mask & (1 << r)) b |= 1n << BigInt(r * 8 + idx);
    return b;
}

function shiftU(x) { return x >> 8n; }
function shiftD(x) { return (x << 8n) & MASK_64; }
function shiftL(x) { return (x >> 1n) & NOT_COL7_MASK; }
function shiftR(x) { return (x << 1n) & NOT_COL0_MASK & MASK_64; }

class PriorityQueue {
    constructor() {
        this.heap = [];
    }
    push(node) {
        this.heap.push(node);
        this.bubbleUp(this.heap.length - 1);
    }
    pop() {
        const top = this.heap[0];
        const bottom = this.heap.pop();
        if (this.heap.length > 0) {
            this.heap[0] = bottom;
            this.sinkDown(0);
        }
        return top;
    }
    isEmpty() {
        return this.heap.length === 0;
    }
    bubbleUp(idx) {
        const node = this.heap[idx];
        while (idx > 0) {
            const parentIdx = Math.floor((idx - 1) / 2);
            const parent = this.heap[parentIdx];
            // Sort by f ascending, then g descending
            if (node.f > parent.f || (node.f === parent.f && node.g <= parent.g)) break;
            this.heap[idx] = parent;
            idx = parentIdx;
        }
        this.heap[idx] = node;
    }
    sinkDown(idx) {
        const length = this.heap.length;
        const node = this.heap[idx];
        while (true) {
            const leftChildIdx = 2 * idx + 1;
            const rightChildIdx = 2 * idx + 2;
            let leftChild, rightChild;
            let swapIdx = null;

            if (leftChildIdx < length) {
                leftChild = this.heap[leftChildIdx];
                if (leftChild.f < node.f || (leftChild.f === node.f && leftChild.g > node.g)) {
                    swapIdx = leftChildIdx;
                }
            }
            if (rightChildIdx < length) {
                rightChild = this.heap[rightChildIdx];
                const compareNode = swapIdx === null ? node : leftChild;
                if (rightChild.f < compareNode.f || (rightChild.f === compareNode.f && rightChild.g > compareNode.g)) {
                    swapIdx = rightChildIdx;
                }
            }
            if (swapIdx === null) break;
            this.heap[idx] = this.heap[swapIdx];
            idx = swapIdx;
        }
        this.heap[idx] = node;
    }
}

class Solver {
    constructor(bgGrid, fgGrid) {
        this.bgGrid = bgGrid;
        this.fgGrid = fgGrid;
        this.WALLS = this.encodeBg('#');
        this.TARGET = this.encodeBg('T');
        this.start_state = this.encodeFg('Y');
        this.dist_table = new Array(64).fill(INF);
        this.initHeuristicTable();
        this.initLineTables();
    }

    encodeBg(targetChar) {
        let bitboard = 0n;
        for (let r = 0; r < 8; ++r) {
            for (let c = 0; c < 8; ++c) {
                if (this.bgGrid[r][c] === targetChar) {
                    bitboard |= (1n << BigInt(r * 8 + c));
                }
            }
        }
        return bitboard;
    }

    encodeFg(targetChar) {
        let bitboard = 0n;
        for (let r = 0; r < 8; ++r) {
            for (let c = 0; c < 8; ++c) {
                if (this.fgGrid[r][c] === targetChar) {
                    bitboard |= (1n << BigInt(r * 8 + c));
                }
            }
        }
        return bitboard;
    }

    initHeuristicTable() {
        const q = [];
        for (let i = 0; i < 64; ++i) {
            if ((this.TARGET >> BigInt(i)) & 1n) {
                this.dist_table[i] = 0;
                q.push(i);
            }
        }

        while (q.length > 0) {
            const curr = q.shift();
            const r = Math.floor(curr / 8);
            const c = curr % 8;

            // U
            if (r > 0 && !((this.WALLS >> BigInt(curr - 8)) & 1n) && this.dist_table[curr - 8] > this.dist_table[curr] + 1) {
                this.dist_table[curr - 8] = this.dist_table[curr] + 1; q.push(curr - 8);
            }
            // D
            if (r < 7 && !((this.WALLS >> BigInt(curr + 8)) & 1n) && this.dist_table[curr + 8] > this.dist_table[curr] + 1) {
                this.dist_table[curr + 8] = this.dist_table[curr] + 1; q.push(curr + 8);
            }
            // L
            if (c > 0 && !((this.WALLS >> BigInt(curr - 1)) & 1n) && this.dist_table[curr - 1] > this.dist_table[curr] + 1) {
                this.dist_table[curr - 1] = this.dist_table[curr] + 1; q.push(curr - 1);
            }
            // R
            if (c < 7 && !((this.WALLS >> BigInt(curr + 1)) & 1n) && this.dist_table[curr + 1] > this.dist_table[curr] + 1) {
                this.dist_table[curr + 1] = this.dist_table[curr] + 1; q.push(curr + 1);
            }
        }
    }

    // Splits the 64-bit board into two 32-bit halves so bit iteration uses
    // native int ops + Math.clz32 instead of per-bit BigInt shifting.
    getHeuristic(state) {
        const dt = this.dist_table;
        let h = 0;

        let lo = Number(state & 0xFFFFFFFFn);
        while (lo !== 0) {
            const d = dt[31 - Math.clz32(lo & -lo)];
            if (d === INF) return INF;
            if (d > h) h = d;
            lo &= lo - 1;
        }

        let hi = Number(state >> 32n);
        while (hi !== 0) {
            const d = dt[32 + (31 - Math.clz32(hi & -hi))];
            if (d === INF) return INF;
            if (d > h) h = d;
            hi &= hi - 1;
        }

        return h;
    }

    shiftU(x) { return x >> 8n; }
    shiftD(x) { return (x << 8n) & MASK_64; }
    shiftL(x) { return (x >> 1n) & NOT_COL7_MASK; }
    shiftR(x) { return (x << 1n) & NOT_COL0_MASK; }

    moveBitboard(state, dir) {
        let moving = state; 
        
        for (let i = 0; i < 8; ++i) {
            let edge_blocked_src = 0n;
            if (dir === 0) edge_blocked_src = moving & ROW0_MASK;
            else if (dir === 1) edge_blocked_src = moving & ROW7_MASK;
            else if (dir === 2) edge_blocked_src = moving & COL0_MASK;
            else if (dir === 3) edge_blocked_src = moving & COL7_MASK;

            let dest = 0n;
            if (dir === 0) dest = this.shiftU(moving);
            else if (dir === 1) dest = this.shiftD(moving);
            else if (dir === 2) dest = this.shiftL(moving);
            else if (dir === 3) dest = this.shiftR(moving);

            let stationary = state ^ moving;
            let blocked_dest = dest & (this.WALLS | stationary);
            
            let blocked_src = edge_blocked_src;
            if (dir === 0) blocked_src |= this.shiftD(blocked_dest) & moving;
            else if (dir === 1) blocked_src |= this.shiftU(blocked_dest) & moving;
            else if (dir === 2) blocked_src |= this.shiftR(blocked_dest) & moving;
            else if (dir === 3) blocked_src |= this.shiftL(blocked_dest) & moving;

            if (blocked_src === 0n) break;
            moving ^= blocked_src;
        }

        let final_dest = 0n;
        if (dir === 0) final_dest = this.shiftU(moving);
        else if (dir === 1) final_dest = this.shiftD(moving);
        else if (dir === 2) final_dest = this.shiftL(moving);
        else if (dir === 3) final_dest = this.shiftR(moving);

        return (state ^ moving) | final_dest;
    }

    // Per (direction, line) inverse tables: which line states could have
    // produced each observed line state. Only 4 * 8 * 256 entries, so this is
    // cheap to build and is what makes searching backward from the goal possible.
    initLineTables() {
        this.lineInverse = [];
        for (let dir = 0; dir < 4; ++dir) {
            this.lineInverse[dir] = [];
            for (let idx = 0; idx < 8; ++idx) {
                const wallMask = extractLine(this.WALLS, dir, idx);
                const inverse = Array.from({ length: 256 }, () => []);
                for (let m = 0; m < 256; ++m) {
                    if (m & wallMask) continue;   // blocks can never sit on walls
                    inverse[lineStep(m, wallMask, LINE_STEP[dir])].push(m);
                }
                this.lineInverse[dir][idx] = inverse;
            }
        }
    }

    // Every state P with moveBitboard(P, dir) === board.
    predecessors(board, dir) {
        let results = [0n];
        for (let idx = 0; idx < 8; ++idx) {
            const options = this.lineInverse[dir][idx][extractLine(board, dir, idx)];
            if (options.length === 0) return [];
            const next = [];
            for (const base of results) {
                for (const opt of options) next.push(insertLine(base, dir, idx, opt));
            }
            results = next;
        }
        return results;
    }

    // Bidirectional BFS. The heuristic is near-useless on boards where blocks
    // must split apart rather than translate (it can read 2 when the answer is
    // 23), which makes A* degenerate into brute force. Searching from both ends
    // sidesteps the heuristic entirely: each side only has to reach half the
    // depth, and the backward side stays much smaller than the forward one.
    solveBidirectional({ maxStates = 4000000, deadline, onProgress = null }) {
        const start = this.start_state;
        const goal = this.TARGET;
        if (start === goal) return { status: 'solved', optimal: true, path: [], states: [start] };

        const F = new StateTable();
        const B = new StateTable();
        F.add(loOf(start), hiOf(start), -1, 255, 0);
        B.add(loOf(goal), hiOf(goal), -1, 255, 0);
        let fFrontier = [0], bFrontier = [0];   // slot indices, not boards
        let dF = 0, dB = 0;
        let best = Infinity;
        let meetF = -1, meetB = -1;
        let proven = false;

        while (fFrontier.length && bFrontier.length) {
            // Nothing unexplored can beat `best` once the two depths meet it.
            if (dF + dB >= best) { proven = true; break; }
            if (performance.now() > deadline || F.size + B.size > maxStates) break;
            if (onProgress) onProgress(F.size + B.size);

            if (fFrontier.length <= bFrontier.length) {
                const next = [];
                for (const slot of fFrontier) {
                    const state = F.boardAt(slot);
                    for (let dir = 0; dir < 4; ++dir) {
                        const ns = this.moveBitboard(state, dir);
                        if (ns === state) continue;
                        const lo = loOf(ns), hi = hiOf(ns);
                        const added = F.add(lo, hi, slot, dir, dF + 1);
                        if (added === -1) continue;
                        next.push(added);
                        const other = B.find(lo, hi);
                        if (other !== -1 && dF + 1 + B.entryDepth[other] < best) {
                            best = dF + 1 + B.entryDepth[other];
                            meetF = added; meetB = other;
                        }
                    }
                }
                fFrontier = next; dF++;
            } else {
                const next = [];
                for (const slot of bFrontier) {
                    const state = B.boardAt(slot);
                    for (let dir = 0; dir < 4; ++dir) {
                        for (const p of this.predecessors(state, dir)) {
                            const lo = loOf(p), hi = hiOf(p);
                            const added = B.add(lo, hi, slot, dir, dB + 1);
                            if (added === -1) continue;
                            next.push(added);
                            const other = F.find(lo, hi);
                            if (other !== -1 && dB + 1 + F.entryDepth[other] < best) {
                                best = dB + 1 + F.entryDepth[other];
                                meetF = other; meetB = added;
                            }
                        }
                    }
                }
                bFrontier = next; dB++;
            }
        }
        if (!fFrontier.length || !bFrontier.length) proven = true;
        if (meetF === -1) {
            // Only a fully explored search proves there is no solution.
            return { status: proven ? 'unsolvable' : 'timeout' };
        }

        const forwardMoves = [];
        for (let s = meetF; F.entryParent[s] !== -1; s = F.entryParent[s]) {
            forwardMoves.push(DIR_CHARS[F.entryMove[s]]);
        }
        forwardMoves.reverse();
        // In the backward table, `parent` points one step CLOSER to the goal,
        // so walking it forward from the meeting point spells out the tail.
        const backwardMoves = [];
        for (let s = meetB; B.entryParent[s] !== -1; s = B.entryParent[s]) {
            backwardMoves.push(DIR_CHARS[B.entryMove[s]]);
        }

        const path = forwardMoves.concat(backwardMoves);
        const states = [start];
        let cur = start;
        for (const mv of path) {
            cur = this.moveBitboard(cur, DIR_CHARS.indexOf(mv));
            states.push(cur);
        }
        return { status: 'solved', optimal: proven, path, states };
    }

    // Reconstructs path/states by walking parent pointers instead of
    // copying arrays on every expansion (which made long solutions O(n^2)).
    reconstruct(goalNode) {
        const path = [];
        const states = [];
        let n = goalNode;
        while (n) {
            states.push(n.state);
            if (n.move !== null) path.push(n.move);
            n = n.parent;
        }
        path.reverse();
        states.reverse();
        return { path, states };
    }

    // Single A* run. `weight` inflates the heuristic (f = g + weight*h):
    // weight === 1 is standard admissible/optimal A*; weight > 1 trades
    // solution optimality for speed (bounded-suboptimal "Weighted A*"),
    // used as a fallback when the exact search is too slow.
    runAStar({ weight, nodeLimit, deadline, upperBound = Infinity, maxStates = 2000000, onProgress = null }) {
        const open_list = new PriorityQueue();
        const best_g = new Map();
        const dirChars = ['U', 'D', 'L', 'R'];

        const start_h = this.getHeuristic(this.start_state);
        if (start_h === INF) return { status: 'unsolvable', nodesExplored: 0 };

        open_list.push({ state: this.start_state, g: 0, h: start_h, f: start_h * weight, parent: null, move: null });
        best_g.set(this.start_state, 0);

        let nodes_explored = 0;

        while (!open_list.isEmpty()) {
            const curr = open_list.pop();

            // Skip stale queue entries superseded by a cheaper path to the same state.
            if (curr.g > best_g.get(curr.state)) continue;

            nodes_explored++;

            // Bail out before exhausting memory; a JS Map also hard-caps near 16M entries.
            if ((nodes_explored & 511) === 0) {
                // 262144 is a multiple of 512, so this rides the same check.
                if (onProgress && (nodes_explored & 262143) === 0) onProgress(nodes_explored);
                if (best_g.size > maxStates) {
                    return { status: 'timeout', reason: 'memory', nodesExplored: nodes_explored };
                }
                if (performance.now() > deadline) {
                    return { status: 'timeout', reason: 'time', nodesExplored: nodes_explored };
                }
            }
            if (nodes_explored > nodeLimit) {
                return { status: 'timeout', reason: 'nodes', nodesExplored: nodes_explored };
            }

            if (curr.state === this.TARGET) {
                return { status: 'solved', node: curr, nodesExplored: nodes_explored };
            }

            for (let i = 0; i < 4; ++i) {
                const next_state = this.moveBitboard(curr.state, i);
                if (next_state === curr.state) continue;

                const next_g = curr.g + 1;
                const prevBest = best_g.get(next_state);
                if (prevBest !== undefined && prevBest <= next_g) continue;

                const h = this.getHeuristic(next_state);
                if (h === INF) continue;
                // h is admissible, so this node can never beat a known solution.
                if (next_g + h >= upperBound) continue;

                best_g.set(next_state, next_g);
                open_list.push({
                    state: next_state,
                    g: next_g,
                    h: h,
                    f: next_g + weight * h,
                    parent: curr,
                    move: dirChars[i]
                });
            }
        }

        return { status: 'unsolvable', nodesExplored: nodes_explored };
    }

    // Anytime search, greedy-first. Weighted A* passes run from most greedy to
    // least, so a solution is found fast and then refined toward optimal with
    // whatever budget remains. Returns the shortest solution found; only a
    // completed weight-1 pass is reported as proven optimal.
    solve(options = {}) {
        const {
            maxNodesPerPhase = 20000000,
            maxStates = 2000000,
            totalTimeBudgetMs = 15000,
            weights = [12, 6, 3, 2, 1],
            onProgress = null
        } = options;

        const overallStart = performance.now();
        const endTime = overallStart + totalTimeBudgetMs;
        let nodesExplored = 0;
        let best = null;
        let lastReason = 'time';

        // The A* fallback still keeps a Map of BigInt-keyed nodes (~200 bytes a
        // state) whereas the bidirectional search packs states into typed
        // arrays (~15 bytes). They cannot share one state budget, or raising it
        // for the packed search would let the fallback exhaust memory.
        const fallbackMaxStates = Math.min(maxStates, 2000000);

        // Bidirectional BFS first: it returns a proven-optimal answer and is
        // usually far faster, especially on the boards where the heuristic is
        // blind. Give it most of the budget; if it can't finish, the weighted
        // A* passes below still have time to produce an approximate answer.
        const bidi = this.solveBidirectional({
            maxStates,
            deadline: overallStart + totalTimeBudgetMs * 0.7,
            onProgress
        });
        if (bidi.status === 'solved' && bidi.optimal) {
            return {
                success: true,
                optimal: true,
                message: `Optimal solution in ${bidi.path.length} steps`,
                path: bidi.path,
                states: bidi.states
            };
        }
        if (bidi.status === 'unsolvable') {
            return { success: false, message: "No solution exists for this board.", path: [], states: [] };
        }
        // Timed out: keep any partial answer as the baseline to beat.
        if (bidi.status === 'solved') best = { path: bidi.path, states: bidi.states };

        for (let i = 0; i < weights.length; ++i) {
            const remaining = endTime - performance.now();
            if (remaining <= 0) break;

            // Securing a first solution takes priority: until one exists, a pass
            // may use the whole remaining budget. Splitting evenly from the start
            // starved every pass on a small budget and returned nothing at all.
            // Once a solution is in hand, later passes get even slices to refine
            // it, except the final exact pass which may use whatever is left.
            const weight = weights[i];
            const share = remaining / (weights.length - i);
            const useFullRemaining = !best || weight === 1;
            const result = this.runAStar({
                weight,
                nodeLimit: maxNodesPerPhase,
                maxStates: fallbackMaxStates,
                deadline: performance.now() + (useFullRemaining ? remaining : share),
                upperBound: best ? best.path.length : Infinity,
                // Report a running total across phases, not per-phase counts.
                onProgress: onProgress ? (n) => onProgress(nodesExplored + n) : null
            });
            nodesExplored += result.nodesExplored || 0;
            if (result.reason) lastReason = result.reason;

            // Open list emptied: the reachable space was searched exhaustively.
            // With an upper bound in place that proves nothing shorter exists,
            // so the best solution already in hand is optimal.
            if (result.status === 'unsolvable') {
                if (best) {
                    return {
                        success: true,
                        optimal: true,
                        message: `Optimal solution in ${best.path.length} steps`,
                        path: best.path,
                        states: best.states
                    };
                }
                return { success: false, message: "No solution exists for this board.", path: [], states: [] };
            }

            if (result.status === 'solved') {
                const { path, states } = this.reconstruct(result.node);
                if (!best || path.length < best.path.length) best = { path, states };
                if (weight === 1) {
                    return {
                        success: true,
                        optimal: true,
                        message: `Optimal solution in ${path.length} steps`,
                        path,
                        states
                    };
                }
            }
        }

        if (best) {
            return {
                success: true,
                optimal: false,
                message: `Approximate solution in ${best.path.length} steps (not guaranteed minimal)`,
                path: best.path,
                states: best.states
            };
        }

        // Nothing found, but the search never completed, so this is "gave up",
        // not "unsolvable" -- say which limit was hit so the hint is actionable.
        const elapsed = Math.round(performance.now() - overallStart);
        const limitHint = lastReason === 'memory'
            ? 'hit the memory limit'
            : `ran out of time after ${elapsed}ms`;
        return {
            success: false,
            exhausted: false,
            message: `Gave up: ${limitHint} (~${nodesExplored} nodes). A solution may still exist - try a higher search strength.`,
            path: [],
            states: []
        };
    }
}