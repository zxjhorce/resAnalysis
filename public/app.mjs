import { parseBuild, compareBuilds, formatBytes, formatSignedBytes, buildReportMarkdown } from '/lib/analyzer.mjs';

const $ = id => document.getElementById(id);
const state = { result: null, demo: true, view: 'assets', filter: 'changed', query: '', sort: 'impact', page: 1, selected: null, relatedIds: null, staged: { before: null, after: null }, importing: { before: 0, after: 0 } };
const PAGE_SIZE = 20;
const labels = { added: '新增', modified: '修改', removed: '移除', unchanged: '未变' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const bytes = value => formatBytes(value);
const signed = value => formatSignedBytes(value);
const sum = list => list.some(item => item.delta === null) ? null : list.reduce((n, item) => n + item.delta, 0);
const tone = value => value > 0 ? 'positive' : value < 0 ? 'negative' : '';
const sourceLabel = value => value === 'bundles' ? 'Bundle 清单体积' : value === 'assets' ? '资源体积合计' : '口径不一致';
let toastTimer;
let commitRevision = 0;
let demoRequest = 0;
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 3200); }

function commit(before, after, demo = false) {
  commitRevision++;
  state.result = compareBuilds(before, after); state.demo = demo; state.page = 1; state.selected = null; state.relatedIds = null;
  $('global-error').hidden = true; render();
}

async function loadDemo() {
  const revision = commitRevision; const request = ++demoRequest;
  try {
    const responses = await Promise.all(['/examples/baseline.json', '/examples/current.json'].map(url => fetch(url)));
    if (responses.some(response => !response.ok)) throw new Error('示例文件读取失败');
    const texts = await Promise.all(responses.map(response => response.text()));
    if (revision !== commitRevision || request !== demoRequest) return;
    commit(parseBuild(texts[0], 'baseline.json'), parseBuild(texts[1], 'current.json'), true);
  } catch (error) { if (revision !== commitRevision || request !== demoRequest) return; $('global-error').hidden = false; $('global-error').textContent = `无法载入示例：${error.message}。请通过“导入构建”选择两份清单。`; }
}

function render() {
  const r = state.result; if (!r) return;
  for (const [slot, build] of [['before', r.before], ['after', r.after]]) {
    $(`${slot}-name`).textContent = build.name; $(`${slot}-name`).title = build.name;
    $(`${slot}-meta`).textContent = [build.version, build.platform].filter(Boolean).join(' · ') || `${build.assets.length} 个资源`;
  }
  $('comparison-caption').textContent = `${r.before.name} / ${r.after.name}${state.demo ? ' · 演示数据' : ''}`;
  $('scope-source').textContent = sourceLabel(r.summary.sizeSource);
  $('scope-count').textContent = r.after.assets.length.toLocaleString();
  $('scope-coverage').textContent = `${r.after.assets.filter(asset => asset.size !== null).length} / ${r.after.assets.length}`;
  $('demo-label').hidden = !state.demo;
  $('swap-builds').disabled = false; $('export-report').disabled = false;
  $('metric-delta').textContent = r.summary.comparable ? signed(r.summary.delta) : '不可比较';
  $('delta-percent').textContent = r.summary.deltaPercent !== null ? `${r.summary.deltaPercent > 0 ? '+' : ''}${r.summary.deltaPercent.toFixed(1)}%` : r.summary.comparable && r.summary.beforeSize === 0 && r.summary.afterSize > 0 ? '零基线' : '—';
  $('metric-total').textContent = `${bytes(r.summary.beforeSize)} → ${bytes(r.summary.afterSize)}${r.before.sizeKnown && r.after.sizeKnown ? '' : '（已知部分）'}`;
  for (const status of ['added', 'modified', 'removed']) {
    $(`metric-${status}`).textContent = r.summary[status];
    $(`${status}-size`).textContent = `${signed(sum(r.changes.filter(change => change.status === status)))} 资源体积`;
  }
  $('changed-count').textContent = r.summary.added + r.summary.modified + r.summary.removed;
  $('bundle-count').textContent = r.summary.bundleChanged;
  if (r.warnings.length) { $('warnings').hidden = false; $('warnings').innerHTML = `<details><summary>${r.warnings.length} 项数据提示 · ${esc(r.warnings[0])}</summary><ul>${r.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></details>`; } else $('warnings').hidden = true;
  renderContribution(); renderTable(); renderExplanation();
}

