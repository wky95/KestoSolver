// Runs every suite and reports one verdict. `node test/run.js`
//
// Suites are ordered cheapest first so a broken build fails fast. The slow ones
// are skipped unless KESTO_SLOW=1, since they solve real levels end to end and
// take minutes.
const { execFileSync } = require('child_process');
const path = require('path');

const SLOW = process.env.KESTO_SLOW === '1';

const SUITES = [
    ['test-modes.js', 'mode switching keeps the solution panel intact', false],
    ['test-app.js', 'app behaviour + 100k randomised operations', false],
    ['test-async.js', 'daily puzzle loading', false],
    ['test-play-rules.js', 'Play mode moves agree with the solver', false],
    ['test-beam.js', 'the beam fallback never claims false optimality', false],
    ['test-symmetry.js', 'mirrored positions collapse without corrupting the path', false],
    ['test-optimality.js', 'a search cut short never claims to have proven anything', true],
    ['test-levels.js', 'every real level matches the par Kesto publishes', true],
];

let failed = 0, skipped = 0;
for (const [file, what, slow] of SUITES) {
    if (slow && !SLOW) {
        console.log(`SKIP  ${file.padEnd(20)} ${what}  (set KESTO_SLOW=1)`);
        skipped++;
        continue;
    }
    // Only redraw in place on a real terminal; piped output keeps the \r.
    if (process.stdout.isTTY) process.stdout.write(`....  ${file.padEnd(20)} ${what}\r`);
    try {
        execFileSync(process.execPath, ['--max-old-space-size=8192', path.join(__dirname, file)], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        console.log(`PASS  ${file.padEnd(20)} ${what}`);
    } catch (err) {
        failed++;
        console.log(`FAIL  ${file.padEnd(20)} ${what}`);
        const out = `${err.stdout || ''}${err.stderr || ''}`.trim();
        out.split('\n').slice(-25).forEach(l => console.log('        ' + l));
    }
}

console.log(`\n${failed === 0 ? 'ALL SUITES PASSED' : failed + ' SUITE(S) FAILED'}${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(failed === 0 ? 0 : 1);
