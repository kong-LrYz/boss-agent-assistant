# 程序结构

生产路径是本机 Node 服务 → 已配对的 MV3 扩展 → 专用普通 Chrome → BOSS 网页。

- `core.js`／`job-presets.js`：岗位与地区筛选、岗位类型、目标默认搜索规则。
- `catalogs.js`／分类 JSON：BOSS 公开岗位与地区快照。
- `store.js`：本机配置、发送意图、进度和日志。动作先落盘意图，回执确认后才记成功。
- `runner.js`：连续扫描、数量目标、待发附件、单岗隔离、全局停止及恢复。
- `extension-bridge.js`／`extension-browser.js`：配对、本机认证、固定操作、一次许可和严格会话绑定。
- `extension/`：标准 DOM 页面操作、当前文档与实际收件人校验；不接受任意脚本或私有 API 请求。
- `server.js`／`main.js`：仅回环地址服务、同源认证、进程锁与控制台关闭停止。
- `public/`：原生选择框、运行状态、折叠高级设置、进度和手动核对。
- `scripts/install*`：官方 Node 下载校验、独立运行时和锁定依赖安装。

同岗位未知结果不会自动重发。单岗错误可以跳过，账号登录、验证码、实际限流和连接状态单独处理。详细验证见 [验证范围](verification.md)。
