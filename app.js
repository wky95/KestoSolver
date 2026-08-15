document.addEventListener('DOMContentLoaded', () => {
    const gridEl = document.getElementById('grid');
    const toolBtns = document.querySelectorAll('.tool-btn');
    const btnClear = document.getElementById('btn-clear');
    const btnSolve = document.getElementById('btn-solve');
    const btnCancel = document.getElementById('btn-cancel');
    const btnEdit = document.getElementById('btn-edit');
    const solverMessage = document.getElementById('solver-message');
    
    // Playback Controls
    const solutionControls = document.getElementById('solution-controls');
    const stepCurrentEl = document.getElementById('current-step');
    const stepTotalEl = document.getElementById('total-steps');
    const pathDisplay = document.getElementById('path-display');
    const btnPrev = document.getElementById('btn-prev');
    const btnPlay = document.getElementById('btn-play');
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
                    if (!solutionControls.classList.contains('hidden')) return;
                    isDrawing = true;
                    applyTool(r, c);
                });
                cell.addEventListener('mouseenter', (e) => {
                    if (isDrawing && solutionControls.classList.contains('hidden')) {
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
        solutionControls.classList.add('hidden');
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

    // Edit Board
    btnEdit.addEventListener('click', () => {
        solutionControls.classList.add('hidden');
        btnEdit.classList.add('hidden');
        btnSolve.classList.remove('hidden');

        // Update fgGrid to match the current playback step
        const currentBlocks = playbackIdentities[currentStep] || [];
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                fgGrid[r][c] = '.';
            }
        }
        currentBlocks.forEach(pos => {
            if (pos) {
                fgGrid[pos.r][pos.c] = 'Y';
            }
        });

        clearBlockEntities();
        restoreGridVisuals();
        saveGrid();
        solverMessage.textContent = "Edit mode. Ready to solve.";
        solverMessage.style.color = "var(--text-secondary)";
    });

    // Clear Board
    btnClear.addEventListener('click', () => {
        solutionControls.classList.add('hidden');
        btnEdit.classList.add('hidden');
        btnSolve.classList.remove('hidden');
        clearBlockEntities();
        solverMessage.textContent = "Board cleared.";
        solverMessage.style.color = "var(--text-secondary)";
        // The board is no longer that day's puzzle, so drop the id badge.
        puzzleBadge.classList.add('hidden');

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
            return new Worker('solver.worker.js?v=4');
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
                pathDisplay.textContent = result.path.join(' → ');
                solutionControls.classList.remove('hidden');
                btnSolve.classList.add('hidden');
                btnEdit.classList.remove('hidden');
                stepTotalEl.textContent = result.path.length;
                currentStep = 0;
                computeBlockIdentities();
                renderStep(0);
            } else {
                // Already solved
                solutionControls.classList.add('hidden');
            }
        } else {
            solverMessage.textContent = result.message || "No solution found.";
            solverMessage.style.color = "#ff2a6d";
            solutionControls.classList.add('hidden');
            btnEdit.classList.add('hidden');
            btnSolve.classList.remove('hidden');
            clearBlockEntities();
            restoreGridVisuals();
        }
    }

    function showFailure(text) {
        solverMessage.textContent = text;
        solverMessage.style.color = "#ff2a6d";
        solutionControls.classList.add('hidden');
        btnEdit.classList.add('hidden');
        btnSolve.classList.remove('hidden');
    }

    btnSolve.addEventListener('click', () => {
        const options = STRENGTH_PRESETS[currentStrength];
        const budgetSec = Math.round(options.totalTimeBudgetMs / 1000);
        solverMessage.style.color = "var(--text-primary)";
        solutionControls.classList.add('hidden');

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

        solutionControls.classList.add('hidden');
        btnEdit.classList.add('hidden');
        btnSolve.classList.remove('hidden');
        playbackStates = [];
        playbackPath = [];
        playbackIdentities = [];
        currentStep = 0;

        clearBlockEntities();
        restoreGridVisuals();
        saveGrid();

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
            loadPuzzleIntoBoard(puzzle.bgGrid, puzzle.fgGrid);

            const par = puzzle.stars && puzzle.stars.length ? puzzle.stars[0] : null;
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

    function renderStep(stepIndex) {
        currentStep = stepIndex;
        stepCurrentEl.textContent = stepIndex;

        // Clean grid visual blocks (hide the Y cells so block-entities can overlay them)
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                if (fgGrid[r][c] === 'Y') {
                    cells[r][c].classList.remove('block');
                }
            }
        }

        const blocks = playbackIdentities[stepIndex] || [];

        // Ensure we have correct number of entities
        while (blockEntities.length < blocks.length) {
            const el = document.createElement('div');
            el.className = 'block-entity';
            gridEl.appendChild(el);
            blockEntities.push(el);
        }
        while (blockEntities.length > blocks.length) {
            const el = blockEntities.pop();
            el.remove();
        }

        // Position entities
        blocks.forEach((pos, i) => {
            const cell = cells[pos.r][pos.c];
            const el = blockEntities[i];
            
            // Calculate position relative to grid
            // Grid gap is 4px, cell is 60px, padding is 12px
            const left = 12 + pos.c * 64; 
            const top = 12 + pos.r * 64;
            
            // For responsive layout, better to rely on cell offset relative to grid
            const gridRect = gridEl.getBoundingClientRect();
            const cellRect = cells[pos.r][pos.c].getBoundingClientRect();
            
            el.style.left = (cellRect.left - gridRect.left - 1 /* border adjust */) + 'px';
            el.style.top = (cellRect.top - gridRect.top - 1 /* border adjust */) + 'px';
            el.style.width = cellRect.width + 'px';
            el.style.height = cellRect.height + 'px';

            if (bgGrid[pos.r][pos.c] === 'T') {
                el.classList.add('on-target');
            } else {
                el.classList.remove('on-target');
            }
        });
    }

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

    btnPrev.addEventListener('click', () => { prevStep(); });
    btnPlay.addEventListener('click', () => { nextStep(); });

    // Init
    initGrid();
});