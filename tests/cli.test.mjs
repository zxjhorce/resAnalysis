import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const demoArgs = ['--before', 'examples/baseline.json', '--after', 'examples/current.json'];

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root, encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, 'CLI must terminate normally');
  return result;
}

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'resource explainer cli '));
  const absoluteDirectory = resolve(directory);
  assert.equal(dirname(absoluteDirectory), resolve(tmpdir()));
  assert.match(basename(absoluteDirectory), /^resource explainer cli /);
  t.after(() => rmSync(absoluteDirectory, { recursive: true, force: true }));
  return directory;
}

function assertUsefulFailure(result, expected) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.trim().length > 0);
  assert.match(result.stderr, expected);
  assert.doesNotMatch(result.stderr, /\[object Object\]|undefined/);
}

test('CLI emits valid JSON with the independently known demo summary', () => {
  const result = run([...demoArgs, '--format', 'json']);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.before.name, 'release-1.8.0');
  assert.equal(report.after.name, 'release-1.9.0');
  assert.deepEqual({
    beforeSize: report.summary.beforeSize,
    afterSize: report.summary.afterSize,
    delta: report.summary.delta,
    added: report.summary.added,
    removed: report.summary.removed,
    modified: report.summary.modified,
    unchanged: report.summary.unchanged,
  }, {
    beforeSize: 127926272, afterSize: 150994944, delta: 23068672,
    added: 3, removed: 2, modified: 7, unchanged: 8,
  });
  assert.equal(report.summary.comparable, true);
  assert.equal(report.summary.sizeSource, 'bundles');
  assert.equal(report.changes.length, 20);
});

test('CLI defaults to readable Markdown with resource evidence', () => {
  const result = run(demoArgs);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /^# /);
  assert.match(result.stdout, /release-1\.8\.0/);
  assert.match(result.stdout, /release-1\.9\.0/);
  assert.match(result.stdout, /hero\\?_albedo\.png/);
  assert.match(result.stdout, /\+22 MB/);
  assert.doesNotMatch(result.stdout, /\[object Object\]|undefined|NaN|Infinity/);
});

test('CLI --out writes the requested file, including paths with spaces', t => {
  const directory = temporaryDirectory(t);
  const output = join(directory, 'build report.json');
  const result = run([...demoArgs, '--format', 'json', '--out', output]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.includes(output));
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).summary.delta, 23068672);
});

test('CLI rejects an unknown flag with a useful parameter error', () => {
  assertUsefulFailure(run([...demoArgs, '--surprise', 'yes']), /surprise/);
});

test('CLI requires both build inputs and values for their flags', () => {
  assertUsefulFailure(run(['--before', 'examples/baseline.json']), /--after/);
  assertUsefulFailure(run([...demoArgs, '--out']), /--out/);
});

test('CLI surfaces malformed input without writing a misleading output report', t => {
  const directory = temporaryDirectory(t);
  const malformed = join(directory, 'broken build.json');
  const output = join(directory, 'should not exist.md');
  writeFileSync(malformed, '{"assets": [', 'utf8');
  const result = run(['--before', malformed, '--after', 'examples/current.json', '--out', output]);
  assertUsefulFailure(result, /JSON|json|解析|格式/);
  assert.throws(() => readFileSync(output), { code: 'ENOENT' });
});

test('CLI reports missing files and unsupported output formats', () => {
  assertUsefulFailure(run(['--before', 'examples/missing-build.json', '--after', 'examples/current.json']), /missing-build\.json/);
  assertUsefulFailure(run([...demoArgs, '--format', 'xml']), /--format/);
});
