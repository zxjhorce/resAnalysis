import { readFile, writeFile } from 'node:fs/promises';
import { parseBuild, compareBuilds, buildReportMarkdown, formatSignedBytes } from './lib/analyzer.mjs';

const help = `资源构建变化解释器\n\n用法：\n  node cli.mjs --before baseline.json --after current.json [--format md|json] [--out report.md]\n\n不传 --out 时输出至标准输出；默认 Markdown。支持 JSON 和 CSV。\n示例：\n  node cli.mjs --before examples/baseline.json --after examples/current.json --out report.md\n`;
async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help') || args.includes('-h')) { console.log(help); return; }
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!['--before', '--after', '--format', '--out'].includes(key)) throw new Error(`未知参数：${key}`);
    if (options[key] !== undefined) throw new Error(`重复参数：${key}`);
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${key} 缺少值`);
    options[key] = args[++index];
  }
  if (!options['--before'] || !options['--after']) throw new Error('请提供 --before 与 --after');
  const format = options['--format'] || 'md';
  if (!['md', 'json'].includes(format)) throw new Error('--format 仅支持 md 或 json');
  const [beforeText, afterText] = await Promise.all([readFile(options['--before'], 'utf8'), readFile(options['--after'], 'utf8')]);
  const result = compareBuilds(parseBuild(beforeText, options['--before']), parseBuild(afterText, options['--after']));
  const report = format === 'json' ? JSON.stringify(result, null, 2) + '\n' : buildReportMarkdown(result);
  if (options['--out']) { await writeFile(options['--out'], report, 'utf8'); console.error(`已生成 ${options['--out']}；构建体积变化：${result.summary.comparable ? formatSignedBytes(result.summary.delta) : '不可直接比较'}`); }
  else process.stdout.write(report + '\n');
}
main().catch(error => { console.error(`分析失败：${error.message}`); process.exitCode = 1; });
