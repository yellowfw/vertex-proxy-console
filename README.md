# Vertex Proxy Console

在 Windows 本地运行一个 OpenAI 兼容的转发服务，把 SillyTavern 等工具的请求转发到 **Google Vertex AI**（Gemini 3 / 4）。带桌面控制台：状态、日志、Token 倒计时、用量统计、一键启停。

> 适合已经拥有 Google Cloud 项目、想用 Gemini 作为酒馆主模型的用户。
> 本项目**不提供**任何账号、额度或代理节点。

---

## 功能

- **零依赖运行**：安装包自带运行时，不需要单独装 Node.js
- **桌面控制台**：状态灯、实时日志（SSE）、模型列表、Token 倒计时与手动刷新
- **请求统计**：请求数、流式数、错误数、输入/输出 tokens、缓存命中
- **流式输出**：完整支持 `stream: true`
- **上下文缓存**：system 超过 4096 tokens 时可复用 Vertex 显式缓存（省 75% 输入成本）
- **托盘常驻**：关窗不退出，代理继续工作
- **配置界面**：SA 文件、端口、上游代理、区域，全部在界面里设置
- **单实例**：重复启动只会聚焦已有窗口

## 快速开始

### 方式一：安装包（推荐）

1. 从 [Releases](../../releases) 下载 `VertexProxy-Setup-x.y.z.exe`
2. 双击安装。安装包未做数字签名，SmartScreen 提示时点「更多信息 → 仍要运行」
3. 启动后会自动打开设置页，按下方「首次配置」操作

### 方式二：从源码运行

```bash
git clone <this-repo>
cd vertex-proxy-console
npm install
npm start
```

需要 Node.js 20+。国内网络建议先设置镜像：

```bash
npm config set registry https://registry.npmmirror.com
```

## 首次配置

### 1. 准备 Google Cloud

1. 在 [Google Cloud Console](https://console.cloud.google.com/) 创建项目
2. 启用 **Vertex AI API**
3. 项目需绑定结算账号（Vertex AI 按量计费，不是免费额度）

### 2. 创建服务账户密钥

1. 控制台 → IAM 与管理 → 服务账户 → 创建服务账户
2. 授予角色：**Vertex AI User**（`roles/aiplatform.user`）
3. 进入该服务账户 → 密钥 → 添加密钥 → 创建新密钥 → JSON
4. 下载得到 `xxxx.json`，这就是程序需要的 **SA 文件**

### 3. 在应用里配置

1. 启动程序，自动进入「设置」
2. 选择刚才下载的 SA 文件（会立即校验并显示项目 ID）
3. 端口默认 `8318`
4. 上游代理按需填写（例如 `127.0.0.1:7897`）——能直连 Google 就取消勾选
5. 「测试上游」确认端口可达
6. 「保存并启动」

配置保存在 `%APPDATA%\vertex-proxy-console\vertex_proxy.config.json`，**不会**写入安装目录，也不会被提交到仓库。

## 在酒馆里使用

| 字段 | 值 |
|---|---|
| 来源 | 自定义（兼容 OpenAI） |
| Base URL | `http://127.0.0.1:8318/v1` |
| API Key | 随便填 |
| 模型 | `gemini-3.8-flash`、`gemini-4-hydrogen` 等，见控制台模型列表 |

## 打包

```bash
npm install
npm run dist
```

产物输出到 `dist/`（可在 `package.json` 的 `build.directories.output` 修改）。
安装器为 NSIS，未签名。

## 项目结构

```
vertex-proxy-console/
├── main.js                      Electron 主进程（托管代理、托盘、设置读写）
├── preload.js                   contextBridge 桥接
├── index.html                   启动页
├── settings.html                配置页
├── assets/                      图标
└── proxy/
    ├── vertex_proxy.js          Vertex 转发核心（OAuth、SSE、缓存）
    └── vertex_proxy_admin.html  控制台页面（由代理在 /admin 提供）
```

主进程以 `ELECTRON_RUN_AS_NODE=1` 方式启动 `proxy/vertex_proxy.js`，因此打包后不需要独立的 Node 运行时。

## 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `VERTEX_PORT` | 监听端口 | `8318` |
| `VERTEX_SA` | 服务账户 JSON 路径 | 空（必须提供） |
| `VERTEX_LOCATION` | 区域 | `global` |
| `VERTEX_PROXY_HOST` | 上游代理地址 | `127.0.0.1` |
| `VERTEX_PROXY_PORT` | 上游代理端口 | `7897` |
| `VERTEX_NO_PROXY` | 设为 `1` 时直连 | 未设置 |
| `VERTEX_CACHE` | 设为 `1` 启用显式上下文缓存 | 未设置 |

## 常见问题

**Q：提示「Windows 已保护你的电脑」？**
安装包未签名，属正常现象。点「更多信息 → 仍要运行」。

**Q：报 `429 Resource exhausted`？**
Vertex 的分钟级配额限流。等待 1–2 分钟，或换用配额更宽松的模型（如 `gemini-3.8-flash`）。

**Q：端口 8318 被占用？**
设置页换一个端口，酒馆里的 Base URL 同步修改。

**Q：连不上 Google？**
先在设置页点「测试上游」，确认代理软件正在运行且节点可用；再看控制台日志里的错误码。

**Q：`socket hang up`？**
上游代理节点不稳定，换节点后重启代理即可。

## 免责声明

- 本项目不提供任何 Google 账号、API 额度或网络代理服务
- 使用产生的费用由你自己的 Google Cloud 账号承担
- 请遵守 [Google Cloud 服务条款](https://cloud.google.com/terms) 及所在地区的法律法规
- 本项目仅供学习与技术研究使用，使用者自行承担全部责任

## License

[MIT](LICENSE)