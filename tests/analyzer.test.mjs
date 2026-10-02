import test from 'node:test';
import assert from 'node:assert/strict';
import { compareBuilds, formatBytes, formatSignedBytes, buildReportMarkdown } from '../lib/analyzer.mjs';
import { parseBuild } from '../lib/importers.mjs';

const build = (assets, extra = {}) => parseBuild(JSON.stringify({
  name: 'Example build', version: '1', platform: 'web', assets, ...extra,
}), 'build.json');

const byPath = (report, path) => report.changes.find(change => change.path === path);
const warningText = warnings => JSON.stringify(warnings ?? []).toLowerCase();

test('JSON imports preserve exact byte sizes and normalize metadata', () => {
  const parsed = build([
    { path: 'textures/a.png', size: 1025, hash: 'a', type: 'texture' },
    { path: 'sounds/a.ogg', size: 7, hash: 'b', type: 'audio' },
  ]);
  assert.equal(parsed.name, 'Example build');
  assert.equal(parsed.version, '1');
  assert.equal(parsed.platform, 'web');
  assert.equal(parsed.assets.length, 2);
  assert.equal(parsed.assets.find(asset => asset.path === 'textures/a.png').size, 1025);
  assert.equal(parsed.totalSize, 1032);
  assert.equal(parsed.sizeKnown, true);
  assert.ok(Array.isArray(parsed.bundles));
  assert.ok(Array.isArray(parsed.warnings));
});

test('JSON imports tolerate a UTF-8 BOM and whitespace', () => {
  const parsed = parseBuild('\uFEFF \r\n' + JSON.stringify({ assets: [{ path: '你好.png', size: 19 }] }), 'unicode.json');
  assert.equal(parsed.assets[0].path, '你好.png');
  assert.equal(parsed.totalSize, 19);
});

test('CSV imports handle BOM, CRLF, quoted commas and escaped quotes', () => {
  const parsed = parseBuild('\uFEFFpath,size,hash,type\r\n"textures/a,b.png",1025,abc,texture\r\n"notes/a""b.txt",17,def,text\r\n', 'build.csv');
  assert.equal(parsed.assets.length, 2);
  assert.ok(parsed.assets.some(asset => asset.path === 'textures/a,b.png'));
  assert.ok(parsed.assets.some(asset => asset.path === 'notes/a"b.txt'));
  assert.equal(parsed.totalSize, 1042);
});

test('invalid negative sizes cannot lower the known total', () => {
  assert.throws(() => build([{ path: 'valid.bin', size: 30 }, { path: 'invalid.bin', size: -200 }]));
});

test('duplicate paths or stable IDs are surfaced rather than silently trusted', () => {
  assert.throws(() => build([{ path: 'same.bin', size: 10 }, { path: 'same.bin', size: 12 }]));
  assert.throws(() => build([{ id: 'same-id', path: 'a.bin', size: 10 }, { id: 'same-id', path: 'b.bin', size: 12 }]));
});

test('invalid numeric sizes and duplicate bundle identities are rejected', () => {
  assert.throws(() => build([{ path: 'a.bin', size: 'Infinity' }]));
  assert.throws(() => build([{ path: 'a.bin', size: 'not-a-number' }]));
  assert.throws(() => build([{ path: 'a.bin', size: 10 }], {
    bundles: [{ name: 'main', size: 8 }, { name: 'main', size: 9 }],
  }));
});

test('malformed input gives an error instead of a plausible empty build', () => {
  assert.throws(() => parseBuild('{"assets": [', 'invalid.json'));
  assert.throws(() => parseBuild('path,size\n"never closed,10', 'invalid.csv'));
});

test('explicit bundle output sizes take precedence over asset estimates', () => {
  const parsed = build([
    { path: 'a.bin', size: 100, bundle: 'main' },
    { path: 'b.bin', size: 200, bundle: 'main' },
  ], { bundles: [{ name: 'main', size: 175, hash: 'bundle-hash' }] });
  assert.equal(parsed.totalSize, 175);
  assert.match(parsed.totalSizeSource, /bundle/i);
});

