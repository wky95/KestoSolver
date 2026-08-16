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

// Caps the best-effort sampling loop so an unlimited time budget still ends.
const MAX_BEAM_ROUNDS = 14;

// Extra time the fallback may spend once the exact search has used its whole
// budget, as a fraction of that budget. The interface derives the worst case it
// advertises from this same constant, so a change here cannot leave the label
// promising something the search will not honour.
const BEAM_TIME_SHARE = 0.5;

// "Optimal solution in 1 steps" is reachable on a one-move board.
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Open-addressed hash table for visited states, packed into typed arrays.
//
// A Map<BigInt, {parent, move, d}> costs ~200 bytes per state once the BigInt
// objects, Map entries and value objects are counted, and memory is what caps
// the search. Storing the board as two 32-bit halves with the parent held as a
// slot index gets that to ~14 bytes of payload, so the same RAM holds roughly
// an order of magnitude more states.
class StateTable {
    // `ceiling` is the most states this table will ever be asked to hold. It is
    // a growth limit, not a reservation: the arrays still start small, so an
    // easy board allocates almost nothing. It only stops the final doubling
    // from overshooting into slots that can never be filled.
    //
    // Worth 47-64MB on a board that exhausts its budget, depending on where the
    // final size falls relative to a power of two - modest, but it costs
    // nothing and it also shortens the copy that each grow pays for. Reserving
    // the full ceiling up front was measured and rejected: it would allocate
    // hundreds of megabytes for the many boards that solve in a thousand states.
    constructor(ceiling = 0) {
        this.ceiling = ceiling > 0 ? ceiling : 0;
        this.allocate(16);
        this.size = 0;
    }

    allocate(capacityLog2) {
        this.capacityLog2 = capacityLog2;
        this.capacity = 1 << capacityLog2;
        this.mask = this.capacity - 1;
        // (0,0) is never a real board: block count is invariant and non-zero,
        // so an all-zero key doubles as the empty-slot marker.
        //
        // Measured alternatives that did not earn their cost: interleaving these
        // three into one stride-4 array was within noise while using 33% more
        // memory per bucket, and dropping the load factor to 50% gained 3.5% for
        // double the table. The probe path is not the bottleneck.
        this.keyLo = new Uint32Array(this.capacity);
        this.keyHi = new Uint32Array(this.capacity);
        this.slotOf = new Int32Array(this.capacity).fill(-1);
        this.growAt = (this.capacity * 3) >> 2;   // grow past 75% load
    }

    // Sizes both arrays for `n` states up front. Growing them mid-search means a
    // reallocation plus a copy of everything so far, and neither can be
    // interrupted - a deadline checked every few hundred nodes cannot preempt a
    // rehash of six million entries, which is how the A* phase overran its clock
    // by seconds. Only worth calling where the search is already known to be a
    // hard one; on an easy board this would reserve hundreds of MB for nothing.
    reserve(n) {
        if (n <= 0) return;
        let log2 = this.capacityLog2;
        while ((1 << log2) * 0.75 < n) log2++;
        if (log2 > this.capacityLog2) this.allocate(log2);
        this.ensureEntryArrays(n);
    }

