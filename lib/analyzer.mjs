export { parseBuild } from './importers.mjs';

const ordered = values => [...new Set(values)].sort((a, b) => a.localeCompare(b, 'en'));
const equalLists = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
const reason = (code, title, detail, evidence, confidence = 'confirmed') => ({ code, title, detail, evidence, confidence });
const deltaOf = (before, after) => before === null || after === null ? null : after - before;

export function formatBytes(number) {
  if (number === null || number === undefined || !Number.isFinite(number)) return '未知';
  const sign = number < 0 ? '−' : '';
  const magnitude = Math.abs(number);
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const exponent = magnitude === 0 ? 0 : Math.max(0, Math.min(Math.floor(Math.log(magnitude) / Math.log(1024)), units.length - 1));
  const value = magnitude / 1024 ** exponent;
  return `${sign}${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} ${units[exponent]}`;
}

export function formatSignedBytes(number) {
  if (number === null || number === undefined || !Number.isFinite(number)) return '未知';
  return `${number > 0 ? '+' : ''}${formatBytes(number)}`;
}

function assetIndex(build) {
  const aliases = new Map();
  for (const asset of build.assets) aliases.set(asset.path, asset.id);
  for (const asset of build.assets) aliases.set(asset.id, asset.id);
  return aliases;
}

function graphs(before, after) {
  const forward = new Map(), reverse = new Map();
  for (const build of [before, after]) {
    const aliases = assetIndex(build);
    for (const asset of build.assets) {
      if (!forward.has(asset.id)) forward.set(asset.id, new Set());
      for (const dependency of asset.dependencies) {
        const id = aliases.get(dependency);
        if (!id || id === asset.id) continue;
        forward.get(asset.id).add(id);
        if (!reverse.has(id)) reverse.set(id, new Set());
        reverse.get(id).add(asset.id);
      }
    }
  }
  return { forward, reverse };
}

function reachable(graph, start) {
  const seen = new Set([start]), result = [];
  const queue = [...(graph.get(start) || [])].sort();
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index];
    if (seen.has(id)) continue;
    seen.add(id); result.push(id);
    queue.push(...[...(graph.get(id) || [])].sort());
  }
  return ordered(result);
}

function bundleChanges(before, after) {
  const beforeBundles = new Map(before.bundles.map(bundle => [bundle.name, bundle]));
  const afterBundles = new Map(after.bundles.map(bundle => [bundle.name, bundle]));
  const membersOf = build => {
    const memberships = new Map();
    for (const asset of build.assets) {
      for (const name of asset.bundles) {
        if (!memberships.has(name)) memberships.set(name, []);
        memberships.get(name).push(asset.id);
      }
    }
    return memberships;
  };
  const beforeMembers = membersOf(before), afterMembers = membersOf(after);
  return ordered([...beforeBundles.keys(), ...afterBundles.keys()]).map(name => {
    const left = beforeBundles.get(name), right = afterBundles.get(name);
    const leftMembers = ordered(beforeMembers.get(name) || []);
    const rightMembers = ordered(afterMembers.get(name) || []);
    const changed = left && right && (left.size !== right.size || left.hash !== right.hash || !equalLists(leftMembers, rightMembers) || left.sizeSource !== right.sizeSource);
    const beforeSize = left ? left.size : 0, afterSize = right ? right.size : 0;
    const sourceMatches = !left || !right || left.sizeSource === right.sizeSource;
    const sizeSource = sourceMatches ? (left || right).sizeSource : 'mixed';
    const comparable = sourceMatches && beforeSize !== null && afterSize !== null;
    return {
      name, beforeSize, afterSize, delta: comparable ? deltaOf(beforeSize, afterSize) : null,
      status: !left ? 'added' : !right ? 'removed' : changed ? 'modified' : 'unchanged',
      before: left || null, after: right || null,
      sizeSource, comparable,
      membersBefore: leftMembers, membersAfter: rightMembers,
    };
  });
}

