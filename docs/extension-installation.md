# 普通 Chrome 的一次性安装与权限

扩展源码在本项目 `extension/` 目录，Chrome 管理页为 `chrome://extensions/`。开启开发者模式后选择“加载已解压的扩展”，加载该目录。使用本程序打开的专用 Chrome，避免连接到其他人的 BOSS 账号或日常浏览器配置。

“打开扩展管理”在某些 Chrome 启动方式下只会显示新标签页。在该专用浏览器地址栏输入 `chrome://extensions/` 即可继续；新标签页不是登录或扩展安装成功的证据。

本项目扩展尚未上架商店，需要本人确认本地源码与页面访问权限。清单可查看 `extension/manifest.json`：

- `storage`：保存本机配对状态，凭据只允许扩展可信后台与界面读取。
- `alarms`：后台被 Chrome 休眠后恢复本地连接。
- `https://www.zhipin.com/*`：读取岗位、确认目标会话，按任务操作网页控件。
- `http://127.0.0.1/*`：连接同一电脑上的 Node 控制台，真实网页不能直接发扩展指令。

没有 Cookie、浏览历史、任意网站、浏览器调试、网络拦截或本地文件读取权限。没有验证码破解或 trusted 事件伪造。扩展安装并不表示 BOSS 允许自动化，也不保证不会被限制。

打开扩展弹窗（名称“本地 BOSS 岗位助手”），填写本地控制台地址和控制台给出的配对码，点击连接。配对码一次使用；以后启动专用 Chrome 和本地程序时会自动恢复连接。先在控制台运行预览，真实网页结构、账号及岗位能确认后，再验证招呼和附件结果。

Chrome 137 起移除了普通 Chrome 的命令行侧载旗标，程序不会使用该旗标或通过更换安全设置绕过安装步骤。安装后无需打开 DevTools。参考：[官方本地加载步骤](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked)、[官方说明](https://developer.chrome.com/blog/extension-news-june-2025)。
