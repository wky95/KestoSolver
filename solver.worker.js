// Runs the solver off the main thread so the UI stays responsive and the
// search gets its own V8 heap. Loaded only when Worker construction succeeds;
// see app.js for the main-thread fallback used on file:// origins.
// Separate fetch from the page's own script tags, so it needs its own cache
// buster; keep the version in step with index.html.
importScripts('solver.js?v=22');

self.onmessage = (e) => {
    const { bgGrid, fgGrid, options } = e.data;
    try {
        const solver = new Solver(bgGrid, fgGrid);
        const result = solver.solve({
            ...options,
            onProgress: (nodes) => self.postMessage({ type: 'progress', nodes })
        });
        // BigInt board states are structured-cloneable, so `result` posts as-is.
        self.postMessage({ type: 'done', result });
    } catch (err) {
        self.postMessage({ type: 'error', message: (err && err.message) || String(err) });
    }
};
