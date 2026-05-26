# ScriptBox

一个收纳实用脚本的小项目。当前包含夸克网盘网页端的 Tampermonkey 批量重命名脚本，后续可以继续补充更多浏览器脚本、自动化脚本和小工具。

当前首个脚本是由 Codex 和 travisoa 共同完成的油猴脚本，用于夸克网盘批量整理视频文件名的实际工作流。

## 脚本

### Quark Batch Rename Helper

路径：`userscripts/quark-batch-rename.user.js`

- 右上角机器人图标入口，点击后展开批量重命名面板
- 支持已勾选可见视频、当前目录全部视频等文件来源
- 支持添加前缀、正则替换、删除英文剧名、整理为 `剧名.SxxExx`
- 执行前可预览新旧文件名
- 输入框默认只显示灰色示例，不会把示例当作实际规则

## 安装

1. 安装 Tampermonkey。
2. 打开脚本 raw 地址：
   `https://raw.githubusercontent.com/travisoa/scriptbox/main/userscripts/quark-batch-rename.user.js`
3. 在 Tampermonkey 安装页点击安装或更新。
4. 打开 `https://pan.quark.cn/`，页面右上角会出现机器人图标。

## 使用

1. 在夸克网盘文件列表中勾选要处理的视频，或选择当前目录全部视频。
2. 点击机器人图标展开面板。
3. 选择重命名规则并填写参数。
4. 点击读取、预览，确认无误后执行。

## 注意

- 脚本只匹配 `https://pan.quark.cn/*`。
- 批量执行前请先预览，确认文件名符合预期。
- 夸克网盘接口或页面结构变动时，脚本可能需要同步更新。