    ensureEntryArrays(minimum) {
        if (this.entryLo && this.entryLo.length >= minimum) return;
        let next = Math.max(1024, minimum, this.entryLo ? this.entryLo.length * 2 : 1024);
        // Never reserve room for states that cannot exist. Both the array and
        // the copy that fills it are paid for, so trimming the last step saves
        // steady memory and shortens the spike during the grow.
        if (this.ceiling > 0) next = Math.max(minimum, Math.min(next, this.ceiling));
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

}

const loOf = (board) => Number(board & 0xFFFFFFFFn) >>> 0;
const hiOf = (board) => Number(board >> 32n) >>> 0;
const boardOf = (lo, hi) => (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);

// Bit-reversal within a byte, i.e. one row flipped left-to-right.
const REVERSE_BYTE = new Uint8Array(256);
for (let i = 0; i < 256; ++i) {
    let v = 0;
    for (let b = 0; b < 8; ++b) if (i & (1 << b)) v |= 1 << (7 - b);
    REVERSE_BYTE[i] = v;
}
const reverseBitsInBytes = (x) => (
    REVERSE_BYTE[x & 0xFF] |
    (REVERSE_BYTE[(x >>> 8) & 0xFF] << 8) |
    (REVERSE_BYTE[(x >>> 16) & 0xFF] << 16) |
    (REVERSE_BYTE[(x >>> 24) & 0xFF] << 24)
) >>> 0;
const swapBytes = (x) => (
    (x >>> 24) | ((x >>> 8) & 0xFF00) | ((x << 8) & 0xFF0000) | (x << 24)
) >>> 0;

// Rows are bytes, so flipping left-to-right reverses the bits inside each byte
// and flipping top-to-bottom reverses the order of the bytes - which, split
// across the (lo, hi) pair, is a byte swap of each half plus an exchange.
const mirrorHLo = (lo) => reverseBitsInBytes(lo);
const mirrorHHi = (hi) => reverseBitsInBytes(hi);
const mirrorVLo = (lo, hi) => swapBytes(hi);
const mirrorVHi = (lo, hi) => swapBytes(lo);

// The same 64-bit masks as above, split across the (lo, hi) uint32 pair the
// search actually runs on. lo holds rows 0-3, hi holds rows 4-7.
const U32_ROW0_LO = 0x000000FF, U32_ROW0_HI = 0x00000000;
const U32_ROW7_LO = 0x00000000, U32_ROW7_HI = 0xFF000000 | 0;
const U32_COL0 = 0x01010101, U32_COL7 = 0x80808080 | 0;
const U32_NOT_COL7 = 0x7F7F7F7F, U32_NOT_COL0 = 0xFEFEFEFE | 0;
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

// extractLine on a (lo, hi) pair. Rows are already contiguous bytes; columns
// have to be gathered a bit at a time.
function extractLineU32(lo, hi, dir, idx) {
    if (IS_ROW_LINE[dir]) {
        return idx < 4 ? (lo >>> (idx * 8)) & 0xFF : (hi >>> ((idx - 4) * 8)) & 0xFF;
    }
    return (
        ((lo >>> idx) & 1) |
        (((lo >>> (idx + 8)) & 1) << 1) |
        (((lo >>> (idx + 16)) & 1) << 2) |
        (((lo >>> (idx + 24)) & 1) << 3) |
        (((hi >>> idx) & 1) << 4) |
        (((hi >>> (idx + 8)) & 1) << 5) |
        (((hi >>> (idx + 16)) & 1) << 6) |
        (((hi >>> (idx + 24)) & 1) << 7)
    );
}

function extractLine(board, dir, idx) {
    if (IS_ROW_LINE[dir]) return Number((board >> BigInt(idx * 8)) & 0xFFn);
    let m = 0;
    for (let r = 0; r < 8; r++) if ((board >> BigInt(r * 8 + idx)) & 1n) m |= 1 << r;
    return m;
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

        // uint32 mirrors of the three boards. The search runs on these; the
        // BigInt originals stay for the table setup and the returned states.
        this.WALL_LO = loOf(this.WALLS);
        this.WALL_HI = hiOf(this.WALLS);
        this.TARGET_LO = loOf(this.TARGET);
        this.TARGET_HI = hiOf(this.TARGET);
        this.START_LO = loOf(this.start_state);
        this.START_HI = hiOf(this.start_state);
        this._mvLo = 0;
        this._mvHi = 0;

        // A mirror is only a symmetry of the puzzle if it maps the walls and the
        // targets onto themselves - the blocks may sit anywhere. Where one does,
        // positions that differ only by that mirror are the same problem, so the
        // search stores one representative and covers both.
        //
        // Only the mirrors are checked. The diagonal reflections would need the
        // board transposed, which no daily puzzle has been symmetric under, and
        // 180 degrees is just the two mirrors composed.
        this.symH = mirrorHLo(this.WALL_LO) === this.WALL_LO
            && mirrorHHi(this.WALL_HI) === this.WALL_HI
            && mirrorHLo(this.TARGET_LO) === this.TARGET_LO
            && mirrorHHi(this.TARGET_HI) === this.TARGET_HI;
        this.symV = mirrorVLo(this.WALL_LO, this.WALL_HI) === this.WALL_LO
            && mirrorVHi(this.WALL_LO, this.WALL_HI) === this.WALL_HI
            && mirrorVLo(this.TARGET_LO, this.TARGET_HI) === this.TARGET_LO
            && mirrorVHi(this.TARGET_LO, this.TARGET_HI) === this.TARGET_HI;
        this.useSymmetry = this.symH || this.symV;
        this._cLo = 0;
        this._cHi = 0;

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

    // Admissible: every block must reach some target and a move advances a
    // block by at most one square, so the furthest block's distance is a floor
    // on the move count. Loose - it ignores that the targets must be distinct -
    // but a bound that is wrong would turn "proven optimal" into a lie.
    getHeuristicLoHi(lo, hi) {
        const dt = this.dist_table;
        let h = 0;

        let b = lo;
        while (b !== 0) {
            const d = dt[31 - Math.clz32(b & -b)];
            if (d === INF) return INF;
            if (d > h) h = d;
            b &= b - 1;
        }
        b = hi;
        while (b !== 0) {
            const d = dt[32 + (31 - Math.clz32(b & -b))];
            if (d === INF) return INF;
            if (d > h) h = d;
            b &= b - 1;
        }
        return h;
    }

    shiftU(x) { return x >> 8n; }
    shiftD(x) { return (x << 8n) & MASK_64; }
    shiftL(x) { return (x >> 1n) & NOT_COL7_MASK; }
    shiftR(x) { return (x << 1n) & NOT_COL0_MASK; }

    // moveBitboard's rule on a (lo, hi) uint32 pair, which is what the search
    // stores. BigInt allocates and boxes on every shift; with eight shift rounds
    // per node and millions of nodes per search that dominated the runtime.
    //
    // The result lands in this._mvLo / this._mvHi rather than being returned:
    // returning a pair or an array would allocate once per expansion.
    moveLoHi(lo, hi, dir) {
        let ml = lo, mh = hi;

        for (let i = 0; i < 8; ++i) {
            // Blocks already against the far edge can never advance.
            let el, eh;
            if (dir === 0)      { el = ml & U32_ROW0_LO; eh = mh & U32_ROW0_HI; }
            else if (dir === 1) { el = ml & U32_ROW7_LO; eh = mh & U32_ROW7_HI; }
            else if (dir === 2) { el = ml & U32_COL0;    eh = mh & U32_COL0; }
            else                { el = ml & U32_COL7;    eh = mh & U32_COL7; }

            let dl, dh;
            if (dir === 0)      { dl = ((ml >>> 8) | (mh << 24)) >>> 0; dh = mh >>> 8; }
            else if (dir === 1) { dl = (ml << 8) >>> 0; dh = ((mh << 8) | (ml >>> 24)) >>> 0; }
            else if (dir === 2) { dl = (((ml >>> 1) | (mh << 31)) & U32_NOT_COL7) >>> 0; dh = ((mh >>> 1) & U32_NOT_COL7) >>> 0; }
            else                { dl = ((ml << 1) & U32_NOT_COL0) >>> 0; dh = (((mh << 1) | (ml >>> 31)) & U32_NOT_COL0) >>> 0; }

            const stl = (lo ^ ml) >>> 0, sth = (hi ^ mh) >>> 0;
            const bdl = (dl & ((this.WALL_LO | stl) >>> 0)) >>> 0;
            const bdh = (dh & ((this.WALL_HI | sth) >>> 0)) >>> 0;

            // Push the blocked destinations back one square to find which
            // sources they belong to.
            let rl, rh;
            if (dir === 0)      { rl = (bdl << 8) >>> 0; rh = ((bdh << 8) | (bdl >>> 24)) >>> 0; }
            else if (dir === 1) { rl = ((bdl >>> 8) | (bdh << 24)) >>> 0; rh = bdh >>> 8; }
            else if (dir === 2) { rl = ((bdl << 1) & U32_NOT_COL0) >>> 0; rh = (((bdh << 1) | (bdl >>> 31)) & U32_NOT_COL0) >>> 0; }
            else                { rl = (((bdl >>> 1) | (bdh << 31)) & U32_NOT_COL7) >>> 0; rh = ((bdh >>> 1) & U32_NOT_COL7) >>> 0; }

            const bsl = (el | (rl & ml)) >>> 0, bsh = (eh | (rh & mh)) >>> 0;
            if (bsl === 0 && bsh === 0) break;
            ml = (ml ^ bsl) >>> 0; mh = (mh ^ bsh) >>> 0;
        }

        let fl, fh;
        if (dir === 0)      { fl = ((ml >>> 8) | (mh << 24)) >>> 0; fh = mh >>> 8; }
        else if (dir === 1) { fl = (ml << 8) >>> 0; fh = ((mh << 8) | (ml >>> 24)) >>> 0; }
        else if (dir === 2) { fl = (((ml >>> 1) | (mh << 31)) & U32_NOT_COL7) >>> 0; fh = ((mh >>> 1) & U32_NOT_COL7) >>> 0; }
        else                { fl = ((ml << 1) & U32_NOT_COL0) >>> 0; fh = (((mh << 1) | (ml >>> 31)) & U32_NOT_COL0) >>> 0; }

        this._mvLo = (((lo ^ ml) | fl) >>> 0);
        this._mvHi = (((hi ^ mh) | fh) >>> 0);
    }

    // The smallest of a position's mirror images, written to this._cLo/_cHi.
    // Two positions that differ only by a symmetry canonicalise to the same
    // pair, so the search visits the family once instead of once per member.
    //
    // Callers guard on this.useSymmetry rather than relying on an early return
    // here: the guard hoists out of the expansion loop, so boards with no
    // symmetry never reach this at all.
    canonLoHi(lo, hi) {
        let bestLo = lo, bestHi = hi;

        if (this.symH) {
            const l = mirrorHLo(lo), h = mirrorHHi(hi);
            if (h < bestHi || (h === bestHi && l < bestLo)) { bestLo = l; bestHi = h; }
        }
        if (this.symV) {
            const l = mirrorVLo(lo, hi), h = mirrorVHi(lo, hi);
            if (h < bestHi || (h === bestHi && l < bestLo)) { bestLo = l; bestHi = h; }
        }
        if (this.symH && this.symV) {
            // The two composed, i.e. a half turn.
            const hl = mirrorHLo(lo), hh = mirrorHHi(hi);
            const l = mirrorVLo(hl, hh), h = mirrorVHi(hl, hh);
            if (h < bestHi || (h === bestHi && l < bestLo)) { bestLo = l; bestHi = h; }
        }

        this._cLo = bestLo;
        this._cHi = bestHi;
    }

    // Turns a chain of stored states into real moves.
    //
    // Under symmetry the stored states are representatives, so replaying the
    // recorded moves from the real start would drift onto a mirrored board.
    // Instead, walk the chain: from the actual position, whichever move lands
    // on something that canonicalises to the next link is a legal choice, and
    // one is guaranteed to exist because a move commutes with a mirror. Without
    // symmetry this degenerates to replaying the chain, so both engines share it.
    //
    // `chain` is a flat [lo, hi, ...] list starting at the canonical form of the
    // start. Returns null if no move matches, which would mean the bookkeeping
    // is wrong - better to report no solution than to hand back a broken path.
    liftChain(chain) {
        const useSym = this.useSymmetry;
        const path = [];
        const states = [this.start_state];
        let curLo = this.START_LO, curHi = this.START_HI;

        for (let i = 2; i < chain.length; i += 2) {
            const wantLo = chain[i], wantHi = chain[i + 1];
            let took = -1;
            for (let dir = 0; dir < 4; ++dir) {
                this.moveLoHi(curLo, curHi, dir);
                const nLo = this._mvLo, nHi = this._mvHi;
                let kLo = nLo, kHi = nHi;
                if (useSym) { this.canonLoHi(nLo, nHi); kLo = this._cLo; kHi = this._cHi; }
                if (kLo === wantLo && kHi === wantHi) {
                    took = dir; curLo = nLo; curHi = nHi;
                    break;
                }
            }
            if (took === -1) return null;
            path.push(DIR_CHARS[took]);
            states.push(boardOf(curLo, curHi));
        }
        return { path, states };
    }

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

        // Writing a column back into a (lo, hi) pair means scattering eight
        // bits; predecessors() does that in its innermost loop, so precompute
        // every (column, line value) contribution once. 8 * 256 entries.
        this.colInsertLo = [];
        this.colInsertHi = [];
        for (let idx = 0; idx < 8; ++idx) {
            const lo = new Int32Array(256), hi = new Int32Array(256);
            for (let m = 0; m < 256; ++m) {
                let l = 0, h = 0;
                for (let r = 0; r < 4; ++r) if (m & (1 << r)) l |= 1 << (r * 8 + idx);
                for (let r = 4; r < 8; ++r) if (m & (1 << r)) h |= 1 << ((r - 4) * 8 + idx);
                lo[m] = l; hi[m] = h;
            }
            this.colInsertLo.push(lo);
            this.colInsertHi.push(hi);
        }
    }

