# ScriptBox

一个收纳实用脚本的小项目，主要放 Tampermonkey 浏览器脚本、网页自动化脚本和日常小工具。

## 脚本列表

| 脚本 | 文件 | 适用页面 | 用途 |
| --- | --- | --- | --- |
| Autohome Config Export（汽车之家配置导出） | `userscripts/autohome-config-export.user.js` | `https://*.autohome.com.cn/config/*`、`https://*.autohome.com.cn/spec/*` | 把汽车之家车型参数配置页导出为 Excel |
| Quark Batch Rename Helper | `userscripts/quark-batch-rename.user.js` | `https://pan.quark.cn/*` | 在夸克网盘网页端批量整理视频文件名 |
| 夸克网盘批量云解压 | `userscripts/quark-cloud-unzip.user.js` | `https://pan.quark.cn/list*` | 批量提交云解压任务，并跳过目标目录中的已有文件夹 |

## 安装

1. 安装 Tampermonkey。
2. 打开要安装的脚本 raw 地址。
3. 在 Tampermonkey 安装页点击安装或更新。
4. 刷新对应网站页面，右下角会出现脚本浮动入口。

脚本 raw 地址：

| 脚本 | 安装地址 |
| --- | --- |
| 汽车之家配置导出 | `https://raw.githubusercontent.com/travisoa/scriptbox/main/userscripts/autohome-config-export.user.js` |
| 夸克批量重命名 | `https://raw.githubusercontent.com/travisoa/scriptbox/main/userscripts/quark-batch-rename.user.js` |
| 夸克批量云解压 | `https://raw.githubusercontent.com/travisoa/scriptbox/main/userscripts/quark-cloud-unzip.user.js` |

更新脚本时，需要把脚本头部的 `@version` 改成更大的版本号，否则 Tampermonkey 可能不会自动拉取新版本。

## Autohome Config Export

路径：`userscripts/autohome-config-export.user.js`

### 功能

- 适用于汽车之家车型「参数配置」页，兼容旧版 `car.` 域名页面和新版 `www.` 域名 Next.js 页面。
- 右下角浮动入口可拖拽，点击后展开导出面板。
- 自动识别页面中的车型列和配置分类，例如基本参数、车身、电动机、电池/充电、主动安全、座椅配置、颜色、选装包等。
- 支持勾选配置分类后导出，也支持一键导出全部分类。
- 支持两种 Excel 排版：
  - `合并一页`：默认模式，所有分类汇总到一个工作表，用「【分类名】」分隔。
  - `分表(每类一页)`：每个配置分类单独生成一个工作表。
- 支持按车型分组导出。只有当页面筛选项或配置数据里存在多个可区分取值时，下拉框才会出现可用分组选项，例如能源类型、驱动形式、年款等。
- 自动剔除 `计算器`、`询底价`、`参数纠错` 等页面操作文字。
- 自动还原汽车之家用 CSS 隐藏的配置文字，并导出 `●`（标配）、`○`（选装）、`-`（无）等符号。
- 新版页面配置异步加载时，面板展开后会自动等待数据出现；车系之间 SPA 跳转后也会重新识别。
- 依赖 SheetJS，脚本头已通过 `@require` 自动加载，无需手动安装。

### 使用

1. 打开汽车之家车型参数配置页，例如 `https://www.autohome.com.cn/config/series/6651.html`。
2. 点击右下角「配置导出」浮动入口。
3. 确认面板顶部显示的车系、车型数和分类数。
4. 按需勾选配置分类。
5. 选择导出排版：`合并一页` 或 `分表(每类一页)`。
6. 如有可用分组选项，可在「按车型分组」下拉框中选择分组维度。
7. 点击「导出所选分类」或「一键导出全部」。

导出文件名形如：

```text
MG4_配置参数_20260531.xlsx
昂科威Plus_配置参数_20260531.xlsx
```

### 实测记录

在 `https://www.autohome.com.cn/config/series/6651.html` 的 MG4 配置页上实测：

- 识别结果：`MG4 · 车型 11 款 · 分类 25 个`
- 导出文件：`MG4_配置参数_20260531.xlsx`
- Excel 结构：1 个工作表 `MG4配置`，共 239 行、12 列（参数列 + 11 款车型列）
- `能源类型`、`CLTC纯电续航里程(km)`、`驱动方式` 等关键行导出正常
- 外观颜色、内饰颜色在该页面可导出文字配置

### 注意

- 汽车之家页面结构经常调整，若浮动入口不出现、车型数为 0、分类数异常，通常需要同步更新选择器。
- 分组选项不是固定出现的。若当前页面所有车型在能源、驱动、年款等维度上没有差异，或页面筛选区没有对应信息，则只显示「不分组」。
- 外观颜色、内饰颜色等行是否有值取决于页面是否提供可读文字；如果页面只用图片或色块表达，可能无法完整导出。
- 导出结果仅来自页面当前展示数据，正式使用前建议抽查 Excel 与网页原表是否一致。