test('comparison accounts for added, removed, changed and unchanged resources', () => {
  const before = build([
    { path: 'kept.bin', size: 20, hash: 'stable' },
    { path: 'grown.bin', size: 10, hash: 'old' },
    { path: 'removed.bin', size: 7, hash: 'gone' },
  ]);
  const after = build([
    { path: 'kept.bin', size: 20, hash: 'stable' },
    { path: 'grown.bin', size: 15, hash: 'new' },
    { path: 'added.bin', size: 12, hash: 'added' },
  ]);
  const report = compareBuilds(before, after);
  assert.equal(report.summary.beforeSize, 37);
  assert.equal(report.summary.afterSize, 47);
  assert.equal(report.summary.delta, 10);
  assert.equal(report.summary.added, 1);
  assert.equal(report.summary.removed, 1);
  assert.equal(report.summary.modified, 1);
  assert.equal(report.summary.unchanged, 1);
  assert.equal(byPath(report, 'grown.bin').delta, 5);
  assert.equal(byPath(report, 'added.bin').delta, 12);
  assert.equal(byPath(report, 'removed.bin').delta, -7);
  assert.ok(Array.isArray(report.insights));
  assert.ok(Array.isArray(report.warnings));
  assert.ok(report.changes.every(change => Array.isArray(change.reasons) && Array.isArray(change.impact)));
});

test('a content hash change is detected even when byte size is identical', () => {
  const report = compareBuilds(
    build([{ path: 'same-size.bin', size: 100, hash: 'one' }]),
    build([{ path: 'same-size.bin', size: 100, hash: 'two' }]),
  );
  assert.equal(report.summary.modified, 1);
  assert.equal(report.summary.delta, 0);
  const changed = byPath(report, 'same-size.bin');
  assert.ok(changed);
  assert.equal(changed.delta, 0);
  assert.ok(changed.reasons.length > 0);
  assert.match(JSON.stringify(changed.reasons), /hash|哈希|内容/i);
});

test('stable resource IDs match renamed paths as a modification', () => {
  const report = compareBuilds(
    build([{ id: 'texture-1', path: 'old/a.png', size: 100, hash: 'stable' }]),
    build([{ id: 'texture-1', path: 'new/a.png', size: 100, hash: 'stable' }]),
  );
  assert.equal(report.summary.added, 0);
  assert.equal(report.summary.removed, 0);
  assert.equal(report.summary.modified, 1);
  assert.match(JSON.stringify(report.changes[0].reasons), /path|路径|重命名/i);
});

test('changes report reasons with evidence and confidence', () => {
  const report = compareBuilds(
    build([{ path: 'a.bin', size: 10, hash: 'one' }]),
    build([{ path: 'a.bin', size: 15, hash: 'two' }]),
  );
  for (const reason of byPath(report, 'a.bin').reasons) {
    assert.equal(typeof reason.code, 'string');
    assert.equal(typeof reason.title, 'string');
    assert.equal(typeof reason.detail, 'string');
    assert.ok(reason.evidence != null);
    assert.ok(reason.confidence != null);
  }
});

test('dependency impact follows dependents and terminates on cycles', { timeout: 2000 }, () => {
  const assets = [
    { path: 'a.bin', size: 10, hash: 'a1', dependencies: ['b.bin'] },
    { path: 'b.bin', size: 20, hash: 'b1', dependencies: ['a.bin'] },
    { path: 'c.bin', size: 30, hash: 'c1', dependencies: ['b.bin'] },
  ];
  const report = compareBuilds(build(assets), build(assets.map(asset => asset.path === 'a.bin' ? { ...asset, hash: 'a2' } : asset)));
  const impact = byPath(report, 'a.bin').impact;
  assert.ok(impact.includes('b.bin'));
  assert.ok(impact.includes('c.bin'));
  assert.equal(new Set(impact).size, impact.length);
});

