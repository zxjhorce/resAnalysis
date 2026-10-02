/** Dependency-free, browser-safe importers for resource build manifests. */

function stringValue(value, field, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`${field} 必须是文本或数字。`);
  }
  return String(value).trim();
}

export function normalizePath(value) {
  return stringValue(value, '资源路径').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^(?:\.\/)+/, '');
}

function readSize(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error(`${field} 必须是字节数。`);
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${field} 必须是非负、有限的字节数。`);
  return number;
}

function sizeField(object) {
  return object.size ?? object.byteSize ?? object.sizeBytes;
}

function listValue(value, field, normalize = false) {
  if (value === undefined || value === null || value === '') return [];
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(';') : null;
  if (!values) throw new Error(`${field} 必须是数组或以分号分隔的文本。`);
  return [...new Set(values.map(item => normalize ? normalizePath(item) : stringValue(item, field)).filter(Boolean))].sort();
}

function inferredType(path) {
  const extension = path.match(/\.([^./]+)$/)?.[1]?.toLowerCase();
  return extension || 'unknown';
}

/** RFC 4180-style parser, including escaped quotes, commas and multiline cells. */
export function parseCsv(text) {
  const source = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], cell = '', quoted = false, closedQuote = false;
  const pushCell = () => { row.push(cell); cell = ''; closedQuote = false; };
  const pushRow = () => { pushCell(); rows.push(row); row = []; };
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { cell += '"'; i += 1; }
      else if (char === '"') { quoted = false; closedQuote = true; }
      else cell += char;
      continue;
    }
    if (char === '"') {
      if (cell.length || closedQuote) throw new Error('CSV 引号必须出现在字段开头。');
      quoted = true;
    } else if (char === ',') pushCell();
    else if (char === '\r' || char === '\n') {
      pushRow();
      if (char === '\r' && source[i + 1] === '\n') i += 1;
    } else if (closedQuote) {
      if (char !== ' ' && char !== '\t') throw new Error('CSV 结束引号后包含无效字符。');
    } else cell += char;
  }
  if (quoted) throw new Error('CSV 存在未闭合的引号。');
  if (cell.length || row.length || closedQuote) pushRow();
  const nonempty = rows.filter(values => values.some(value => value.trim()));
  if (!nonempty.length) throw new Error('CSV 文件为空。');
  const headers = nonempty.shift().map(value => value.trim().toLowerCase());
  if (headers.some(value => !value) || new Set(headers).size !== headers.length) throw new Error('CSV 列名为空或重复。');
  if (!headers.includes('path')) throw new Error('CSV 必须包含 path 列。');
  return nonempty.map((values, index) => {
    if (values.length !== headers.length) throw new Error(`CSV 第 ${index + 2} 行的字段数量与列名不一致。`);
    const record = Object.fromEntries(headers.map((header, column) => [header, values[column]]));
    if (record.bytesize !== undefined) record.byteSize = record.bytesize;
    if (record.sizebytes !== undefined) record.sizeBytes = record.sizebytes;
    return record;
  });
}

/** Parse JSON or CSV into one validated normalized build. */
export function parseBuild(text, filename = 'build.json') {
  if (typeof text !== 'string') throw new Error('构建清单必须是文本。');
  const source = text.replace(/^\uFEFF/, '').trim();
  if (!source) throw new Error('构建清单为空。');
  let raw;
  if (/\.csv$/i.test(filename) || !/^[\[{]/.test(source)) {
    raw = { assets: parseCsv(source) };
  } else {
    try { raw = JSON.parse(source); }
    catch (error) { throw new Error(`JSON 无法解析：${error.message}`); }
  }
  if (Array.isArray(raw)) raw = { assets: raw };
  if (!raw || typeof raw !== 'object') throw new Error('构建清单必须是对象或资源数组。');
  if (!Array.isArray(raw.assets)) throw new Error('构建清单必须包含 assets 数组。');
  if (raw.bundles !== undefined && !Array.isArray(raw.bundles)) throw new Error('bundles 必须是数组。');
  const warnings = [];
  const seenIds = new Set(), seenPaths = new Set();
  const assets = raw.assets.map((asset, index) => {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) throw new Error(`第 ${index + 1} 个资源必须是对象。`);
    const path = normalizePath(asset.path);
    if (!path) throw new Error(`第 ${index + 1} 个资源缺少 path。`);
    const explicitId = stringValue(asset.id, `资源 ${path} 的 id`);
    const id = explicitId || path;
    if (seenIds.has(id)) throw new Error(`资源标识重复：${id}`);
    if (seenPaths.has(path)) throw new Error(`资源路径重复：${path}`);
    seenIds.add(id); seenPaths.add(path);
    const size = readSize(sizeField(asset), `资源 ${path} 的 size`);
    const hash = stringValue(asset.hash, `资源 ${path} 的 hash`);
    return {
      id, path, size, hash,
      bundles: listValue(asset.bundles ?? asset.bundle, `资源 ${path} 的 bundles`),
      dependencies: listValue(asset.dependencies, `资源 ${path} 的 dependencies`, true),
      type: stringValue(asset.type, `资源 ${path} 的 type`, inferredType(path)),
    };
  }).sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const missingSize = assets.filter(asset => asset.size === null);
  if (missingSize.length) warnings.push(`${missingSize.length} 个资源缺少体积；资源体积合计仅包含已知字节数，未知体积不是 0。`);
  const missingHash = assets.filter(asset => !asset.hash);
  if (missingHash.length) warnings.push(`${missingHash.length} 个资源缺少内容摘要（hash），无法仅凭清单确认其内容是否变化。`);
  const multiplyBundled = assets.filter(asset => asset.bundles.length > 1);
  if (multiplyBundled.length) warnings.push(`${multiplyBundled.length} 个资源属于多个 Bundle；成员体积估算会重复计入这些资源，不能据此确认物理重复字节数。`);
  const bundleMap = new Map();
  for (const [index, bundle] of (raw.bundles || []).entries()) {
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) throw new Error(`第 ${index + 1} 个 Bundle 必须是对象。`);
    const name = stringValue(bundle.name, 'Bundle 名称');
    if (!name) throw new Error(`第 ${index + 1} 个 Bundle 缺少 name。`);
    if (bundleMap.has(name)) throw new Error(`Bundle 名称重复：${name}`);
    const size = readSize(sizeField(bundle), `Bundle ${name} 的 size`);
    bundleMap.set(name, { name, size, hash: stringValue(bundle.hash, `Bundle ${name} 的 hash`), sizeSource: 'explicit', sizeKnown: size !== null });
  }
  const membershipTotals = new Map();
  for (const asset of assets) {
    for (const name of asset.bundles) {
      if (!bundleMap.has(name)) bundleMap.set(name, { name, size: null, hash: '', sizeSource: 'estimated', sizeKnown: false });
      if (!membershipTotals.has(name)) membershipTotals.set(name, { assetCount: 0, knownSize: 0, sizeKnown: true });
      const totals = membershipTotals.get(name);
      totals.assetCount += 1;
      totals.knownSize += asset.size ?? 0;
      if (asset.size === null) totals.sizeKnown = false;
    }
  }
  const bundles = [...bundleMap.values()].map(bundle => {
    const { assetCount, knownSize, sizeKnown } = membershipTotals.get(bundle.name) || { assetCount: 0, knownSize: 0, sizeKnown: true };
    if (bundle.sizeSource === 'estimated') {
      bundle.sizeKnown = sizeKnown;
      bundle.size = bundle.sizeKnown ? knownSize : null;
    }
    return { ...bundle, assetCount, memberSize: knownSize };
  }).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const incompleteExplicit = bundles.filter(bundle => bundle.sizeSource === 'explicit' && !bundle.sizeKnown);
  if (incompleteExplicit.length) warnings.push(`${incompleteExplicit.length} 个 Bundle 缺少实测体积；总量使用资源体积合计。`);
  if (bundles.some(bundle => bundle.sizeSource === 'estimated')) warnings.push('部分或全部 Bundle 体积按资源成员估算，未包含压缩、容器头或构建开销；总量使用资源体积合计。');
  const useBundles = bundles.length > 0 && bundles.every(bundle => bundle.sizeSource === 'explicit' && bundle.sizeKnown);
  const totalSize = (useBundles ? bundles : assets).reduce((total, entry) => total + (entry.size ?? 0), 0);
  if (!Number.isFinite(totalSize)) throw new Error('体积合计超出可表示的范围。');
  const name = stringValue(raw.name, '构建名称', stringValue(filename, '文件名').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') || 'build');
  return {
    name, version: stringValue(raw.version, '构建版本'), platform: stringValue(raw.platform, '构建平台'),
    assets, bundles, warnings, totalSize, totalSizeSource: useBundles ? 'bundles' : 'assets',
    sizeKnown: useBundles || assets.every(asset => asset.size !== null),
  };
}