## Quark Batch Rename Helper

路径：`userscripts/quark-batch-rename.user.js`

### 功能

- 右下角浮动图标入口可拖拽，点击后展开批量重命名面板。
- 支持已勾选可见视频、当前目录全部视频等文件来源。
- 支持添加前缀、正则替换、删除英文剧名、中文集数转 `SxxExx`、整理为 `剧名.SxxExx`。
- 执行前可预览新旧文件名。
- 输入框默认只显示灰色示例，不会把示例当作实际规则。
- 悬浮图标可以替换为自定义图标，详见「更换夸克脚本悬浮图标」。

### 使用

1. 打开 `https://pan.quark.cn/`。
2. 在文件列表中勾选要处理的视频，或选择当前目录全部视频。
3. 点击浮动图标展开面板。
4. 选择重命名规则并填写参数。
5. 点击读取、预览，确认无误后执行。

### 使用示例：把 `第1集` 改成 `S01E01`

适合这类文件名：

- `庆余年第1集国语版.mp4`
- `庆余年第01集国语版.mp4`
- `庆余年第12集国语版.mp4`

目标效果：

- `庆余年S01E01国语版.mp4`
- `庆余年S01E12国语版.mp4`

操作方法：

1. 选择操作：`中文集数转 SxxExx`
2. 季号填写：`1`
3. 点击 `读取`、`预览`，确认 `第1集`、`第01集`、`第12集` 分别变成 `S01E01`、`S01E01`、`S01E12` 后再执行。

如果是第二季，季号填写 `2` 即可。

### 注意

- 脚本只匹配 `https://pan.quark.cn/*`。
- 批量执行前请先预览，确认文件名符合预期。
- 夸克网盘接口或页面结构变动时，脚本可能需要同步更新。

## 夸克网盘批量云解压

路径：`userscripts/quark-cloud-unzip.user.js`

### 功能

- 扫描当前目录中的 ZIP、RAR 和 7Z 压缩包，并逐个提交服务端云解压任务。
- 支持填写目标目录和自定义压缩包匹配规则。
- 可按名称额外跳过压缩包，也可跳过目标目录中已有的同名文件夹。
- 支持中途停止；已提交的云解压任务不会被撤销。
- 提交前校验目标路径回显，降低解压到错误目录的风险。

### 使用

1. 打开夸克网盘文件列表页面。
2. 在右下角面板中填写目标目录，按需调整匹配规则和跳过项。
3. 点击「扫描」确认待处理压缩包数量。
4. 点击「开始云解压」，并根据面板日志检查提交、跳过和失败结果。

### 注意

- 脚本依赖夸克网盘当前网页交互和弹窗结构；页面改版后可能需要更新选择器。
- 批量执行前请先核对目标目录。停止操作只阻止继续提交，不会撤销已提交的任务。

## 更换夸克脚本悬浮图标

图标源文件统一放在 `userscripts/assets/`，仓库自带 `doc-pencil.svg` 和 `flower.svg`。换成自己的图标走以下步骤。

### 1. 把新图标放进 `userscripts/assets/`

```text
userscripts/assets/your-icon.svg
```

- 推荐 SVG，方形 `viewBox`（`0 0 64 64`、`0 0 1024 1024` 都行）。
- 如果是从 iconfont 之类的站下载的 SVG，先把 `<svg>` 标签上写死的 `width="200" height="200"` 等尺寸属性删掉，否则会撑爆 44px 的圆形浮窗。
- PNG/JPG 也行，建议先压到 64 x 64 到 128 x 128 以内。

### 2. 改脚本里的 `ICON_SVG`

打开 `userscripts/quark-batch-rename.user.js`，找到 `ICON_SVG` 常量，整行替换为：

```js
  const ICON_SVG = `<img src="https://raw.githubusercontent.com/travisoa/scriptbox/main/userscripts/assets/your-icon.svg" alt="" style="width:100%;height:100%;display:block;pointer-events:none" />`;
```

要点：

- 使用反引号 `` ` ``，不是单引号 `'` 或双引号 `"`。
- 替换的是 `ICON_SVG = ...;` 这一整行的反引号内容。
- 想离线或减少一次 GitHub 请求，也可以把 svg 文件里的 `<svg>...</svg>` 整段直接粘进反引号。

### 3. 提高版本号并更新

1. 把脚本头部的 `@version` 改成更大的版本号。
2. 提交并推送到 GitHub。
3. 在 Tampermonkey 仪表盘点击检查更新，或重新打开 raw 地址手动更新。

## 维护建议

- 每个脚本尽量保持单文件可安装，脚本头部保留 `@downloadURL` 和 `@updateURL`。
- 新增脚本后，在「脚本列表」和「安装」表格中补上文件路径、匹配页面和 raw 地址。
- 修改脚本行为后，同步更新 README 里的使用说明和注意事项。