function renderContribution() {
  const { changes, summary } = state.result;
  const groups = ['added', 'modified', 'removed'].map(status => ({ status, value: sum(changes.filter(c => c.status === status)), gross: changes.filter(c => c.status === status).reduce((n, c) => n + Math.abs(c.delta ?? 0), 0) }));
  const total = groups.reduce((n, g) => n + g.gross, 0);
  const incomplete = changes.some(change => change.delta === null);
  $('contribution-chart').innerHTML = groups.map(g => `<div class="bar-segment ${g.status}" title="${labels[g.status]}：${signed(g.value)}"></div>`).join('');
  [...$('contribution-chart').children].forEach((element, index) => { element.style.flexGrow = groups[index].gross; });
  $('contribution-legend').innerHTML = groups.map(g => `<span class="legend-item"><i class="${g.status}"></i>${labels[g.status]}<b>${esc(signed(g.value))}</b></span>`).join('');
  $('contribution-note').textContent = total === 0 ? incomplete ? '体积字段不足，无法完整判断资源字节数变化。未知体积不会视为零。' : '资源字节数未观察到变化；内容摘要和依赖关系仍可能变化。' : `条形长度按${incomplete ? '已知' : '各项'}体积变化的绝对值统计，标签显示净变化。${summary.sizeSource === 'bundles' ? '资源字节数与 Bundle 构建体积口径不同，不作直接分摊。' : '缺失体积的资源不会被当作零字节。'}`;
}

function filteredRows() {
  const rows = state.view === 'assets' ? state.result.changes : state.result.bundles;
  const query = state.query.toLowerCase();
  return rows.filter(row => (!state.relatedIds || state.relatedIds.has(row.id)) && (state.filter === 'all' || state.filter === 'changed' && row.status !== 'unchanged' || row.status === state.filter) && (state.view === 'assets' ? `${row.path} ${row.id} ${(row.after || row.before).bundles.join(' ')}` : row.name).toLowerCase().includes(query)).sort((a, b) => {
    if (state.sort === 'path') return (a.path || a.name).localeCompare(b.path || b.name, 'zh-CN');
    const left = a.delta === null ? -Infinity : state.sort === 'impact' ? Math.abs(a.delta) : a.delta;
    const right = b.delta === null ? -Infinity : state.sort === 'impact' ? Math.abs(b.delta) : b.delta;
    return (right - left || 0) || (a.path || a.name).localeCompare(b.path || b.name, 'zh-CN');
  });
}

function renderTable() {
  if (!state.result) return;
  const assetView = state.view === 'assets';
  for (const view of ['assets', 'bundles']) { $(`${view}-tab`).classList.toggle('active', state.view === view); $(`${view}-tab`).setAttribute('aria-selected', String(state.view === view)); }
  $('results-panel').setAttribute('aria-labelledby', `${state.view}-tab`);
  $('search').placeholder = assetView ? '搜索资源路径' : '搜索 Bundle 名称';
  $('table-head').innerHTML = `<tr><th>状态</th><th>${assetView ? '资源 / 路径' : 'Bundle / 口径'}</th><th class="numeric">基线体积</th><th class="numeric">当前体积</th><th class="numeric">增量</th></tr>`;
  const rows = filteredRows(); const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE)); state.page = Math.min(state.page, pages);
  const page = rows.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
  $('table-body').innerHTML = page.map(row => {
    const full = row.path || row.name; const index = full.lastIndexOf('/'); const filename = full.slice(index + 1);
    const subtitle = assetView ? full.slice(0, index + 1) || (row.after || row.before).type : row.sizeSource === 'explicit' ? 'Bundle 清单体积' : row.sizeSource === 'mixed' ? '前后口径不同' : '资源成员估算';
    const key = assetView ? row.id : row.name;
    return `<tr class="${state.selected?.view === state.view && state.selected.key === key ? 'selected-row' : ''}"><td><span class="status-tag ${row.status}">${labels[row.status]}</span></td><td><button class="asset-path" data-key="${esc(key)}" title="${esc(full)}"><strong>${esc(filename)}</strong><small>${esc(subtitle)}</small></button></td><td class="numeric">${esc(bytes(assetView ? row.before ? row.before.size : 0 : row.beforeSize))}</td><td class="numeric">${esc(bytes(assetView ? row.after ? row.after.size : 0 : row.afterSize))}</td><td class="numeric ${tone(row.delta)}">${esc(signed(row.delta))}</td></tr>`;
  }).join('');
  $('empty-results').hidden = rows.length !== 0;
  $('result-count').textContent = `${rows.length.toLocaleString()} 项${state.relatedIds ? '相关资源 · 点击筛选可恢复全部' : ''}${rows.length > PAGE_SIZE ? ` · 每页 ${PAGE_SIZE} 项` : ''}`;
  $('page-label').textContent = `${state.page} / ${pages}`;
  $('prev-page').disabled = state.page === 1; $('next-page').disabled = state.page === pages;
}