/** Explain observable changes; possible causes always remain explicitly conditional. */
export function compareBuilds(before, after) {
  if (!before?.assets || !after?.assets) throw new Error('请先通过 parseBuild 导入两个构建清单。');
  const warnings = ordered([...(before.warnings || []).map(value => `基线：${value}`), ...(after.warnings || []).map(value => `新构建：${value}`)]);
  const sourceMatches = before.totalSizeSource === after.totalSizeSource;
  const platformMatches = !before.platform || !after.platform || before.platform === after.platform;
  if (!sourceMatches) warnings.push('两个构建的总量口径不同：一个使用 Bundle 实测体积，另一个使用资源体积合计。总量差值不可直接比较。');
  if (!platformMatches) warnings.push(`构建平台不同（${before.platform} → ${after.platform}）；平台差异可能影响输出，总量差值不可直接比较。`);
  if (!before.sizeKnown || !after.sizeKnown) warnings.push('存在未知体积，总量只代表已知部分，无法计算完整构建的体积变化。');
  if (!before.platform || !after.platform) warnings.push('部分构建未标注 platform，请确认平台及构建设置一致后解读体积变化。');
  const comparable = sourceMatches && platformMatches && before.sizeKnown && after.sizeKnown;
  const bundles = bundleChanges(before, after);
  const mixedBundles = bundles.filter(bundle => bundle.sizeSource === 'mixed');
  if (mixedBundles.length) warnings.push(`${mixedBundles.length} 个 Bundle 的前后体积口径不同（实测与成员估算），体积差值不可直接比较：${mixedBundles.slice(0, 10).map(bundle => bundle.name).join('; ')}${mixedBundles.length > 10 ? '；其余名称省略' : ''}。`);
  const changedBundles = new Set(bundles.filter(bundle => bundle.status !== 'unchanged').map(bundle => bundle.name));
  const leftMap = new Map(before.assets.map(asset => [asset.id, asset]));
  const rightMap = new Map(after.assets.map(asset => [asset.id, asset]));
  const changes = ordered([...leftMap.keys(), ...rightMap.keys()]).map(id => {
    const left = leftMap.get(id), right = rightMap.get(id);
    const path = right?.path || left.path;
    const reasons = [];
    if (!left) reasons.push(reason('asset_added', '新增资源', '新构建记录了此资源，基线清单没有对应标识。', [`标识：${id}`, `新构建路径：${path}`]));
    else if (!right) reasons.push(reason('asset_removed', '移除资源', '基线记录了此资源，新构建清单没有对应标识。', [`标识：${id}`, `基线路径：${path}`]));
    else {
      if (left.path !== right.path) reasons.push(reason('path_changed', '资源路径变化', '稳定标识相同，记录的资源路径发生变化。', [`${left.path} → ${right.path}`]));
      if (left.size !== right.size) reasons.push(reason('size_changed', '资源体积变化', left.size === null || right.size === null ? '体积可用性发生变化；缺失值不能视为 0。' : '清单记录的字节数发生变化；仅凭体积无法确认压缩、导入设置或内容变化的具体原因。', [`${formatBytes(left.size)} → ${formatBytes(right.size)}`, `差值：${formatSignedBytes(deltaOf(left.size, right.size))}`]));
      if (left.hash && left.hash === right.hash && left.size !== null && right.size !== null && left.size !== right.size) reasons.push(reason('stable_hash_size_changed', '摘要稳定但体积变化', '相同摘要与不同字节数同时出现。摘要和体积可能来自不同度量层面，也可能涉及设置或清单元数据差异；需要核对数据来源与构建设置，不能据此判定清单错误。', [`稳定摘要：${right.hash}`, `记录体积：${formatBytes(left.size)} → ${formatBytes(right.size)}`], 'possible'));
      if (left.hash !== right.hash) reasons.push(reason('hash_changed', left.hash && right.hash ? '内容摘要变化' : '内容摘要可用性变化', left.hash && right.hash ? '清单记录的摘要不同。摘要变化本身不能证明压缩方式或体积变化的具体原因。' : '前后摘要信息不完整，无法确认内容是否发生变化。', [`${left.hash || '未提供'} → ${right.hash || '未提供'}`], left.hash && right.hash ? 'confirmed' : 'possible'));
      if (!equalLists(left.bundles, right.bundles)) reasons.push(reason('bundle_membership_changed', 'Bundle 归属变化', '资源所属 Bundle 列表发生变化，说明打包归属有调整。', [`${left.bundles.join('; ') || '未分配'} → ${right.bundles.join('; ') || '未分配'}`]));
      if (!equalLists(left.dependencies, right.dependencies)) reasons.push(reason('dependencies_changed', '依赖列表变化', '清单记录的依赖关系发生变化。依赖关系不等同于实际重新构建记录。', [`${left.dependencies.join('; ') || '无依赖'} → ${right.dependencies.join('; ') || '无依赖'}`]));
      if (left.type !== right.type) reasons.push(reason('type_changed', '资源类型变化', '清单记录的资源类型发生变化。', [`${left.type} → ${right.type}`]));
    }
    return { id, path, status: !left ? 'added' : !right ? 'removed' : reasons.length ? 'modified' : 'unchanged', before: left || null, after: right || null, delta: deltaOf(left ? left.size : 0, right ? right.size : 0), reasons, impact: [] };
  });
  const { forward, reverse } = graphs(before, after);
  const changeById = new Map(changes.map(change => [change.id, change]));
  const contentChanged = new Set(changes.filter(change => change.status === 'added' || change.status === 'removed' || change.reasons.some(item => item.code === 'hash_changed' && item.confidence === 'confirmed')).map(change => change.id));
  let truncatedImpacts = 0;
  for (const change of changes) {
    if (change.status !== 'unchanged') {
      const affected = reachable(reverse, change.id);
      if (affected.length > 30) truncatedImpacts += 1;
      change.impact = affected.slice(0, 30);
    }
    if (!contentChanged.size || !changedBundles.size || !change.before || !change.after || !change.before.hash || change.before.hash !== change.after.hash) continue;
    const changedContainers = ordered([...change.before.bundles, ...change.after.bundles].filter(name => changedBundles.has(name)));
    if (!changedContainers.length) continue;
    const affectedDependencies = reachable(forward, change.id).filter(id => contentChanged.has(id));
    if (changedContainers.length && affectedDependencies.length) {
      change.reasons.push(reason('possible_propagated_rebuild', '依赖变化可能传播到所在 Bundle', '此资源内容摘要稳定，但依赖资源已变化且所在 Bundle 已变化。依赖传播是可能解释；需要构建日志确认是否实际重新构建。', [`稳定摘要：${change.after.hash}`, `变化 Bundle：${changedContainers.join('; ')}`, `变化依赖：${affectedDependencies.slice(0, 10).map(id => changeById.get(id)?.path || id).join('; ')}`], 'possible'));
    }
  }
  if (truncatedImpacts) warnings.push(`${truncatedImpacts} 个资源的传递依赖影响超过 30 项，列表仅展示按标识排序的前 30 项；影响范围表示依赖关系，不代表已实际重新构建。`);
  const counts = { added: 0, removed: 0, modified: 0, unchanged: 0 };
  for (const change of changes) counts[change.status] += 1;
  const delta = comparable ? after.totalSize - before.totalSize : null;
  const summary = {
    beforeSize: before.totalSize, afterSize: after.totalSize, delta,
    deltaPercent: delta === null || before.totalSize === 0 ? null : delta / before.totalSize * 100,
    ...counts, bundleChanged: bundles.filter(bundle => bundle.status !== 'unchanged').length,
    sizeSource: sourceMatches ? before.totalSizeSource : 'mixed', comparable,
  };
  const insights = [];
  const growth = changes.filter(change => change.delta !== null && change.delta > 0).sort((a, b) => b.delta - a.delta || a.id.localeCompare(b.id, 'en'));
  if (growth.length) insights.push({ id: 'largest-resource-growth', title: '资源层面的主要增量', detail: '以下资源的记录体积增量最大。这些是资源口径的变化；不能按此分摊 Bundle 压缩后的实际增长。', severity: 'high', confidence: 'confirmed', evidence: growth.slice(0, 5).map(change => `${change.path}：${formatSignedBytes(change.delta)}`), relatedIds: growth.slice(0, 5).map(change => change.id) });
  const moved = changes.filter(change => change.reasons.some(item => item.code === 'bundle_membership_changed'));
  if (moved.length) insights.push({ id: 'bundle-membership-changes', title: `${moved.length} 个资源调整了 Bundle 归属`, detail: '归属变化可能影响打包布局。清单不能单独确认下载增量、压缩收益或物理重复体积。', severity: 'medium', confidence: 'confirmed', evidence: moved.slice(0, 5).map(change => `${change.path}：${change.before.bundles.join('; ') || '未分配'} → ${change.after.bundles.join('; ') || '未分配'}`), relatedIds: moved.map(change => change.id) });
  const stableHashSizes = changes.filter(change => change.reasons.some(item => item.code === 'stable_hash_size_changed'));
  if (stableHashSizes.length) insights.push({ id: 'stable-hash-size-changes', title: `${stableHashSizes.length} 个资源摘要稳定但体积变化`, detail: '摘要与体积可能描述不同层面的数据。请核对度量来源及构建设置；这些记录不能单独证明内容变化或清单错误。', severity: 'medium', confidence: 'possible', evidence: stableHashSizes.slice(0, 5).map(change => `${change.path}：${formatBytes(change.before.size)} → ${formatBytes(change.after.size)}`), relatedIds: stableHashSizes.map(change => change.id) });
  const propagated = changes.filter(change => change.reasons.some(item => item.code === 'possible_propagated_rebuild'));
  if (propagated.length) insights.push({ id: 'possible-dependency-propagation', title: `${propagated.length} 个资源存在依赖传播线索`, detail: '资源摘要稳定、依赖内容变化与所在 Bundle 变化同时出现。实际重新构建范围需要构建日志验证。', severity: 'medium', confidence: 'possible', evidence: propagated.slice(0, 5).map(change => change.path), relatedIds: propagated.map(change => change.id) });
  const multi = ordered([...before.assets, ...after.assets].filter(asset => asset.bundles.length > 1).map(asset => asset.id));
  if (multi.length) insights.push({ id: 'multiple-bundle-memberships', title: `前后清单中 ${multi.length} 个资源有多 Bundle 归属`, detail: '成员体积按各 Bundle 分别估算时会重复计入资源；多归属本身不能证明物理文件重复，也不能直接计算可节省体积。', severity: 'medium', confidence: 'confirmed', evidence: multi.slice(0, 5).map(id => { const left = leftMap.get(id), right = rightMap.get(id); return `${right?.path || left.path}：基线 ${left?.bundles.join('; ') || '未分配'} → 新构建 ${right?.bundles.join('; ') || '未分配'}`; }), relatedIds: multi });
  if (!comparable) insights.unshift({ id: 'incomparable-totals', title: '构建总量暂不可直接比较', detail: '总量口径、平台或体积完整性存在差异。资源清单变化仍可检查；总量增长率暂不计算。', severity: 'high', confidence: 'confirmed', evidence: warnings.filter(value => /不可直接比较|未知体积/.test(value)), relatedIds: [] });
  if (!changes.some(change => change.status !== 'unchanged') && !bundles.some(bundle => bundle.status !== 'unchanged')) insights.push({ id: 'no-observed-changes', title: '未观察到清单变化', detail: '资源标识、路径、体积、摘要、Bundle 归属和依赖信息一致；清单未覆盖的构建设置及文件内容仍需其他证据。', severity: 'low', confidence: 'confirmed', evidence: [`${changes.length} 个资源记录一致`, `${bundles.length} 个 Bundle 记录一致`], relatedIds: [] });
  return { before, after, summary, changes, bundles, insights, warnings: ordered(warnings) };
}

