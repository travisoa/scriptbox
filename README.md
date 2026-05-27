# ScriptBox

一个收纳实用脚本的小项目。当前包含夸克网盘网页端的 Tampermonkey 批量重命名脚本，后续可以继续补充更多浏览器脚本、自动化脚本和小工具。

当前首个脚本是由 Codex 和 travisoa 共同完成的油猴脚本，用于夸克网盘批量整理视频文件名的实际工作流。

## 脚本

### Quark Batch Rename Helper

路径：`userscripts/quark-batch-rename.user.js`

- 右下角浮动图标入口（可自由拖拽），点击后展开批量重命名面板
- 支持已勾选可见视频、当前目录全部视频等文件来源
- 支持添加前缀、正则替换、删除英文剧名、中文集数转 `SxxExx`、整理为 `剧名.SxxExx`
- 执行前可预览新旧文件名
- 输入框默认只显示灰色示例，不会把示例当作实际规则
- 悬浮图标可以替换为自定义图标，详见下方"更换悬浮图标"

## 安装

1. 安装 Tampermonkey。
2. 打开脚本 raw 地址：
   `https://raw.githubusercontent.com/travisoa/scriptbox/main/userscripts/quark-batch-rename.user.js`
3. 在 Tampermonkey 安装页点击安装或更新。
4. 打开 `https://pan.quark.cn/`，页面右下角会出现浮动图标。

## 使用

1. 在夸克网盘文件列表中勾选要处理的视频，或选择当前目录全部视频。
2. 点击浮动图标展开面板。
3. 选择重命名规则并填写参数。
4. 点击读取、预览，确认无误后执行。

## 使用示例

### 把 `第1集` 改成 `S01E01`

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

## 更换悬浮图标

图标源文件统一放在 `userscripts/assets/`，仓库自带 `doc-pencil.svg` 和 `flower.svg`，默认使用 `flower.svg`。换成自己的图标走以下五步。

### 1. 把新图标放进 `userscripts/assets/`

```
userscripts/assets/your-icon.svg     # 也支持 .png / .jpg
```

- 推荐 SVG，方形 `viewBox`（`0 0 64 64`、`0 0 1024 1024` 都行）。
- 如果是从 iconfont 之类的站下载的 SVG，**先把 `<svg>` 标签上写死的 `width="200" height="200"` 等尺寸属性删掉**，否则会撑爆 44px 的圆形浮窗。
- PNG/JPG 也行，建议先压到 64×64 ~ 128×128 以内。

### 2. 改脚本里的 `ICON_SVG`

打开 `userscripts/quark-batch-rename.user.js`，找到第 26 行的 `ICON_SVG` 常量，**整行替换**为：

```js
  const ICON_SVG = `<img src="https://raw.githubusercontent.com/travisoa/scriptbox/main/userscripts/assets/your-icon.svg" alt="" style="width:100%;height:100%;display:block;pointer-events:none" />`;
```

要点：

- 用**反引号** `` ` ``（键盘左上角 `~` 那个键），不是单引号 `'` 或双引号 `"`。
- 替换的是 `ICON_SVG = ...;` 这一整行的反引号内容；不要去改 `<svg xmlns="...">` 的 `xmlns` 属性 —— `xmlns` 是 XML 命名空间，跟图片源没有任何关系。
- 想离线/不依赖网络，也可以把 svg 文件里的 `<svg>...</svg>` 整段直接粘进反引号，省一次 GitHub 请求。

### 3. 把 `@version` 往后加一位

第 4 行的 `// @version 0.x.x` 改成更大的版本号（如 `0.2.2 → 0.2.3`），否则 Tampermonkey 不会认为有新版本，自动更新跳过。

### 4. push 到 GitHub

```bash
git add userscripts/
git commit -m "Swap floating icon to your-icon"
git push
```

### 5. 让 Tampermonkey 拉到新版本

两种方式任选其一：

- **自动**：等 Tampermonkey 下次 poll `@updateURL`（默认每天一次），或在 Tampermonkey 仪表盘里点"检查更新"。
- **手动立刻生效**：浏览器直接打开
  `https://raw.githubusercontent.com/travisoa/scriptbox/main/userscripts/quark-batch-rename.user.js`，
  Tampermonkey 会弹出更新确认页面，点"重新安装"。

确认更新后刷新夸克网盘页面，右下角的浮动图标就变成新图了。

## 注意

- 脚本只匹配 `https://pan.quark.cn/*`。
- 批量执行前请先预览，确认文件名符合预期。
- 夸克网盘接口或页面结构变动时，脚本可能需要同步更新。