function reasonMarkup(item, index = 0) {
  return `<article class="insight"><div class="insight-top"><span class="insight-number">${String(index + 1).padStart(2, '0')}</span><span class="confidence ${item.confidence === 'possible' ? 'possible' : ''}">${item.confidence === 'possible' ? '可能原因' : '已确认'}</span></div><h3>${esc(item.title)}</h3><p>${esc(item.detail)}</p>${item.evidence?.length ? `<ul class="evidence-list">${item.evidence.map(e => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}</article>`;
}

function renderExplanation() {
  const r = state.result; if (!r) return;
  if (!state.selected) {
    $('explanation-content').innerHTML = r.insights.length ? r.insights.map((item, index) => `${reasonMarkup(item, index)}${item.relatedIds.length ? `<button class="related-button" data-related="${esc(item.id)}">查看相关资源 · ${item.relatedIds.length} 项</button>` : ''}`).join('') : '<p class="muted">点击资源明细，查看前后字段与变化证据。</p>';
    return;
  }
  const { view, key } = state.selected;
  const row = view === 'assets' ? r.changes.find(c => c.id === key) : r.bundles.find(b => b.name === key);
  if (!row) { state.selected = null; renderExplanation(); return; }
  const heading = `<div class="detail-header"><button class="text-button" data-overview>返回变化概览</button><h3>${esc((row.path || row.name).split('/').pop())}</h3><p class="detail-path">${esc(row.path || row.name)}</p><span class="status-tag ${row.status}">${labels[row.status]}</span></div>`;
  if (view === 'bundles') {
    $('explanation-content').innerHTML = heading + `<table class="detail-compare"><thead><tr><th></th><th>基线</th><th>当前</th></tr></thead><tbody><tr><td>体积</td><td>${esc(bytes(row.beforeSize))}</td><td>${esc(bytes(row.afterSize))}</td></tr><tr><td>成员数</td><td>${row.membersBefore.length}</td><td>${row.membersAfter.length}</td></tr><tr><td>摘要</td><td>${esc(row.before?.hash || '未提供')}</td><td>${esc(row.after?.hash || '未提供')}</td></tr></tbody></table>` + reasonMarkup({ title: row.sizeSource === 'explicit' ? `Bundle 清单体积变化 ${signed(row.delta)}` : row.sizeSource === 'mixed' ? '前后 Bundle 体积口径不同' : `资源成员估算变化 ${signed(row.delta)}`, detail: row.sizeSource === 'explicit' ? '体积来自输入的 Bundle 清单。成员或摘要变化提供关联线索，具体构建原因需要日志确认。' : '前后体积可能按成员资源求和，不能视为实际压缩后的输出体积。', confidence: 'confirmed', evidence: [] }) + `<h4 class="detail-section-title">当前成员资源 · ${row.membersAfter.length} 项</h4>${row.membersAfter.length > 30 ? '<p class="chart-note">仅展示前 30 项。</p>' : ''}<ul class="detail-impact">${row.membersAfter.length ? row.membersAfter.slice(0, 30).map(id => `<li>${esc(r.changes.find(c => c.id === id)?.path || id)}</li>`).join('') : '<li>没有记录成员资源</li>'}</ul>`;
    return;
  }
  const fields = [['体积', row.before ? bytes(row.before.size) : '不存在', row.after ? bytes(row.after.size) : '不存在'], ['摘要', row.before?.hash || '未提供', row.after?.hash || '未提供'], ['Bundle', row.before?.bundles.join(', ') || '—', row.after?.bundles.join(', ') || '—'], ['依赖数', row.before?.dependencies.length ?? '—', row.after?.dependencies.length ?? '—']];
  $('explanation-content').innerHTML = heading + `<table class="detail-compare"><thead><tr><th></th><th>基线</th><th>当前</th></tr></thead><tbody>${fields.map(([field, before, after]) => `<tr><td>${field}</td><td>${esc(before)}</td><td>${esc(after)}</td></tr>`).join('')}</tbody></table>` + (row.reasons.length ? row.reasons.map(reasonMarkup).join('') : '<p class="muted">此资源的清单字段一致。未提供的构建信息不在对比范围内。</p>') + (row.impact.length ? `<h4 class="detail-section-title">潜在依赖影响 · ${row.impact.length} 项</h4><p class="chart-note">前后清单的反向引用范围，不代表已经重新构建。</p><ul class="detail-impact">${row.impact.map(id => `<li>${esc(r.changes.find(c => c.id === id)?.path || id)}</li>`).join('')}</ul>` : '');
}

function showImport() {
  state.staged = { before: null, after: null }; state.importing.before++; state.importing.after++;
  for (const slot of ['before', 'after']) { $(`${slot}-import-status`).textContent = ''; $(`${slot}-import-status`).classList.remove('error-text'); $(`${slot}-file`).value = ''; $(`${slot}-paste`).value = ''; }
  $('apply-import').disabled = true; $('import-dialog').showModal();
}

async function importText(slot, textOrPromise, filename, bytesLength = 0) {
  const sequence = ++state.importing[slot]; state.staged[slot] = null; $('apply-import').disabled = true;
  const status = $(`${slot}-import-status`); status.textContent = '正在解析…'; status.classList.remove('error-text');
  try {
    if (bytesLength > 20 * 1024 * 1024) throw new Error('清单超过 20 MB，请缩减为资源清单后重试');
    const text = await (typeof textOrPromise === 'function' ? textOrPromise() : textOrPromise);
    if (new Blob([text]).size > 20 * 1024 * 1024) throw new Error('清单超过 20 MB');
    const build = parseBuild(text, filename);
    if (sequence !== state.importing[slot]) return;
    state.staged[slot] = build; status.textContent = `已就绪 · ${build.name} · ${build.assets.length} 个资源${build.warnings.length ? ` · ${build.warnings.length} 项提示` : ''}`;
  } catch (error) { if (sequence !== state.importing[slot]) return; status.classList.add('error-text'); status.textContent = error.message; }
  $('apply-import').disabled = !(state.staged.before && state.staged.after);
}

function download(content, filename, type) {
  const url = URL.createObjectURL(new Blob([content], { type })); const link = document.createElement('a'); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  $('report-text').value = content; $('report-preview').hidden = false; $('report-description').textContent = `已生成 ${filename}。若浏览器未保存下载，可直接复制报告文本。`; toast('报告已生成');
}

$('import-builds').addEventListener('click', showImport);
$('before-card').addEventListener('click', showImport); $('after-card').addEventListener('click', showImport);
$('load-demo').addEventListener('click', loadDemo);
$('swap-builds').addEventListener('click', () => { const r = state.result; if (r) { commit(r.after, r.before, state.demo); toast('已对调基线与当前构建'); } });
for (const id of ['format-help', 'import-format-help']) $(id).addEventListener('click', () => $('format-dialog').showModal());
$('export-report').addEventListener('click', () => { $('report-preview').hidden = true; $('report-text').value = ''; $('export-dialog').showModal(); });
$('export-markdown').addEventListener('click', () => { if (!state.result) return; download(buildReportMarkdown(state.result), 'build-delta-report.md', 'text/markdown;charset=utf-8'); });
$('export-json').addEventListener('click', () => { if (!state.result) return; download(JSON.stringify(state.result, null, 2), 'build-delta-report.json', 'application/json;charset=utf-8'); });
$('copy-report').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('report-text').value); toast('报告已复制'); } catch { $('report-text').focus(); $('report-text').select(); $('report-description').textContent = '浏览器未授予剪贴板权限。文本已选中，请按 Ctrl+C 复制。'; } });
$('apply-import').addEventListener('click', () => { if (state.staged.before && state.staged.after) { try { commit(state.staged.before, state.staged.after); $('import-dialog').close(); toast('构建对比已完成'); } catch (error) { $('after-import-status').classList.add('error-text'); $('after-import-status').textContent = error.message; } } });
for (const slot of ['before', 'after']) {
  $(`${slot}-file`).addEventListener('change', event => { const file = event.target.files[0]; if (file) importText(slot, () => file.text(), file.name, file.size); });
  document.querySelector(`[data-choose="${slot}"]`).addEventListener('click', () => $(`${slot}-file`).click());
  document.querySelector(`[data-parse="${slot}"]`).addEventListener('click', () => importText(slot, $(`${slot}-paste`).value, `${slot}.json`));
  const zone = document.querySelector(`.dropzone[data-slot="${slot}"]`);
  zone.addEventListener('dragover', event => { event.preventDefault(); zone.classList.add('dragging'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
  zone.addEventListener('drop', event => { event.preventDefault(); zone.classList.remove('dragging'); const files = [...event.dataTransfer.files]; if (files.length !== 1) { state.importing[slot]++; state.staged[slot] = null; $('apply-import').disabled = true; const status = $(`${slot}-import-status`); status.textContent = '请每次导入一份清单'; status.classList.add('error-text'); return; } importText(slot, () => files[0].text(), files[0].name, files[0].size); });
}
for (const view of ['assets', 'bundles']) $(`${view}-tab`).addEventListener('click', () => { state.view = view; state.page = 1; state.selected = null; state.relatedIds = null; renderTable(); renderExplanation(); });
$('status-filters').addEventListener('click', event => { const button = event.target.closest('[data-filter]'); if (!button) return; state.filter = button.dataset.filter; state.page = 1; state.relatedIds = null; document.querySelectorAll('[data-filter]').forEach(b => { b.classList.toggle('active', b === button); b.setAttribute('aria-pressed', String(b === button)); }); renderTable(); });
$('search').addEventListener('input', event => { state.query = event.target.value; state.page = 1; state.relatedIds = null; renderTable(); });
$('sort').addEventListener('change', event => { state.sort = event.target.value; renderTable(); });
$('prev-page').addEventListener('click', () => { state.page--; renderTable(); }); $('next-page').addEventListener('click', () => { state.page++; renderTable(); });
$('table-body').addEventListener('click', event => { const button = event.target.closest('[data-key]'); if (!button) return; state.selected = { view: state.view, key: button.dataset.key }; renderTable(); renderExplanation(); });
$('explanation-content').addEventListener('click', event => {
  if (event.target.closest('[data-overview]')) { state.selected = null; renderTable(); renderExplanation(); }
  const related = event.target.closest('[data-related]'); if (related) { const item = state.result.insights.find(i => i.id === related.dataset.related); if (item?.relatedIds.length) { state.view = 'assets'; state.page = 1; state.selected = null; state.relatedIds = new Set(item.relatedIds); state.filter = 'all'; state.query = ''; $('search').value = ''; document.querySelectorAll('[data-filter]').forEach(b => { const active = b.dataset.filter === 'all'; b.classList.toggle('active', active); b.setAttribute('aria-pressed', String(active)); }); renderTable(); } }
});
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
await loadDemo();