const markdownText = value => String(value ?? '').replace(/[\\`*_{}\[\]<>|]/g, '\\$&').replace(/\r?\n/g, ' ');

export function buildReportMarkdown(result) {
  const { summary } = result;
  const lines = [
    '# 资源构建变化报告', '',
    `**基线：** ${markdownText(result.before.name)}${result.before.version ? `（${markdownText(result.before.version)}）` : ''}`, '',
    `**新构建：** ${markdownText(result.after.name)}${result.after.version ? `（${markdownText(result.after.version)}）` : ''}`, '',
    `总量：${formatBytes(summary.beforeSize)}${result.before.sizeKnown ? '' : '（已知部分）'} → ${formatBytes(summary.afterSize)}${result.after.sizeKnown ? '' : '（已知部分）'}；差值：${summary.comparable ? formatSignedBytes(summary.delta) : '不可直接比较'}。`, '',
    `新增 ${summary.added} · 移除 ${summary.removed} · 修改 ${summary.modified} · 未变化 ${summary.unchanged} · Bundle 变化 ${summary.bundleChanged}`, '',
    `总量口径：${summary.sizeSource === 'bundles' ? 'Bundle 实测体积' : summary.sizeSource === 'assets' ? '资源体积合计' : '口径不一致'}。`, '',
  ];
  if (result.insights.length) {
    lines.push('## 解释与证据', '');
    for (const insight of result.insights) {
      lines.push(`### ${markdownText(insight.title)}（${insight.confidence === 'confirmed' ? '已确认事实' : '可能解释'}）`, '', markdownText(insight.detail), '');
      for (const evidence of insight.evidence) lines.push(`- ${markdownText(evidence)}`);
      lines.push('');
    }
  }
  const changed = result.changes.filter(change => change.status !== 'unchanged' || change.reasons.length);
  if (changed.length) {
    lines.push('## 资源明细', '', '| 资源 | 状态 | 体积差值 | 解释 |', '| --- | --- | ---: | --- |');
    const labels = { added: '新增', removed: '移除', modified: '修改', unchanged: '清单一致' };
    for (const change of changed) lines.push(`| ${markdownText(change.path)} | ${labels[change.status]} | ${formatSignedBytes(change.delta)} | ${change.reasons.map(item => `${markdownText(item.title)}${item.confidence === 'possible' ? '（可能）' : ''}`).join('；')} |`);
    lines.push('');
    for (const change of changed) {
      lines.push(`### ${markdownText(change.path)}`, '');
      for (const item of change.reasons) {
        lines.push(`- **${markdownText(item.title)}**：${markdownText(item.detail)}`);
        for (const evidence of item.evidence) lines.push(`  - ${markdownText(evidence)}`);
      }
      if (change.impact.length) lines.push(`- 传递依赖影响（不等同于已重新构建）：${change.impact.map(markdownText).join('、')}`);
      lines.push('');
    }
  }
  if (result.bundles.length) {
    lines.push('## Bundle 明细', '', '| Bundle | 基线体积 | 新体积 | 差值 | 体积口径 |', '| --- | ---: | ---: | ---: | --- |');
    for (const bundle of result.bundles) lines.push(`| ${markdownText(bundle.name)} | ${formatBytes(bundle.beforeSize)} | ${formatBytes(bundle.afterSize)} | ${bundle.sizeSource === 'mixed' ? '不可直接比较' : formatSignedBytes(bundle.delta)} | ${bundle.sizeSource === 'explicit' ? '实测' : bundle.sizeSource === 'mixed' ? '前后口径不同' : '含成员估算'} |`);
    lines.push('');
  }
  if (result.warnings.length) {
    lines.push('## 数据限制', '');
    for (const warning of result.warnings) lines.push(`- ${markdownText(warning)}`);
    lines.push('');
  }
  return lines.join('\n');
}