test('changing bundle membership is a change even with the same hash and size', () => {
  const report = compareBuilds(
    build([{ path: 'a.bin', size: 10, hash: 'stable', bundles: ['base'] }]),
    build([{ path: 'a.bin', size: 10, hash: 'stable', bundles: ['extra'] }]),
  );
  assert.equal(report.summary.modified, 1);
  assert.ok(byPath(report, 'a.bin').reasons.length > 0);
  assert.match(JSON.stringify(byPath(report, 'a.bin').reasons), /bundle|分包|包归属|所属包/i);
});

test('membership and dependency list ordering does not create resource changes', () => {
  const report = compareBuilds(
    build([
      { path: 'a.bin', size: 10, hash: 'stable', bundles: ['base', 'shared'], dependencies: ['b.bin', 'c.bin'] },
      { path: 'b.bin', size: 20, hash: 'b' },
      { path: 'c.bin', size: 30, hash: 'c' },
    ]),
    build([
      { path: 'a.bin', size: 10, hash: 'stable', bundles: ['shared', 'base'], dependencies: ['c.bin', 'b.bin'] },
      { path: 'b.bin', size: 20, hash: 'b' },
      { path: 'c.bin', size: 30, hash: 'c' },
    ]),
  );
  assert.equal(report.summary.modified, 0);
  assert.equal(report.summary.unchanged, 3);
});

test('output bundle differences affect bundle count and authoritative total', () => {
  const report = compareBuilds(
    build([{ path: 'a.bin', size: 10 }], { bundles: [{ name: 'main', size: 8, hash: 'one' }] }),
    build([{ path: 'a.bin', size: 10 }], { bundles: [{ name: 'main', size: 9, hash: 'two' }] }),
  );
  assert.equal(report.summary.beforeSize, 8);
  assert.equal(report.summary.afterSize, 9);
  assert.equal(report.summary.delta, 1);
  assert.equal(report.summary.bundleChanged, 1);
});

test('added and removed explicit bundles retain measured sources and signed deltas', () => {
  const report = compareBuilds(
    build([], { bundles: [{ name: 'old', size: 100, hash: 'one' }] }),
    build([], { bundles: [{ name: 'new', size: 200, hash: 'two' }] }),
  );
  const removed = report.bundles.find(bundle => bundle.name === 'old');
  const added = report.bundles.find(bundle => bundle.name === 'new');
  assert.equal(removed.status, 'removed');
  assert.equal(removed.sizeSource, 'explicit');
  assert.equal(removed.comparable, true);
  assert.equal(removed.delta, -100);
  assert.equal(added.status, 'added');
  assert.equal(added.sizeSource, 'explicit');
  assert.equal(added.comparable, true);
  assert.equal(added.delta, 200);
});

test('a bundle changing from member estimates to measured bytes has no numeric delta', () => {
  const report = compareBuilds(
    build([{ path: 'a.bin', size: 10, hash: 'stable', bundle: 'main' }]),
    build([{ path: 'a.bin', size: 10, hash: 'stable', bundle: 'main' }], {
      bundles: [{ name: 'main', size: 8, hash: 'output' }],
    }),
  );
  const main = report.bundles.find(bundle => bundle.name === 'main');
  assert.equal(main.sizeSource, 'mixed');
  assert.equal(main.comparable, false);
  assert.equal(main.delta, null);
  assert.equal(main.status, 'modified');
  assert.ok(report.warnings.some(warning => warning.includes('main')));
  assert.match(buildReportMarkdown(report), /main.*不可直接比较/);
});

test('stable hash with different size carries a conditional diagnostic and insight', () => {
  const report = compareBuilds(
    build([{ path: 'a.bin', size: 10, hash: 'stable' }]),
    build([{ path: 'a.bin', size: 15, hash: 'stable' }]),
  );
  const change = byPath(report, 'a.bin');
  const diagnostic = change.reasons.find(reason => reason.code === 'stable_hash_size_changed');
  assert.equal(change.status, 'modified');
  assert.equal(change.delta, 5);
  assert.ok(diagnostic);
  assert.equal(diagnostic.confidence, 'possible');
  assert.ok(diagnostic.evidence.length > 0);
  assert.ok(!change.reasons.some(reason => reason.code === 'hash_changed'));
  assert.ok(report.insights.some(insight => insight.confidence === 'possible' && insight.relatedIds.includes(change.id)));
});

