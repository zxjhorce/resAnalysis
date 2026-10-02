# 资源构建变化解释器

[简体中文](README.md) | [English](README.en.md)

对比两次构建的资源清单，解释新增、移除、体积、内容摘要、Bundle 归属与依赖变化。提供本地网页和命令行，不需要安装项目依赖。所有示例是演示数据。

![演示界面](artifacts/preview.jpg)

文档提供中英文版本；当前网页、命令行提示、Markdown 报告和 JSON 中的人类可读解释使用中文，结构化 JSON 字段名使用英文。

## 启动

需要已有的 Node.js 20 或更高版本。双击 `start.cmd`，或在此目录运行：

```powershell
npm start
```

打开 http://127.0.0.1:4173 。页面默认展示演示对比；点击“导入构建”选择或粘贴两份 JSON/CSV。文件在浏览器内处理，不上传到服务器。更换端口可使用 `$env:PORT=4180` 后启动。

无需运行 `npm install`。服务器只监听本机地址 `127.0.0.1`，按 `Ctrl+C` 停止。macOS/Linux 可使用 `npm start`，更换端口使用 `PORT=4180 npm start`；`start.cmd` 仅用于 Windows。

## 能做什么

- 按资源标识匹配资源；有 `id` 时使用该值，没有时使用规范化路径，显示新增、修改、移除和未变。
- 对比字节数、摘要、类型、路径、Bundle 归属和依赖列表。
- 使用完整的显式 Bundle 体积统计构建总量；没有完整 Bundle 体积时使用资源字节数合计，并提示口径。
- 给出主要体积增量、多 Bundle 归属、摘要稳定但体积变化，以及依赖变化可能传播的线索。
- 逐项检查证据与潜在反向依赖影响，筛选、搜索、排序和分页。
- 导出 Markdown 审阅报告或 JSON 结构化结果；支持命令行用于 CI。

## 清单格式

```json
{
  "name": "release-1.2",
  "version": "1.2",
  "platform": "Android",
  "assets": [
    {
      "id": "optional-stable-guid",
      "path": "Assets/Textures/hero.png",
      "size": 1048576,
      "hash": "content-hash",
      "bundle": "characters",
      "dependencies": ["Assets/Materials/hero.mat"],
      "type": "Texture"
    }
  ],
  "bundles": [{ "name": "characters", "size": 800000, "hash": "bundle-hash" }]
}
```

`assets` 和每项 `path` 必填。其余字段可省略，缺失体积会标为未知；`size` 单位固定为字节，别名支持 `byteSize` 和 `sizeBytes`。可使用 `bundles: ["a", "b"]` 描述多个 Bundle 归属。依赖可以填写资源路径或 ID。JSON 顶层资源数组也受支持。

资源中的 `bundles` 表示归属列表；顶层 `bundles` 是 Bundle 输出记录，记录中 `name` 必填，`size` 和 `hash` 可省略。总量只有在所有记录的 Bundle 都有显式且已知的体积时才使用 Bundle 体积合计；请确保清单覆盖需要比较的全部输出。

前后构建应保持 `id` 的提供方式一致。若同一路径在一份清单中有独立 ID，另一份没有，将被识别为移除和新增，不会回退到路径匹配。稳定 ID 相同而路径变化时可识别重命名。

CSV 的表头必须有 `path`；常用表头为 `path,size,hash,bundle,dependencies,type`。多个 Bundle、依赖用分号分隔；包含逗号或换行的字段用双引号包裹，内部双引号写为两个双引号。参见 `examples/resources.csv`。

重复 ID/路径、重复 Bundle 名、负体积及非有限体积会拒绝导入；路径统一斜杠，折叠重复斜杠、去除开头的 `./`，保留大小写。页面每份文件或粘贴内容限制 20 × 1024² 字节；命令行没有这项固定限制，输入规模受可用内存约束。

## 命令行

```powershell
node cli.mjs --before examples/baseline.json --after examples/current.json --out reports.md
node cli.mjs --before examples/baseline.json --after examples/current.json --format json --out result.json
```

省略 `--out` 输出到标准输出。`--format` 默认 `md`；参数或解析错误退出码为 1。脚本是只读分析，不访问清单路径或依赖地址。

`--out` 会写入指定路径，父目录必须已存在；输出路径若已有文件会覆盖。`--help` 或 `-h` 显示用法。JSON 结果包含 `before`、`after`、`summary`、`changes`、`bundles`、`insights` 和 `warnings`，可用于 CI 后续处理；检测到资源变化本身不会返回失败退出码，需要自行设置体积或数量阈值。

运行附带示例应得到：Bundle 总量 127,926,272 → 150,994,944 字节，增长 23,068,672 字节（界面显示 `+22 MB`）；新增 3、移除 2、修改 7、未变 8。界面的 KB/MB 等标签按 1024 进制换算。

## 解释边界

“已确认”表示清单里观察到的事实，“可能原因”表示需要结合构建日志验证的关联。依赖影响是前后清单关系图的并集，不代表已实际重新构建；每项最多展示按标识排序的前 30 个影响资源。无法解析到清单资源的依赖和自引用不参与图遍历。

Bundle 压缩体积不能按资源字节数直接分摊。多包归属不能单独证明物理复制或可节省的下载量。缺失 hash 时无法确认内容变化；相同 hash 配合不同体积可能由设置、口径或摘要语义差异造成，不能直接断言内容一致。

两份清单都填写了 `platform` 且值不同、总量口径不同，或总量不完整时，不计算总量差值和增长率；缺少平台字段时会给出提示，但不阻止比较。零基线不产生无穷百分比。请保证前后清单的构建设置和字段定义一致。

这是通用清单解释器；原生 Unity Addressables Build Layout、Unreal cook 日志等格式需要先通过构建脚本转换。本版本不直接读取原生引擎报告，也不自动检测实际压缩算法或增量下载体积。

## 项目结构

| 路径 | 用途 |
| --- | --- |
| `public/` | 本地网页界面和样式 |
| `lib/importers.mjs` | JSON/CSV 解析与输入校验 |
| `lib/analyzer.mjs` | 对比、依赖分析与 Markdown 报告 |
| `cli.mjs` | 命令行入口 |
| `server.mjs`、`start.cmd` | 本地服务器与 Windows 启动脚本 |
| `examples/` | 演示 JSON/CSV 清单 |
| `tests/` | 分析器和命令行测试 |
| `artifacts/preview.jpg` | 演示界面截图 |

`reports/`、示例输出文件和本地依赖目录由 Git 忽略，不上传到仓库。

## 验证

```powershell
npm test
```

测试覆盖导入异常、CSV 引号、多种变化、Bundle 总量、缺失字段、口径差异、稳定 ID 重命名、依赖环和报告输出。

本项目复用现有 Node.js，不安装共享工具。后续新增共享开发工具按项目约定安装到 `D:\Program Files\工具名\版本`。
