// Fetches daily puzzles from kestopuzzle.com on demand.
//
// Nothing is downloaded in bulk or stored: each request is made by the visitor's
// own browser, the same call the game itself makes. The API sends
// `access-control-allow-origin: *` and needs no auth, so this works from a
// static host such as GitHub Pages.
//
// Wire format (confirmed against the site's own decoder):
//   base64url -> 24 bytes = three 64-bit bitboards, big-endian
//   bytes 0-7 walls, 8-15 boxes, 16-23 goals; bit index = row * 8 + col

const KESTO_API_BASE = 'https://kestopuzzle.com/api/puzzles';
const KESTO_FIRST_LEVEL = '20260523';

function kestoDecodeBase64(str) {
    // The API uses URL-safe base64: real payloads contain '-' and '_'.
    const normalized = str.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; ++i) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function kestoPopcount(bb) {
    let n = 0;
    while (bb) { bb &= bb - 1n; n++; }
    return n;
}

// Reads 8 bytes big-endian into a 64-bit bitboard, matching the site's `od()`.
function kestoReadBoard(bytes, offset) {
    let board = 0n;
    for (let i = 0; i < 8; ++i) board = (board << 8n) | BigInt(bytes[offset + i]);
    return board;
}

function decodeKestoPuzzle(puzzleStr) {
    const bytes = kestoDecodeBase64(puzzleStr);
    if (bytes.length !== 24) {
        throw new Error(`Unexpected puzzle size (${bytes.length} bytes, expected 24).`);
    }
    const walls = kestoReadBoard(bytes, 0);
    const boxes = kestoReadBoard(bytes, 8);
    const goals = kestoReadBoard(bytes, 16);

    // The solver finishes on `state === TARGET`, so a mismatched count could
    // never terminate. Fail loudly here rather than search forever.
    const boxCount = kestoPopcount(boxes);
    const goalCount = kestoPopcount(goals);
    if (boxCount !== goalCount) {
        throw new Error(`Puzzle has ${boxCount} blocks but ${goalCount} targets.`);
    }
    if ((boxes & walls) !== 0n) {
        throw new Error('Puzzle has a block sitting inside a wall.');
    }
    return { walls, boxes, goals, boxCount };
}

// Converts bitboards into the 8x8 character grids app.js works with.
function puzzleToGrids({ walls, boxes, goals }) {
    const bgGrid = Array(8).fill().map(() => Array(8).fill('.'));
    const fgGrid = Array(8).fill().map(() => Array(8).fill('.'));
    for (let r = 0; r < 8; ++r) {
        for (let c = 0; c < 8; ++c) {
            const bit = 1n << BigInt(r * 8 + c);
            if (walls & bit) bgGrid[r][c] = '#';
            else if (goals & bit) bgGrid[r][c] = 'T';
            if (boxes & bit) fgGrid[r][c] = 'Y';
        }
    }
    return { bgGrid, fgGrid };
}

// --- YYYYMMDD helpers (treated as plain calendar labels, not timestamps) ---

function kestoDateToId(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}${m}${d}`;
}

function kestoIdToDate(id) {
    return new Date(Number(id.slice(0, 4)), Number(id.slice(4, 6)) - 1, Number(id.slice(6, 8)));
}

function kestoIdToInputValue(id) {
    return `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}`;
}

function kestoInputValueToId(value) {
    return value.replace(/-/g, '');
}

function kestoShiftId(id, days) {
    const d = kestoIdToDate(id);
    d.setDate(d.getDate() + days);
    return kestoDateToId(d);
}

function kestoTodayId() {
    return kestoDateToId(new Date());
}

async function fetchKestoPuzzle(dateId) {
    if (!/^\d{8}$/.test(dateId)) throw new Error('Pick a date first.');

    let response;
    try {
        response = await fetch(`${KESTO_API_BASE}/${dateId}`);
    } catch (err) {
        // Network failure, offline, or a blocked cross-origin request.
        throw new Error('Could not reach kestopuzzle.com. Check your connection.');
    }

    if (!response.ok) {
        let apiError = '';
        try { apiError = (await response.json()).error || ''; } catch (e) { /* non-JSON body */ }

        if (response.status === 404) {
            // The API distinguishes "too early" from "not published yet".
            if (/not available yet/i.test(apiError)) {
                throw new Error("That day's puzzle isn't out yet - try the previous day.");
            }
            throw new Error(`No puzzle for that date (the first one is ${KESTO_FIRST_LEVEL}).`);
        }
        throw new Error(`kestopuzzle.com returned ${response.status}.`);
    }

    const data = await response.json();
    if (!data || typeof data.puzzle !== 'string') {
        throw new Error('Unexpected response from kestopuzzle.com.');
    }

    const decoded = decodeKestoPuzzle(data.puzzle);
    const { bgGrid, fgGrid } = puzzleToGrids(decoded);
    return {
        id: data.id || dateId,
        stars: Array.isArray(data.stars) ? data.stars : [],
        boxCount: decoded.boxCount,
        bgGrid,
        fgGrid
    };
}
