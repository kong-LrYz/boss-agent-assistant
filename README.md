# BOSS 投递助手

**选岗位、选地区，点击开始，自动打招呼并发送 BOSS 已有附件简历。**

在自己的电脑运行，默认搜索 **AI Agent**。支持实习、应届／校招、正式社招；运行后持续寻找岗位，点击停止或关闭控制台就停止。

## 快速开始

1. [下载项目 ZIP](https://github.com/kong-LrYz/boss-agent-assistant/archive/refs/heads/main.zip) 并解压。
2. 运行对应的安装入口：

   | 系统 | 首次安装 | 以后启动 |
   | --- | --- | --- |
   | macOS | 双击 `安装.command` | 双击 `启动.command` |
   | Windows | 双击 `install.cmd` | 双击 `start.cmd` |
   | Linux 桌面 | `sh install.sh` | `sh start.sh` |

3. 首次展开控制台的 **浏览器连接**，点击 **打开扩展管理**，按提示加载项目的 `extension/` 扩展并配对；再点击 **打开浏览器 / 扫码登录**，在专用 Chrome 中登录 BOSS。
4. 选择或输入 **目标岗位**，再选 **地区、岗位类型**，点击 **开始投递**。

第一次需要本人安装浏览器扩展、扫码登录。完成后无需重复配对；默认在之后启动程序时自动继续。可在高级设置改为每次手动开始。

安装入口会准备 Node.js 和锁定依赖。已有 Node.js 22 或更新版会直接复用；否则下载官方 Node.js 22.23.3 并校验 SHA256，保存在项目 `.runtime/`，无需管理员权限。没有 Google Chrome 时会提示安装并打开官方下载页，安装后重跑即可。

支持 macOS 和 Windows 的 x64／arm64，以及有图形界面的 Linux x64。Linux ARM64 可以准备 Node，但没有 Google Chrome 官方桌面包，当前不支持实际投递。

## 隐私

登录目录、个人设置和投递进度保存在各自机器的 `data/`；诊断截图可能含网页信息，保存在本机 `output/`。这些运行资料不上传到本项目服务器。程序没有云端账号服务，不需要 Codex、模型 API 或 API Key。

公开仓库只包含通用源代码、官方公开分类快照、虚构测试数据与说明。`data/`、`output/`、`.runtime/`、`node_modules/`、`.env` 和 `dist/` 已忽略；不要手动上传这些目录，也不要在 Issue 中贴出 Cookie、二维码、姓名、电话、简历或聊天截图。

岗位列表源于 [BOSS 官方网站](https://www.zhipin.com/)，城市快照源于网站正常城市选择器的公开地理元数据，随源码固定保存。程序运行时通过普通 Chrome 扩展操作页面，网站改版后可能需要更新适配。

许可证：[MIT](LICENSE)。