    // predecessors() on a (lo, hi) pair. Returns a flat [lo0, hi0, lo1, hi1, ...]
    // array, or null when some line has no possible predecessor.
    predecessorsLoHi(lo, hi, dir) {
        const isRow = IS_ROW_LINE[dir];
        let out = [0, 0];

        for (let idx = 0; idx < 8; ++idx) {
            const options = this.lineInverse[dir][idx][extractLineU32(lo, hi, dir, idx)];
            if (options.length === 0) return null;

            const next = [];
            const cLo = isRow ? null : this.colInsertLo[idx];
            const cHi = isRow ? null : this.colInsertHi[idx];
            const rowShift = idx < 4 ? idx * 8 : (idx - 4) * 8;

            for (let b = 0; b < out.length; b += 2) {
                const bl = out[b], bh = out[b + 1];
                for (let o = 0; o < options.length; ++o) {
                    const m = options[o];
                    if (isRow) {
                        if (idx < 4) next.push((bl | (m << rowShift)) >>> 0, bh);
                        else next.push(bl, (bh | (m << rowShift)) >>> 0);
                    } else {
                        next.push((bl | cLo[m]) >>> 0, (bh | cHi[m]) >>> 0);
                    }
                }
            }
            out = next;
        }
        return out;
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

        // Hoisted so the expansion loops below branch on a constant.
        const useSym = this.useSymmetry;

        // Either table could in principle hold the whole budget, so both take
        // the full figure as their ceiling.
        const F = new StateTable(maxStates);
        const B = new StateTable(maxStates);
        // The goal is fixed by every symmetry in the group, so it is already
        // canonical; the start generally is not.
        if (useSym) this.canonLoHi(loOf(start), hiOf(start));
        F.add(useSym ? this._cLo : loOf(start), useSym ? this._cHi : hiOf(start), -1, 255, 0);
        B.add(loOf(goal), hiOf(goal), -1, 255, 0);
        let fFrontier = [0], bFrontier = [0];   // slot indices, not boards
        let dF = 0, dB = 0;
        let best = Infinity;
        let meetF = -1, meetB = -1;
        let proven = false;
        let aborted = false;   // deadline hit part-way through a level

        while (fFrontier.length && bFrontier.length) {
            // Nothing unexplored can beat `best` once the two depths meet it.
            if (dF + dB >= best) { proven = true; break; }
            if (performance.now() > deadline || F.size + B.size > maxStates) break;
            if (onProgress) onProgress(F.size + B.size);

            if (fFrontier.length <= bFrontier.length) {
                const next = [];
                let checked = 0;
                for (const slot of fFrontier) {
                    // Checking only between levels used to overrun the budget by
                    // however long one level takes, and levels grow ~3x each
                    // time. Faster expansion reached bigger levels, so the
                    // overrun grew with it and ate the fallback's share of the
                    // time. Abandoning a level part-way is safe: the outer loop
                    // exits with a non-empty frontier, so nothing is reported as
                    // proven.
                    if ((++checked & 1023) === 0 && performance.now() > deadline) {
                        aborted = true;
                        break;
                    }
                    // Read the packed pair straight out of the table; rebuilding
                    // a BigInt here cost more than the move itself.
                    const sLo = F.entryLo[slot] >>> 0, sHi = F.entryHi[slot] >>> 0;
                    for (let dir = 0; dir < 4; ++dir) {
                        this.moveLoHi(sLo, sHi, dir);
                        let lo = this._mvLo, hi = this._mvHi;
                        if (lo === sLo && hi === sHi) continue;
                        if (useSym) { this.canonLoHi(lo, hi); lo = this._cLo; hi = this._cHi; }
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
                if (aborted) break;
                fFrontier = next; dF++;
            } else {
                const next = [];
                let checked = 0;
                for (const slot of bFrontier) {
                    if ((++checked & 255) === 0 && performance.now() > deadline) {
                        aborted = true;
                        break;
                    }
                    const sLo = B.entryLo[slot] >>> 0, sHi = B.entryHi[slot] >>> 0;
                    for (let dir = 0; dir < 4; ++dir) {
                        const preds = this.predecessorsLoHi(sLo, sHi, dir);
                        if (preds === null) continue;
                        for (let i = 0; i < preds.length; i += 2) {
                            let lo = preds[i] >>> 0, hi = preds[i + 1] >>> 0;
                            // Canonicalising the predecessors of one representative
                            // yields every quotient predecessor: a predecessor of a
                            // mirrored position is the mirror of a predecessor.
                            if (useSym) { this.canonLoHi(lo, hi); lo = this._cLo; hi = this._cHi; }
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
                if (aborted) break;
                bFrontier = next; dB++;
            }
        }
        if (!fFrontier.length || !bFrontier.length) proven = true;
        if (meetF === -1) {
            // Only a fully explored search proves there is no solution.
            return { status: proven ? 'unsolvable' : 'timeout' };
        }

        // Both halves are chains of stored states, which under symmetry are
        // representatives rather than real positions. Collect the chain, then
        // walk it from the real start: at each link, whichever move lands on
        // something that canonicalises to the next link is a legal move, and
        // one always exists. That recovers a real path without tracking which
        // mirror each representative stood for.
        const chain = [];   // [lo, hi] pairs, canon(start) through to the goal
        for (let s = meetF; s !== -1; s = F.entryParent[s]) {
            chain.push(F.entryLo[s] >>> 0, F.entryHi[s] >>> 0);
        }
        for (let i = 0, j = chain.length - 2; i < j; i += 2, j -= 2) {
            const l = chain[i], h = chain[i + 1];
            chain[i] = chain[j]; chain[i + 1] = chain[j + 1];
            chain[j] = l; chain[j + 1] = h;
        }
        // In the backward table, `parent` points one step CLOSER to the goal, so
        // walking it from the meeting point spells out the tail. The meeting
        // state itself is already the last entry above.
        for (let s = B.entryParent[meetB]; s !== -1; s = B.entryParent[s]) {
            chain.push(B.entryLo[s] >>> 0, B.entryHi[s] >>> 0);
        }

        const lifted = this.liftChain(chain);
        if (!lifted) return { status: 'timeout' };
        return { status: 'solved', optimal: proven, path: lifted.path, states: lifted.states };
    }

    // Walks a StateTable parent chain back to the start and lifts it into real
    // moves, the same way the bidirectional search does.
    reconstruct(table, slot) {
        const chain = [];
        for (let s = slot; s !== -1; s = table.entryParent[s]) {
            chain.push(table.entryLo[s] >>> 0, table.entryHi[s] >>> 0);
        }
        for (let i = 0, j = chain.length - 2; i < j; i += 2, j -= 2) {
            const l = chain[i], h = chain[i + 1];
            chain[i] = chain[j]; chain[i + 1] = chain[j + 1];
            chain[j] = l; chain[j + 1] = h;
        }
        return this.liftChain(chain);
    }

    // One BFS per target, so scoring can reason about which block goes to which
    // target rather than lumping all targets together. Built on first use: only
    // beam search needs it, and most boards never reach beam search.
    ensureTargetDistances() {
        if (this.distTo) return;

        this.targetCells = [];
        for (let i = 0; i < 64; ++i) {
            const bit = i < 32 ? (this.TARGET_LO >>> i) & 1 : (this.TARGET_HI >>> (i - 32)) & 1;
            if (bit) this.targetCells.push(i);
        }

        const isWall = (i) => (i < 32 ? (this.WALL_LO >>> i) & 1 : (this.WALL_HI >>> (i - 32)) & 1) === 1;
        this.distTo = this.targetCells.map(t => {
            const d = new Int32Array(64).fill(INF);
            d[t] = 0;
            const q = [t];
            for (let head = 0; head < q.length; ++head) {
                const i = q[head], r = i >> 3, c = i & 7, nd = d[i] + 1;
                if (r > 0 && !isWall(i - 8) && d[i - 8] > nd) { d[i - 8] = nd; q.push(i - 8); }
                if (r < 7 && !isWall(i + 8) && d[i + 8] > nd) { d[i + 8] = nd; q.push(i + 8); }
                if (c > 0 && !isWall(i - 1) && d[i - 1] > nd) { d[i - 1] = nd; q.push(i - 1); }
                if (c < 7 && !isWall(i + 1) && d[i + 1] > nd) { d[i + 1] = nd; q.push(i + 1); }
            }
            return d;
        });

        // Reused across the millions of calls below rather than reallocated.
        this._scoreBlocks = new Int32Array(64);
        this._scoreUsedB = new Uint8Array(64);
        this._scoreUsedT = new Uint8Array(this.targetCells.length);
    }

    // How promising a position looks. Not admissible and not used by any exact
    // search - beam search only needs an ordering, not a bound.
    //
    // Greedily matches each block to a distinct target and sums the distances.
    // The distinctness is the whole point: scoring by "distance to the nearest
    // target" lets every block claim the same target, reads a pile of blocks on
    // one square as nearly solved, and steers the beam straight into that trap.
    // Measured on the 16-block board, this pays for its ~250 extra operations
    // many times over - it beat the nearest-target score running at fifty times
    // the beam width.
    beamScore(lo, hi) {
        const blocks = this._scoreBlocks;
        let n = 0;
        let x = lo;
        while (x !== 0) { blocks[n++] = 31 - Math.clz32(x & -x); x &= x - 1; }
        x = hi;
        while (x !== 0) { blocks[n++] = 32 + (31 - Math.clz32(x & -x)); x &= x - 1; }

        const distTo = this.distTo, m = distTo.length;
        if (n === 0 || m === 0) return 0;

        // The greedy is O(pairs * n * m). Daily puzzles top out around 16 blocks;
        // a hand-drawn board can be far denser, where that cost would starve the
        // search of states. Fall back to the cheaper target-centric sum there.
        if (n * m > 400) {
            let total = 0;
            for (let j = 0; j < m; ++j) {
                const dt = distTo[j];
                let best = INF;
                for (let i = 0; i < n; ++i) { const d = dt[blocks[i]]; if (d < best) best = d; }
                total += best >= INF ? 64 : best;
            }
            return total;
        }

        const usedB = this._scoreUsedB, usedT = this._scoreUsedT;
        usedB.fill(0, 0, n); usedT.fill(0, 0, m);

        let total = 0;
        const pairs = n < m ? n : m;
        for (let k = 0; k < pairs; ++k) {
            let bestD = INF, bi = -1, tj = -1;
            for (let j = 0; j < m; ++j) {
                if (usedT[j]) continue;
                const dt = distTo[j];
                for (let i = 0; i < n; ++i) {
                    if (usedB[i]) continue;
                    const d = dt[blocks[i]];
                    if (d < bestD) { bestD = d; bi = i; tj = j; }
                }
            }
            if (bi < 0) break;
            usedB[bi] = 1; usedT[tj] = 1;
            // Unreachable pairings still have to cost more than any real one.
            total += bestD >= INF ? 64 : bestD;
        }
        return total;
    }

    // Breadth-first, but only the `width` most promising positions survive each
    // level. That forfeits any optimality guarantee - the answer can be longer
    // than the true minimum - in exchange for reaching depths the exact search
    // cannot: the frontier stays flat instead of multiplying by ~3 per level.
    //
    // Used only when the exact search has already given up, so a longer solution
    // is being compared against no solution at all.
    // `randomFraction` of each level's survivors are drawn at random from the
    // positions that missed the score cut, rather than taken in score order.
    // Pure greedy selection collapses the beam: every survivor ends up a near
    // duplicate of the same few ancestors, and the whole level walks into the
    // same dead end together. Measured on the 16-block board at width 5000,
    // keeping half at random moved the average result from 39 steps to 36.8 and
    // the best from 39 to 34 (par is 33); a quarter at random changed nothing,
    // so the perturbation has to be substantial to escape.
    //
    // `seed` keeps it reproducible: the same board and seed always give the same
    // answer, and the caller varies the seed across rounds to sample more of the
    // distribution rather than to gamble.
    beamSearch({ width, deadline, maxStates, randomFraction = 0.5, seed = 1, onProgress = null }) {
        if (this.START_LO === this.TARGET_LO && this.START_HI === this.TARGET_HI) {
            return { status: 'solved', path: [], states: [this.start_state] };
        }
        this.ensureTargetDistances();

        // Same reduction the exact search uses. The beam is where hard boards
        // get their answer, and it was the one engine still exploring every
        // mirror image separately - on a board with both mirrors that is four
        // times the work for the same set of distinct positions.
        const useSym = this.useSymmetry;

        const T = new StateTable(maxStates);
        let rootLo = this.START_LO, rootHi = this.START_HI;
        if (useSym) { this.canonLoHi(rootLo, rootHi); rootLo = this._cLo; rootHi = this._cHi; }
        let frontier = [T.add(rootLo, rootHi, -1, 255, 0)];

        // Scores are small integers, so selecting the best `width` is a counting
        // sort rather than an O(n log n) sort of up to 4*width candidates.
        const SCORE_CAP = 4096;
        const counts = new Int32Array(SCORE_CAP + 1);

        // Seeded so a board always solves the same way; Math.random would make
        // the same puzzle give a different answer on every click.
        let rngState = (seed >>> 0) || 1;
        const rand = () => {
            rngState = (Math.imul(rngState, 1103515245) + 12345) >>> 0;
            return rngState / 4294967296;
        };

        for (let depth = 1; depth <= 200; ++depth) {
            if (performance.now() > deadline) return { status: 'timeout' };
            if (T.size > maxStates) return { status: 'timeout', reason: 'memory' };
            if (onProgress) onProgress(T.size);

            const slots = [], scores = [];
            for (let f = 0; f < frontier.length; ++f) {
                const slot = frontier[f];
                const sLo = T.entryLo[slot] >>> 0, sHi = T.entryHi[slot] >>> 0;
                for (let dir = 0; dir < 4; ++dir) {
                    this.moveLoHi(sLo, sHi, dir);
                    let lo = this._mvLo, hi = this._mvHi;
                    if (lo === sLo && hi === sHi) continue;
                    if (useSym) { this.canonLoHi(lo, hi); lo = this._cLo; hi = this._cHi; }

                    // The table dedupes globally, so no position is ever expanded
                    // twice and the search cannot cycle.
                    const added = T.add(lo, hi, slot, dir, depth & 255);
                    if (added === -1) continue;
                    if (lo === this.TARGET_LO && hi === this.TARGET_HI) {
                        return this.reconstructFromTable(T, added);
                    }
                    let s = this.beamScore(lo, hi);
                    if (s > SCORE_CAP) s = SCORE_CAP;
                    slots.push(added); scores.push(s);
                }
            }
            if (slots.length === 0) return { status: 'exhausted' };

            if (slots.length <= width) {
                frontier = slots;
                continue;
            }

            const nRandom = Math.min(Math.floor(width * randomFraction), slots.length - width);
            const nTop = width - nRandom;

            counts.fill(0);
            for (let i = 0; i < scores.length; ++i) counts[scores[i]]++;
            // Walk scores upward until `nTop` positions have been claimed.
            let cutoff = 0, taken = 0;
            while (cutoff <= SCORE_CAP && taken + counts[cutoff] <= nTop) {
                taken += counts[cutoff]; cutoff++;
            }
            let spare = nTop - taken;   // partial room at the cutoff score

            // Reservoir sampling over the ones that missed the cut, so the pool
            // never has to be materialised.
            const next = [];
            const reservoir = [];
            let poolSeen = 0;
            for (let i = 0; i < slots.length; ++i) {
                const s = scores[i];
                if (s < cutoff) { next.push(slots[i]); continue; }
                if (s === cutoff && spare > 0) { next.push(slots[i]); spare--; continue; }
                if (nRandom === 0) continue;
                poolSeen++;
                if (reservoir.length < nRandom) reservoir.push(slots[i]);
                else {
                    const j = Math.floor(rand() * poolSeen);
                    if (j < nRandom) reservoir[j] = slots[i];
                }
            }
            for (let i = 0; i < reservoir.length; ++i) next.push(reservoir[i]);
            frontier = next;
        }
        return { status: 'timeout', reason: 'depth' };
    }

    // Walks StateTable parent pointers back to the start.
    // Replaying the recorded moves would be wrong once the beam collapses
    // mirrored positions - the stored states are representatives, not boards
    // the player would actually be looking at. Delegates to the same lift the
    // exact search uses.
    reconstructFromTable(T, slot) {
        const lifted = this.reconstruct(T, slot);
        if (!lifted) return { status: 'timeout' };
        return { status: 'solved', path: lifted.path, states: lifted.states };
    }

    // Single A* run. `weight` inflates the heuristic (f = g + weight*h):
    // weight === 1 is standard admissible/optimal A*; weight > 1 trades
    // solution optimality for speed (bounded-suboptimal "Weighted A*"),
    // used as a fallback when the exact search is too slow.
    runAStar({ weight, nodeLimit, deadline, upperBound = Infinity, maxStates = 2000000, onProgress = null }) {
        const useSym = this.useSymmetry;
        const T = new StateTable(maxStates);
        // Reached only after the exact search has already failed, so the board
        // is hard and the tables will be filled; paying for them now keeps the
        // deadline honest.
        T.reserve(maxStates);

        // Cost-so-far per slot. Kept apart from the table because A* revises it
        // when a cheaper route to a known state turns up, which the shared
        // table has no notion of.
        let gScore = new Int32Array(maxStates + 1);
        const ensureG = (slot) => {
            if (slot < gScore.length) return;
            const bigger = new Int32Array(Math.max(slot + 1, gScore.length * 2));
            bigger.set(gScore);
            gScore = bigger;
        };

        let sLo = this.START_LO, sHi = this.START_HI;
        if (useSym) { this.canonLoHi(sLo, sHi); sLo = this._cLo; sHi = this._cHi; }

        const start_h = this.getHeuristicLoHi(sLo, sHi);
        if (start_h === INF) return { status: 'unsolvable', nodesExplored: 0 };

        const startSlot = T.add(sLo, sHi, -1, 255, 0);
        ensureG(startSlot);
        gScore[startSlot] = 0;

        const open_list = new PriorityQueue();
        open_list.push({ slot: startSlot, g: 0, f: start_h * weight });

        let nodes_explored = 0;

        while (!open_list.isEmpty()) {
            const curr = open_list.pop();

            // Skip stale queue entries superseded by a cheaper path to the same state.
            if (curr.g > gScore[curr.slot]) continue;

            nodes_explored++;

            // Bail out before exhausting memory; a JS Map also hard-caps near 16M entries.
            if ((nodes_explored & 511) === 0) {
                // 262144 is a multiple of 512, so this rides the same check.
                if (onProgress && (nodes_explored & 262143) === 0) onProgress(nodes_explored);
                if (T.size > maxStates) {
                    return { status: 'timeout', reason: 'memory', nodesExplored: nodes_explored };
                }
                if (performance.now() > deadline) {
                    return { status: 'timeout', reason: 'time', nodesExplored: nodes_explored };
                }
            }
            if (nodes_explored > nodeLimit) {
                return { status: 'timeout', reason: 'nodes', nodesExplored: nodes_explored };
            }

            const curLo = T.entryLo[curr.slot] >>> 0, curHi = T.entryHi[curr.slot] >>> 0;
            if (curLo === this.TARGET_LO && curHi === this.TARGET_HI) {
                return { status: 'solved', table: T, slot: curr.slot, nodesExplored: nodes_explored };
            }

            for (let dir = 0; dir < 4; ++dir) {
                this.moveLoHi(curLo, curHi, dir);
                let lo = this._mvLo, hi = this._mvHi;
                if (lo === curLo && hi === curHi) continue;
                if (useSym) { this.canonLoHi(lo, hi); lo = this._cLo; hi = this._cHi; }

                const next_g = curr.g + 1;
                const existing = T.find(lo, hi);
                if (existing !== -1 && gScore[existing] <= next_g) continue;

                const h = this.getHeuristicLoHi(lo, hi);
                if (h === INF) continue;
                // h is admissible, so this node can never beat a known solution.
                if (next_g + h >= upperBound) continue;

                let slot = existing;
                if (slot === -1) {
                    slot = T.add(lo, hi, curr.slot, dir, next_g & 255);
                } else {
                    // Cheaper route found: repoint the parent so reconstruction
                    // follows it.
                    T.entryParent[slot] = curr.slot;
                    T.entryMove[slot] = dir;
                }
                ensureG(slot);
                gScore[slot] = next_g;
                open_list.push({ slot, g: next_g, f: next_g + weight * h });
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
            beamWidth = 0,
            onProgress = null,
            onBest = null,
            onPhase = null
        } = options;

        const overallStart = performance.now();
        // Thorough passes Infinity: search until the state cap is reached rather
        // than stopping on a clock. Every deadline below has to stay Infinity in
        // that case - a NaN deadline compares false against everything, which
        // would silently disable the limit checks instead of removing them.
        const untimed = !isFinite(totalTimeBudgetMs);

        // The exact search gets the whole budget. An earlier version carved 40%
        // of it out for the beam up front, which weakened the exact search
        // before it had failed at anything: on 20260613 at the 20s budget that
        // turned a proven-optimal 36 steps into no answer at all, because the
        // shortened exact pass could not finish and the beam could not crack
        // that board either. The beam is a fallback, so it is paid for only
        // once there is something to fall back from.
        const exactBudgetMs = totalTimeBudgetMs;
        const endTime = untimed ? Infinity : overallStart + exactBudgetMs;
        let nodesExplored = 0;
        // Every phase can improve on the last, so the caller is told as soon as
        // an answer exists rather than only at the end. That is what makes the
        // search interruptible: cancelling keeps whatever was reported, instead
        // of throwing away minutes of work.
        let best = null;
        const recordBest = (candidate) => {
            if (!candidate) return;
            if (best && candidate.path.length >= best.path.length) return;
            best = candidate;
            if (onBest) onBest({ path: best.path, states: best.states });
        };
        let lastReason = 'time';

        // Both engines now pack states into the same typed arrays, so the
        // fallback can use the whole budget. It used to be pinned to 2M because
        // it kept BigInt-keyed nodes in a Map at ~200 bytes each; the open list
        // still costs more per state than plain BFS, so leave it some headroom.
        const fallbackMaxStates = Math.floor(maxStates * 0.75);

        // Which engine is working. The exact pass can run for minutes on a hard
        // board without producing anything to show, and silence is hard to tell
        // apart from a hang - naming the phase at least says what the wait buys.
        const announce = (phase) => { if (onPhase) onPhase(phase); };

        announce('exact');
        // Bidirectional BFS first: it returns a proven-optimal answer and is
        // usually far faster, especially on the boards where the heuristic is
        // blind. Give it most of the budget; if it can't finish, the weighted
        // A* passes below still have time to produce an approximate answer.
        const bidi = this.solveBidirectional({
            maxStates,
            deadline: untimed ? Infinity : overallStart + exactBudgetMs * 0.7,
            onProgress
        });
        if (bidi.status === 'solved' && bidi.optimal) {
            return {
                success: true,
                optimal: true,
                message: `Optimal solution in ${plural(bidi.path.length, 'step')}`,
                path: bidi.path,
                states: bidi.states
            };
        }
        if (bidi.status === 'unsolvable') {
            return { success: false, message: "No solution exists for this board.", path: [], states: [] };
        }
        // Timed out: keep any partial answer as the baseline to beat.
        if (bidi.status === 'solved') recordBest({ path: bidi.path, states: bidi.states });

        // A* gets a fixed share, not whatever the exact search left behind.
        //
        // Letting it inherit the remainder meant that when the bidirectional
        // search bailed early on memory - 18s into a 42s slot on the 16-block
        // board - A* took the other 42s and found nothing, pushing the whole
        // solve past the time the interface had promised. Across the 35 real
        // levels the ladder changes the answer on exactly one (20260614, 24
        // steps instead of 28), so it is worth keeping but not worth an open
        // budget.
        //
        // Untimed runs cap it at whatever the primary search already spent:
        // the weaker engine should never outlast the stronger one.
        const fallbackEnd = untimed
            ? performance.now() + (performance.now() - overallStart)
            : Math.min(endTime, performance.now() + totalTimeBudgetMs * 0.3);

        if (fallbackEnd > performance.now()) announce('refine');
        for (let i = 0; i < weights.length; ++i) {
            const remaining = fallbackEnd - performance.now();
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
                        message: `Optimal solution in ${plural(best.path.length, 'step')}`,
                        path: best.path,
                        states: best.states
                    };
                }
                return { success: false, message: "No solution exists for this board.", path: [], states: [] };
            }

            if (result.status === 'solved') {
                const lifted = this.reconstruct(result.table, result.slot);
                if (!lifted) break;   // bookkeeping failed; keep whatever is in hand
                const { path, states } = lifted;
                recordBest({ path, states });
                if (weight === 1) {
                    return {
                        success: true,
                        optimal: true,
                        message: `Optimal solution in ${plural(path.length, 'step')}`,
                        path,
                        states
                    };
                }
            }
        }

        // Last resort: give up on proving anything and just look for a solution.
        // Runs even when `best` already holds one, since the beam routinely
        // reaches goals the weighted passes never got near.
        //
        // Two phases, both keeping only the shortest answer seen.
        //
        // First the width escalates from a small opening pass. Cost scales with
        // width, so a run costs about as much as everything before it combined:
        // securing a rough answer early is nearly free, whereas opening at the
        // maximum width risks a single pass too large for the budget, which
        // returns nothing at all.
        //
        // Once the width cap is reached the rounds repeat at that width with a
        // fresh seed. Beyond a few tens of thousands the width stops mattering,
        // while the random survivors make each round an independent sample:
        // eight seeds at one width on the 16-block board spanned 34-40 steps,
        // and on another spanned 24-27. Drawing again is worth more than
        // widening, so extra budget buys samples rather than beam.
        if (beamWidth > 0) {
            announce('fallback');
            // Extra time on top of the budget, not a slice of it. Reaching here
            // means the exact search already spent everything and came back
            // empty-handed, so the choice is a longer wait or no answer.
            const beamDeadline = untimed
                ? Infinity
                : performance.now() + totalTimeBudgetMs * BEAM_TIME_SHARE;
            // Starts small enough that even the shortest reserve (Fast reserves
            // ~1.2s) completes a full pass; scoring is expensive enough that a
            // wider opening round returned nothing at all on that budget.
            // min() so a beamWidth below the opening width still runs a pass
            // rather than skipping the loop entirely.
            let width = Math.min(500, beamWidth);
            let round = 0;
            let sinceGain = 0;   // rounds since the answer last got shorter
            // Results at a fixed width scatter by several steps between seeds,
            // so a couple of flat rounds does not mean the well is dry. Thorough
            // has no clock to respect, so it keeps drawing for longer.
            const stallLimit = untimed ? 5 : 3;
            while (width <= beamWidth) {
                const roundStart = performance.now();
                if (roundStart >= beamDeadline) break;

                const beam = this.beamSearch({
                    width,
                    maxStates,
                    deadline: beamDeadline,
                    // Random survivors make each round an independent sample, so
                    // rounds differ by more than width alone and the best of
                    // them is kept below.
                    seed: ++round,
                    onProgress: onProgress ? (n) => onProgress(nodesExplored + n) : null
                });
                const before = best;
                if (beam.status === 'solved') recordBest({ path: beam.path, states: beam.states });
                if (best !== before) sinceGain = 0; else sinceGain++;
                // Nothing left to widen into: the whole reachable space was seen.
                if (beam.status === 'exhausted') break;

                // Cost grows about linearly with width, so size the next round
                // from what this one actually took. Jumping a fixed 4x either
                // overshot the reserve and wasted the round, or stopped early
                // and left time unused.
                const spent = Math.max(1, performance.now() - roundStart);
                const affordable = Math.floor((beamDeadline - performance.now()) / spent);
                if (affordable < 2) break;

                if (width < beamWidth) {
                    const wider = Math.min(beamWidth, width * Math.min(4, affordable));
                    // Widening rounds are narrow and routinely lose to whatever
                    // the exact search already found, so they run the stall
                    // counter up before sampling has drawn anything. Reset on
                    // the way in, or the loop exits at the cap having taken
                    // exactly one sample - which is how a reachable shorter
                    // answer went unseen.
                    if (wider >= beamWidth) sinceGain = 0;
                    width = wider;
                } else if (round >= MAX_BEAM_ROUNDS || sinceGain >= stallLimit) {
                    // Re-sampling has stopped paying. With an unlimited budget
                    // this is what ends the loop; the round cap is the backstop.
                    break;
                }
            }
        }

        if (best) {
            return {
                success: true,
                optimal: false,
                message: `Found a ${best.path.length}-step solution (not proven shortest)`,
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
        // The only lever the user still has.
        const advice = 'Try a higher search strength.';
        return {
            success: false,
            exhausted: false,
            message: `Gave up: ${limitHint} (about ${nodesExplored} nodes). A solution may still exist. ${advice}`,
            path: [],
            states: []
        };
    }
}