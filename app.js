document.addEventListener('DOMContentLoaded', () => {
    const gridEl = document.getElementById('grid');
    const toolBtns = document.querySelectorAll('.tool-btn');
    const btnClear = document.getElementById('btn-clear');
    const btnSolve = document.getElementById('btn-solve');
    const btnCancel = document.getElementById('btn-cancel');
    const solverMessage = document.getElementById('solver-message');

    // Modes
    const MODES = ['edit', 'play', 'solve'];
    const modeTabs = document.querySelectorAll('.mode-tab');
    const modePanels = document.querySelectorAll('.mode-panel');
    let currentMode = 'edit';

    // Play mode
    const playMoveCount = document.getElementById('play-move-count');
    const playPar = document.getElementById('play-par');
    const playMessage = document.getElementById('play-message');
    const dpadBtns = document.querySelectorAll('.dpad-btn');
    const btnUndo = document.getElementById('btn-undo');
    const btnReplay = document.getElementById('btn-replay');
    let playBlocks = [];      // identity-stable list, index i owns entity i
    let playHistory = [];     // snapshots for undo
    let currentPar = null;    // par from the daily puzzle, null once hand-edited
    
    // Playback Controls
    const solutionControls = document.getElementById('solution-controls');
    const stepCurrentEl = document.getElementById('current-step');
    const stepTotalEl = document.getElementById('total-steps');
    const pathDisplay = document.getElementById('path-display');
    const btnPrev = document.getElementById('btn-prev');
    const btnNext = document.getElementById('btn-next');
    const btnPlay = document.getElementById('btn-play');
    const progressFill = document.getElementById('progress-fill');
    let moveChips = [];
    let autoplayTimer = null;
    const strengthBtns = document.querySelectorAll('.strength-btn');

    // Daily puzzle picker
    const puzzleDateInput = document.getElementById('puzzle-date');
    const puzzleMessage = document.getElementById('puzzle-message');
    const puzzleBadge = document.getElementById('puzzle-badge');
    const btnLoadPuzzle = document.getElementById('btn-load-puzzle');
    const btnDayPrev = document.getElementById('btn-day-prev');
    const btnDayNext = document.getElementById('btn-day-next');

    // Search strength presets: higher budgets explore more of the state space,
    // so they are likelier to find a solution and prove it optimal.
    // The bidirectional search packs states into typed arrays at roughly
    // 15-30 bytes each, so these caps are far higher than the old Map-based
    // ones; thorough peaks near 1GB.
    const STRENGTH_PRESETS = {
        fast:     { totalTimeBudgetMs: 3000,  maxStates: 3000000 },
        balanced: { totalTimeBudgetMs: 20000, maxStates: 12000000 },
        thorough: { totalTimeBudgetMs: 90000, maxStates: 30000000 }
    };
    let currentStrength = localStorage.getItem('kestoStrength') || 'balanced';
    if (!STRENGTH_PRESETS[currentStrength]) currentStrength = 'balanced';

    function syncStrengthButtons() {
        strengthBtns.forEach(b => {
            b.classList.toggle('active', b.dataset.strength === currentStrength);
        });
    }
    syncStrengthButtons();

    strengthBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            currentStrength = btn.dataset.strength;
            localStorage.setItem('kestoStrength', currentStrength);
            syncStrengthButtons();
        });
    });

    let bgGrid = Array(8).fill().map(() => Array(8).fill('.'));
    let fgGrid = Array(8).fill().map(() => Array(8).fill('.'));
    let cells = []; // 2D array of DOM elements
    // Must match the .tool-btn marked active in the markup; reading this before
    // any tool was clicked previously threw a ReferenceError.
    let currentTool = '.';
    
    // Default puzzle from original C++ code
    const defaultGrid = [
        "........",
        "........",
        "........",
        "........",
        "........",
        "........",
        "........",
        "........"
    ];

    function saveGrid() {
        localStorage.setItem('kestoBgGrid', JSON.stringify(bgGrid));
        localStorage.setItem('kestoFgGrid', JSON.stringify(fgGrid));
    }

    function loadGrid() {
        const savedBg = localStorage.getItem('kestoBgGrid');
        const savedFg = localStorage.getItem('kestoFgGrid');
        if (savedBg && savedFg) {
            try {
                bgGrid = JSON.parse(savedBg);
                fgGrid = JSON.parse(savedFg);
                return true;
            } catch(e) {
                console.error("Failed to load grid from localStorage", e);
            }
        }
        return false;
    }

    let isDrawing = false;
    let blockEntities = []; // Array of DOM elements for moving blocks

    let playbackStates = [];
    let playbackPath = [];
    let playbackIdentities = [];
    let currentStep = 0;

    function initGrid() {
        gridEl.innerHTML = '';
        cells = [];
        
        const hasSaved = loadGrid();

        for (let r = 0; r < 8; r++) {
            cells[r] = [];
            for (let c = 0; c < 8; c++) {
                const cell = document.createElement('div');
                cell.className = 'cell';
                cell.dataset.r = r;
                cell.dataset.c = c;
                
                if (!hasSaved) {
                    // Load default
                    const char = defaultGrid[r][c];
                    if (char === '#' || char === 'T') {
                        bgGrid[r][c] = char;
                    } else if (char === 'Y') {
                        fgGrid[r][c] = 'Y';
                    }
                }
                updateCellClass(cell, r, c);

                // Events for drawing
                cell.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    if (currentMode !== 'edit') return;
                    isDrawing = true;
                    applyTool(r, c);
                });
                cell.addEventListener('mouseenter', (e) => {
                    if (isDrawing && currentMode === 'edit') {
                        e.preventDefault();
                        applyTool(r, c);
                    }
                });

                gridEl.appendChild(cell);
                cells[r][c] = cell;
            }
        }
        
        // Remove old block entities
        clearBlockEntities();
        
        // We only render .block-entity if we are playing back.
        // During editing, blocks are rendered as cell backgrounds to make it simpler.
    }

    function updateCellClass(cell, r, c) {
        cell.className = 'cell';
        if (bgGrid[r][c] === '#') cell.classList.add('wall');
        if (bgGrid[r][c] === 'T') cell.classList.add('target');
        if (fgGrid[r][c] === 'Y') cell.classList.add('block');
    }

    function restoreGridVisuals() {
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                updateCellClass(cells[r][c], r, c);
            }
        }
    }

    function clearBlockEntities() {
        blockEntities.forEach(el => el.remove());
        blockEntities = [];
    }

    function applyTool(r, c) {
        discardSolution();
        // Kesto's par belongs to Kesto's board, not to whatever this becomes.
        currentPar = null;
        solverMessage.textContent = "Board modified. Ready to solve.";
        solverMessage.style.color = "var(--text-secondary)";
        clearBlockEntities();
        restoreGridVisuals();
        
        if (currentTool === '.') {
            bgGrid[r][c] = '.';
            fgGrid[r][c] = '.';
        } else if (currentTool === '#' || currentTool === 'T') {
            bgGrid[r][c] = currentTool;
            if (currentTool === '#') fgGrid[r][c] = '.';
        } else if (currentTool === 'Y') {
            fgGrid[r][c] = 'Y';
            if (bgGrid[r][c] === '#') bgGrid[r][c] = '.';
        }
        
        updateCellClass(cells[r][c], r, c);
        saveGrid();
    }

    document.addEventListener('mouseup', () => {
        isDrawing = false;
    });

    // Tool Selection
    toolBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            toolBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentTool = btn.dataset.tool;
        });
    });

    // Clear Board
    btnClear.addEventListener('click', () => {
        discardSolution();
        clearBlockEntities();
        solverMessage.textContent = "Board cleared.";
        solverMessage.style.color = "var(--text-secondary)";
        // The board is no longer that day's puzzle, so drop the id badge.
        puzzleBadge.classList.add('hidden');
        currentPar = null;

        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                bgGrid[r][c] = '.';
                fgGrid[r][c] = '.';
                updateCellClass(cells[r][c], r, c);
            }
        }
        saveGrid();
    });

    // --- Solving ---

    let activeWorker = null;

    // Chrome forbids constructing a Worker from a file:// page (origin "null"),
    // so keep the synchronous main-thread path as a fallback. Over http(s),
    // including GitHub Pages, the worker path is used.
    function createWorker() {
        try {
            return new Worker('solver.worker.js?v=13');
        } catch (err) {
            console.warn('Web Worker unavailable, solving on the main thread:', err);
            return null;
        }
    }

    function setSolvingUI(isSolving) {
        btnSolve.classList.toggle('hidden', isSolving);
        btnCancel.classList.toggle('hidden', !isSolving || !activeWorker);
    }

    function showResult(result) {
        if (result.success) {
            solverMessage.textContent = result.message;
            solverMessage.style.color = result.optimal === false ? "#ffb84d" : "#00ff88";

            playbackStates = result.states;
            playbackPath = result.path;

            if (result.path.length > 0) {
                buildPathChips(result.path);
                solutionControls.classList.remove('hidden');
                stepTotalEl.textContent = result.path.length;
                currentStep = 0;
                computeBlockIdentities();
                renderStep(0);
            } else {
                // Already solved
                discardSolution();
            }
        } else {
            solverMessage.textContent = result.message || "No solution found.";
            solverMessage.style.color = "#ff2a6d";
            discardSolution();
            clearBlockEntities();
            restoreGridVisuals();
        }
    }

    function showFailure(text) {
        solverMessage.textContent = text;
        solverMessage.style.color = "#ff2a6d";
        discardSolution();
    }

    btnSolve.addEventListener('click', () => {
        const options = STRENGTH_PRESETS[currentStrength];
        const budgetSec = Math.round(options.totalTimeBudgetMs / 1000);
        solverMessage.style.color = "var(--text-primary)";
        discardSolution();

        activeWorker = createWorker();
        setSolvingUI(true);

        if (activeWorker) {
            solverMessage.textContent = `Solving... up to ${budgetSec}s.`;
            activeWorker.onmessage = (e) => {
                const msg = e.data;
                if (msg.type === 'progress') {
                    const millions = (msg.nodes / 1e6).toFixed(1);
                    solverMessage.textContent = `Solving... ${millions}M states, up to ${budgetSec}s.`;
                    return;
                }
                activeWorker.terminate();
                activeWorker = null;
                setSolvingUI(false);
                if (msg.type === 'done') showResult(msg.result);
                else showFailure('Solver error: ' + msg.message);
            };
            // Fires on an uncaught worker error, including running out of memory.
            activeWorker.onerror = (err) => {
                console.error(err);
                if (activeWorker) { activeWorker.terminate(); activeWorker = null; }
                setSolvingUI(false);
                showFailure('The solver ran out of memory. Try a lower search strength.');
            };
            activeWorker.postMessage({ bgGrid, fgGrid, options });
            return;
        }

        // Fallback: blocks the page, so warn and let the browser paint first.
        solverMessage.textContent = `Solving... up to ${budgetSec}s, the page may freeze.`;
        setTimeout(() => {
            // Reset buttons before rendering, since showResult/showFailure decide
            // the final Solve/Edit visibility themselves.
            setSolvingUI(false);
            try {
                showResult(new Solver(bgGrid, fgGrid).solve(options));
            } catch (err) {
                console.error(err);
                showFailure('An error occurred during solving.');
            }
        }, 50);
    });

    btnCancel.addEventListener('click', () => {
        if (!activeWorker) return;
        activeWorker.terminate(); // hard-stops the synchronous search inside the worker
        activeWorker = null;
        setSolvingUI(false);
        solverMessage.textContent = "Search cancelled.";
        solverMessage.style.color = "var(--text-secondary)";
    });

    // --- Daily puzzle loading ---

    function setPuzzleMessage(text, color) {
        puzzleMessage.textContent = text;
        puzzleMessage.style.color = color || "var(--text-secondary)";
    }

    function clampPuzzleId(id) {
        const today = kestoTodayId();
        if (id < KESTO_FIRST_LEVEL) return KESTO_FIRST_LEVEL;
        if (id > today) return today;
        return id;
    }

    function currentPuzzleId() {
        const raw = kestoInputValueToId(puzzleDateInput.value || '');
        return /^\d{8}$/.test(raw) ? raw : kestoTodayId();
    }

    // Replaces the board contents, resetting anything tied to the old board.
    function loadPuzzleIntoBoard(newBg, newFg) {
        if (activeWorker) {
            activeWorker.terminate();
            activeWorker = null;
        }
        setSolvingUI(false);

        bgGrid = newBg;
        fgGrid = newFg;

        discardSolution();
        playbackStates = [];
        playbackPath = [];
        playbackIdentities = [];
        currentStep = 0;

        clearBlockEntities();
        restoreGridVisuals();
        saveGrid();

        // A half-played attempt belongs to the board that just went away.
        if (currentMode === 'play') startPlay();

        solverMessage.textContent = "Puzzle loaded. Ready to solve.";
        solverMessage.style.color = "var(--text-secondary)";
    }

    async function loadPuzzleForDate(dateId) {
        const id = clampPuzzleId(dateId);
        puzzleDateInput.value = kestoIdToInputValue(id);

        btnLoadPuzzle.disabled = true;
        setPuzzleMessage(`Loading ${id}...`);
        try {
            const puzzle = await fetchKestoPuzzle(id);
            const par = puzzle.stars && puzzle.stars.length ? puzzle.stars[0] : null;
            // Set before loading, so the Play panel picks it up when
            // loadPuzzleIntoBoard restarts the attempt.
            currentPar = par;
            loadPuzzleIntoBoard(puzzle.bgGrid, puzzle.fgGrid);

            let note = `Loaded ${puzzle.id}`;
            if (par !== null) note += ` - par ${par} moves`;
            note += ` (${puzzle.boxCount} blocks).`;
            // Big boards blow past the search limits; warn before they wait.
            if (puzzle.boxCount > 12) {
                note += ' This one is large - the solver may not crack it even on Thorough.';
            }
            setPuzzleMessage(note, "#00ff88");
            puzzleBadge.textContent = `#${puzzle.id}`;
            puzzleBadge.classList.remove('hidden');
        } catch (err) {
            setPuzzleMessage(err.message, "#ff2a6d");
        } finally {
            btnLoadPuzzle.disabled = false;
        }
    }

    btnLoadPuzzle.addEventListener('click', () => loadPuzzleForDate(currentPuzzleId()));
    btnDayPrev.addEventListener('click', () => loadPuzzleForDate(kestoShiftId(currentPuzzleId(), -1)));
    btnDayNext.addEventListener('click', () => loadPuzzleForDate(kestoShiftId(currentPuzzleId(), 1)));

    // Default to today, but don't fetch until asked.
    puzzleDateInput.max = kestoIdToInputValue(kestoTodayId());
    puzzleDateInput.value = kestoIdToInputValue(kestoTodayId());

    // --- Playback Logic ---

    function getBlocksFromState(stateBigInt) {
        let blocks = [];
        let temp = stateBigInt;
        while (temp > 0n) {
            let idx = 0n;
            let temp2 = temp;
            if (temp2 === 0n) idx = 64n;
            else {
                let count = 0n;
                while ((temp2 & 1n) === 0n) {
                    count++;
                    temp2 >>= 1n;
                }
                idx = count;
            }
            
            blocks.push({
                r: Number(idx) / 8 | 0,
                c: Number(idx) % 8
            });
            temp &= (temp - 1n);
        }
        return blocks;
    }

    function computeBlockIdentities() {
        playbackIdentities = [];
        if (playbackStates.length === 0) return;
        
        let initialBlocks = getBlocksFromState(playbackStates[0]);
        initialBlocks.sort((a, b) => a.r !== b.r ? a.r - b.r : a.c - b.c);
        playbackIdentities.push(initialBlocks);

        for (let i = 1; i < playbackStates.length; i++) {
            let dir = playbackPath[i - 1];
            let prevBlocks = playbackIdentities[i - 1].map((pos, id) => ({ r: pos.r, c: pos.c, id: id }));
            
            let sortFn;
            if (dir === 'U' || dir === 'D') {
                sortFn = (a, b) => a.c !== b.c ? a.c - b.c : a.r - b.r;
            } else {
                sortFn = (a, b) => a.r !== b.r ? a.r - b.r : a.c - b.c;
            }

            prevBlocks.sort(sortFn);
            
            let currBlocks = getBlocksFromState(playbackStates[i]);
            currBlocks.sort(sortFn);
            
            let nextIdentities = new Array(initialBlocks.length);
            for (let j = 0; j < prevBlocks.length; j++) {
                nextIdentities[prevBlocks[j].id] = currBlocks[j];
            }
            playbackIdentities.push(nextIdentities);
        }
    }

    const MOVE_ARROWS = { L: '←', R: '→', U: '↑', D: '↓' };
    const MOVE_NAMES = { L: 'Left', R: 'Right', U: 'Up', D: 'Down' };

    // One clickable chip per move. Rebuilt only when a new solution arrives;
    // stepping just restyles the existing chips.
    function buildPathChips(path) {
        pathDisplay.replaceChildren();
        moveChips = path.map((move, i) => {
            const chip = document.createElement('button');
            chip.className = 'move-chip';
            chip.title = `Move ${i + 1}: ${MOVE_NAMES[move] || move}`;

            const index = document.createElement('span');
            index.className = 'move-index';
            index.textContent = i + 1;

            const arrow = document.createElement('span');
            arrow.className = 'move-arrow';
            arrow.textContent = MOVE_ARROWS[move] || move;

            chip.append(index, arrow);
            // Move i+1 produces state i+1, so jumping to a chip means showing
            // the position just after that move.
            chip.addEventListener('click', () => {
                stopAutoplay();
                renderStep(i + 1);
            });
            pathDisplay.appendChild(chip);
            return chip;
        });
    }

    function updatePathHighlight(stepIndex) {
        moveChips.forEach((chip, i) => {
            const moveNumber = i + 1;
            chip.classList.toggle('done', moveNumber < stepIndex);
            chip.classList.toggle('current', moveNumber === stepIndex);
            chip.classList.toggle('next', moveNumber === stepIndex + 1);
        });

        // Keep the action in view once the list scrolls; 'nearest' so it never
        // drags the whole page around.
        const focus = moveChips[stepIndex === 0 ? 0 : stepIndex - 1];
        if (focus) focus.scrollIntoView({ block: 'nearest' });

        const total = moveChips.length;
        progressFill.style.width = total ? `${(stepIndex / total) * 100}%` : '0';
    }

    // Takes the panel off screen but keeps the solution, so leaving Solve mode
    // and coming back can put it right where it was. The timer has to die
    // either way, or it keeps stepping a board nobody is looking at.
    function hidePlayback() {
        stopAutoplay();
        solutionControls.classList.add('hidden');
    }

    function hasSolution() {
        return playbackPath.length > 0 && playbackIdentities.length > 0;
    }

    // For when the solution stops being true of the board: an edit, a new
    // puzzle, or the start of another search.
    function discardSolution() {
        hidePlayback();
        playbackStates = [];
        playbackPath = [];
        playbackIdentities = [];
        currentStep = 0;
        moveChips = [];
        pathDisplay.replaceChildren();
    }

    function stopAutoplay() {
        if (autoplayTimer !== null) {
            clearInterval(autoplayTimer);
            autoplayTimer = null;
        }
        btnPlay.textContent = 'Play';
    }

    function startAutoplay() {
        // Replaying from the end would otherwise sit on the last frame.
        if (currentStep >= playbackStates.length - 1) renderStep(0);
        btnPlay.textContent = 'Pause';
        autoplayTimer = setInterval(() => {
            if (currentStep >= playbackStates.length - 1) {
                stopAutoplay();
                return;
            }
            renderStep(currentStep + 1);
        }, 420);
    }

    // Hides the statically painted blocks so the animated .block-entity overlays
    // are the only blocks on screen.
    function hideStaticBlocks() {
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                if (fgGrid[r][c] === 'Y') {
                    cells[r][c].classList.remove('block');
                }
            }
        }
    }

    // Shared by solution playback and Play mode: entity i keeps following block
    // i across calls, which is what makes the CSS transition read as a slide
    // rather than a teleport.
    function positionBlockEntities(blocks) {
        while (blockEntities.length < blocks.length) {
            const el = document.createElement('div');
            el.className = 'block-entity';
            gridEl.appendChild(el);
            blockEntities.push(el);
        }
        while (blockEntities.length > blocks.length) {
            blockEntities.pop().remove();
        }

        // Measured rather than computed from cell size, so it stays correct at
        // any --cell-size the viewport lands on.
        const gridRect = gridEl.getBoundingClientRect();
        blocks.forEach((pos, i) => {
            const el = blockEntities[i];
            const cellRect = cells[pos.r][pos.c].getBoundingClientRect();

            el.style.left = (cellRect.left - gridRect.left - 1 /* border adjust */) + 'px';
            el.style.top = (cellRect.top - gridRect.top - 1 /* border adjust */) + 'px';
            el.style.width = cellRect.width + 'px';
            el.style.height = cellRect.height + 'px';
            el.classList.toggle('on-target', bgGrid[pos.r][pos.c] === 'T');
        });
    }

    // True only while the solution panel is the thing driving the board. Play
    // mode also owns block entities, so stepping must not run in the background
    // and wipe them - and with no solution loaded there is nothing to step to.
    function playbackActive() {
        return currentMode === 'solve' && !solutionControls.classList.contains('hidden');
    }

    function renderStep(stepIndex) {
        if (!playbackActive()) return;
        currentStep = stepIndex;
        stepCurrentEl.textContent = stepIndex;
        updatePathHighlight(stepIndex);
        hideStaticBlocks();
        positionBlockEntities(playbackIdentities[stepIndex] || []);
    }

    // --- Play mode ---

    // Mirrors lineStep() in solver.js. A move shifts every block one square at
    // once: the board splits into eight independent lines (rows for L/R, columns
    // for U/D) and each maximal run of blocks in a line advances only if the
    // square just past its leading block is on-board and not a wall. Diverging
    // from this would make hand-played move counts disagree with the solver.
    function applyMove(blocks, dir) {
        const isRow = dir === 'L' || dir === 'R';
        const step = (dir === 'U' || dir === 'L') ? -1 : +1;

        const occupied = new Set(blocks.map(b => b.r * 8 + b.c));
        const shifted = new Map();   // old cell index -> new cell index

        for (let line = 0; line < 8; line++) {
            const at = i => (isRow ? { r: line, c: i } : { r: i, c: line });
            const hasBlock = i => { const p = at(i); return occupied.has(p.r * 8 + p.c); };
            const isWall = i => { const p = at(i); return bgGrid[p.r][p.c] === '#'; };

            let i = 0;
            while (i < 8) {
                if (!hasBlock(i)) { i++; continue; }
                let j = i;
                while (j + 1 < 8 && hasBlock(j + 1)) j++;

                // The run's leading square in the direction of travel.
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

        if (shifted.size === 0) return null;   // move is a no-op

        // Applied against the identity-carrying list, so each block keeps its
        // entity and animates from where it was.
        return blocks.map(b => {
            const moved = shifted.get(b.r * 8 + b.c);
            return moved === undefined ? b : { r: Math.floor(moved / 8), c: moved % 8 };
        });
    }

    function blocksFromGrid() {
        const blocks = [];
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                if (fgGrid[r][c] === 'Y') blocks.push({ r, c });
            }
        }
        return blocks;
    }

    function targetCells() {
        const targets = [];
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                if (bgGrid[r][c] === 'T') targets.push(r * 8 + c);
            }
        }
        return targets;
    }

    // Matches the solver's goal test: the block set must equal the target set,
    // so a spare block sitting off-target still counts as unsolved.
    function isSolved(blocks) {
        const targets = targetCells();
        if (targets.length === 0 || targets.length !== blocks.length) return false;
        const occupied = new Set(blocks.map(b => b.r * 8 + b.c));
        return targets.every(t => occupied.has(t));
    }

    function setPlayMessage(text, color) {
        playMessage.textContent = text;
        playMessage.style.color = color || "var(--text-secondary)";
    }

    function renderPlay() {
        hideStaticBlocks();
        positionBlockEntities(playBlocks);
        playMoveCount.textContent = playHistory.length;
        btnUndo.disabled = playHistory.length === 0;
    }

    function startPlay() {
        playBlocks = blocksFromGrid();
        playHistory = [];
        playPar.textContent = currentPar !== null ? `moves · par ${currentPar}` : 'moves';

        if (playBlocks.length === 0) {
            setPlayMessage("No blocks on the board. Add some in Edit mode.", "#ffb84d");
        } else if (targetCells().length !== playBlocks.length) {
            setPlayMessage(
                `${playBlocks.length} blocks but ${targetCells().length} targets - this board cannot be solved.`,
                "#ffb84d"
            );
        } else {
            setPlayMessage("Every block moves at once. Use the arrow keys.");
        }
        renderPlay();
    }

    function doPlayMove(dir) {
        if (currentMode !== 'play' || playBlocks.length === 0) return;

        const next = applyMove(playBlocks, dir);
        if (!next) {
            setPlayMessage("Nothing can move that way.", "#ffb84d");
            return;
        }

        playHistory.push(playBlocks);
        playBlocks = next;
        renderPlay();

        if (isSolved(playBlocks)) {
            setPlayMessage(`Solved in ${playHistory.length} moves.`, "#00ff88");
        } else {
            setPlayMessage("Every block moves at once. Use the arrow keys.");
        }
    }

    function undoPlayMove() {
        if (currentMode !== 'play' || playHistory.length === 0) return;
        playBlocks = playHistory.pop();
        renderPlay();
        setPlayMessage("Every block moves at once. Use the arrow keys.");
    }

    const KEY_DIRS = {
        ArrowUp: 'U', ArrowDown: 'D', ArrowLeft: 'L', ArrowRight: 'R',
        w: 'U', s: 'D', a: 'L', d: 'R',
        W: 'U', S: 'D', A: 'L', D: 'R'
    };

    document.addEventListener('keydown', (e) => {
        if (currentMode !== 'play') return;
        // Leave typing in the date picker alone.
        if (e.target instanceof HTMLInputElement) return;
        const dir = KEY_DIRS[e.key];
        if (!dir) return;
        e.preventDefault();   // arrows would otherwise scroll the page
        doPlayMove(dir);
    });

    dpadBtns.forEach(btn => {
        btn.addEventListener('click', () => doPlayMove(btn.dataset.dir));
    });

    // These render block overlays, which only belong on the board in Play mode.
    // The panel being display:none already stops a real click, but that makes
    // correctness a property of the stylesheet; guard the handlers too.
    btnUndo.addEventListener('click', undoPlayMove);
    btnReplay.addEventListener('click', () => {
        if (currentMode !== 'play') return;
        startPlay();
        setPlayMessage("Back to the start.");
    });

    // --- Mode switching ---

    function setMode(mode, { updateUrl = true } = {}) {
        if (!MODES.includes(mode)) mode = 'edit';

        // Tear down whatever the outgoing mode put on the board. Play and Solve
        // both stage positions that are not the saved board, so leaving either
        // restores what Edit last committed. The solution itself survives - only
        // an actual edit invalidates it - so Solve can be resumed below.
        if (currentMode === 'solve') hidePlayback();
        if (currentMode === 'play' || currentMode === 'solve') {
            clearBlockEntities();
            restoreGridVisuals();
        }

        currentMode = mode;
        document.body.dataset.mode = mode;
        modeTabs.forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
        modePanels.forEach(p => p.classList.toggle('hidden', p.dataset.panel !== mode));

        if (mode === 'play') startPlay();

        // Put the solution back on screen at the step it was left on. Runs after
        // the panels are toggled, so the block positions measure against the
        // layout they will actually be shown in.
        if (mode === 'solve' && hasSolution()) {
            solutionControls.classList.remove('hidden');
            renderStep(currentStep);
        }

        if (updateUrl) {
            const url = new URL(window.location.href);
            url.searchParams.set('mode', mode);
            history.replaceState(null, '', url);
        }
    }

    modeTabs.forEach(tab => {
        tab.addEventListener('click', () => setMode(tab.dataset.mode));
    });

    // Handle Window Resize to reposition blocks
    window.addEventListener('resize', () => {
        if (solutionControls.classList.contains('hidden') === false) {
            renderStep(currentStep);
        }
    });

    function nextStep() {
        if (currentStep < playbackStates.length - 1) {
            renderStep(currentStep + 1);
        } else {
            // Restart if clicking next at the very end
            renderStep(0);
        }
    }

    function prevStep() {
        if (currentStep > 0) {
            renderStep(currentStep - 1);
        }
    }

    btnPrev.addEventListener('click', () => { stopAutoplay(); prevStep(); });
    btnNext.addEventListener('click', () => { stopAutoplay(); nextStep(); });
    btnPlay.addEventListener('click', () => {
        if (autoplayTimer !== null) stopAutoplay();
        else startAutoplay();
    });

    // Init
    initGrid();
    // ?mode= makes a mode linkable and survives a reload. Don't rewrite the URL
    // on boot, so a plain visit stays a plain URL.
    const requestedMode = new URLSearchParams(window.location.search).get('mode');
    setMode(MODES.includes(requestedMode) ? requestedMode : 'edit', { updateUrl: false });
});