test('incompatible platforms are visibly qualified', () => {
  const report = compareBuilds(
    build([{ path: 'a.bin', size: 10 }], { platform: 'android' }),
    build([{ path: 'a.bin', size: 15 }], { platform: 'ios' }),
  );
  assert.ok(report.warnings.length > 0);
  assert.equal(report.summary.comparable, false);
  assert.match(warningText(report.warnings), /platform|平台|android|ios/i);
});

test('mixing asset estimates and output bundle totals is visibly qualified', () => {
  const report = compareBuilds(
    build([{ path: 'a.bin', size: 10 }]),
    build([{ path: 'a.bin', size: 15 }], { bundles: [{ name: 'main', size: 12 }] }),
  );
  assert.ok(report.warnings.length > 0);
  assert.equal(report.summary.comparable, false);
});

test('missing sizes and hashes produce uncertainty without invented content causes', () => {
  const before = build([{ path: 'a.bin' }]);
  const after = build([{ path: 'a.bin' }]);
  const report = compareBuilds(before, after);
  assert.ok(before.warnings.length > 0);
  assert.equal(before.sizeKnown, false);
  assert.ok(report.warnings.length > 0);
  assert.equal(report.summary.comparable, false);
  assert.equal(report.summary.modified, 0);
  for (const change of report.changes) {
    assert.ok(!change.reasons.some(reason => /hash.changed|content.changed/i.test(reason.code)));
  }
});

test('a size-only manifest exposes missing hash evidence without asserting a content change', () => {
  const before = build([{ path: 'a.bin', size: 10 }]);
  const after = build([{ path: 'a.bin', size: 15 }]);
  const report = compareBuilds(before, after);
  assert.equal(report.summary.modified, 1);
  assert.match(warningText([...before.warnings, ...after.warnings, ...report.warnings]), /hash|哈希|内容摘要/);
  assert.ok(!byPath(report, 'a.bin').reasons.some(reason => /hash.changed|content.changed/i.test(reason.code)));
});

test('empty baseline percentage does not become Infinity or NaN', () => {
  const report = compareBuilds(build([]), build([{ path: 'new.bin', size: 15 }]));
  assert.equal(report.summary.delta, 15);
  assert.ok(report.summary.deltaPercent == null || Number.isFinite(report.summary.deltaPercent));
  assert.doesNotMatch(buildReportMarkdown(report), /Infinity|NaN/);
});

test('byte formatting keeps zero and sign meaningful', () => {
  assert.equal(typeof formatBytes(1024), 'string');
  assert.match(formatBytes(0), /0/);
  assert.match(formatSignedBytes(10), /\+/);
  assert.match(formatSignedBytes(-10), /[-−]/);
  assert.doesNotMatch(formatSignedBytes(0), /NaN|Infinity/);
});

test('Markdown report includes build context, resource paths and useful evidence', () => {
  const before = build([{ path: 'textures/a.png', size: 100, hash: 'old' }], { name: 'Baseline', version: 'v1' });
  const after = build([{ path: 'textures/a.png', size: 150, hash: 'new' }], { name: 'Candidate', version: 'v2' });
  const report = compareBuilds(before, after);
  const markdown = buildReportMarkdown(report);
  assert.equal(typeof markdown, 'string');
  assert.match(markdown, /^#/m);
  assert.match(markdown, /textures\/a\.png/);
  assert.match(markdown, /Baseline|v1/);
  assert.match(markdown, /Candidate|v2/);
  assert.doesNotMatch(markdown, /\[object Object\]|undefined|NaN|Infinity/);
});
