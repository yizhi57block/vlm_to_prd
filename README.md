# 使用 Qwen VLM 分析系统演示视频

脚本会扫描 `videos/` 中的 4 个视频，将每个视频作为一个独立请求发送给 OpenRouter，最后在 `analysis-results/` 中生成 4 份中文 Markdown 分析文档。

## 模型顺序

默认使用 OpenRouter 的单请求模型回退机制：

1. `qwen/qwen3.7-flash`：性价比首选
2. `qwen/qwen3.8-flash`
3. `qwen/qwen3.8-27b`
4. `qwen/qwen3.5-397b-a17b`
5. `qwen/qwen3.8-max-0902`：更稳但更贵的最终备用

OpenRouter 会优先使用第一项。只有当前模型发生错误、限流、不可用或拒绝回复时，才会在同一个请求内尝试后续模型。正常执行共发送 4 个请求，每个视频一个。

> 模型列表和价格会变化。运行前可在 OpenRouter Models 页面确认这些模型仍支持 `video` 输入。

## 安装与配置

需要 Node.js 20 或更高版本。

```bash
npm install
cp .env.example .env
```

编辑 `.env` 并填写：

```dotenv
OPENROUTER_API_KEY=sk-or-v1-your-key-here
```

先检查文件与配置，不产生 API 费用：

```bash
npm run analyze -- --dry-run
```

正式分析：

```bash
npm run analyze
```

## 输出

成功后会生成：

```text
analysis-results/
├── 运营工单 - 1-分析.md
├── 运营工单 - 2-分析.md
├── 执行工单 - 1-分析.md
└── 执行工单 - 2-分析.md
```

每份文档都包含实际使用的模型、OpenRouter 请求 ID、token 用量、API 返回费用以及模型的完整分析结果。

某一个视频失败不会阻止后续视频；脚本会继续处理并最终以非零状态退出。已成功生成的文档会保留。

## 自定义模型

通过逗号分隔的模型 ID 覆盖默认顺序：

```dotenv
OPENROUTER_MODELS=qwen/qwen3.7-flash,qwen/qwen3.8-max-0902
```

如果只想固定使用一个模型：

```dotenv
OPENROUTER_MODELS=qwen/qwen3.8-flash
```

## 客户数据隐私

本地视频会被编码为 base64，并通过 OpenRouter 发送给最终模型 provider。发送客户录像前，应确认已获得授权并满足公司的数据处理要求。

如需强制只使用支持 Zero Data Retention 的 provider，可设置：

```dotenv
REQUIRE_ZDR=1
```

这可能减少可用 provider；如果候选模型没有 ZDR endpoint，请求会失败。
