import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { extname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenRouter } from "@openrouter/sdk";
import type { ChatResult } from "@openrouter/sdk/models";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

try {
  process.loadEnvFile(join(PROJECT_ROOT, ".env"));
} catch (error) {
  if (
    !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )
  ) {
    throw error;
  }
}

const VIDEO_DIR = resolve(
  PROJECT_ROOT,
  process.env.VIDEO_DIR ?? "videos",
);
const OUTPUT_DIR = resolve(
  PROJECT_ROOT,
  process.env.OUTPUT_DIR ?? "analysis-results",
);

const DEFAULT_MODELS = [
  // 性价比首选
  "qwen/qwen3.7-flash",
  "qwen/qwen3.8-flash",
  // 更稳的产品理解
  "qwen/qwen3.8-27b",
  "qwen/qwen3.5-397b-a17b",
  "qwen/qwen3.8-max-0902",
];

const MODELS = (process.env.OPENROUTER_MODELS?.split(",") ?? DEFAULT_MODELS)
  .map((model) => model.trim())
  .filter(Boolean);

const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS ?? 12_000);
const REQUEST_TIMEOUT_MS = Number(
  process.env.REQUEST_TIMEOUT_MS ?? 30 * 60 * 1_000,
);
const REQUIRE_ZDR = process.env.REQUIRE_ZDR === "1";
const DRY_RUN = process.argv.includes("--dry-run");
const SUPPORTED_VIDEO_EXTENSIONS = new Set([".mp4", ".mpeg", ".mov", ".webm"]);

const ANALYSIS_PROMPT = `你是一名资深 SaaS 产品经理和业务分析师。

附件是用户向我们演示其现有业务系统的操作录像。

你的任务不是简单总结视频，而是通过用户的实际操作，
逆向分析这个系统的产品功能、页面结构和业务流程。

请分析当前这个视频，并记录关键操作发生的时间戳。时间戳请使用 HH:MM:SS 格式；若只能估算，请明确标注“约”。

对于当前视频，请输出：

1. 用户进入了哪些页面/模块
2. 每个页面的名称
3. 页面中存在的主要功能
4. 用户执行了哪些操作
5. 每个操作的输入和输出
6. 页面中出现的重要字段、按钮、菜单、Tab、筛选条件
7. 推测该功能解决的业务问题
8. 用户完成的一整套业务流程
9. 视频中明确展示的功能
10. 你推测存在、但视频没有充分证明的功能

特别注意：
不要因为常见 SaaS 系统通常具备某个功能，就认为该系统一定存在。
必须区分：

【视频明确看到】
【根据操作合理推断】
【无法确认】

最后输出：

A. 系统模块清单
B. 功能清单
C. 页面清单
D. 核心业务流程
E. 关键业务实体
F. 系统整体功能架构
G. 仍需要向客户确认的问题

输出要求：
- 使用中文 Markdown。
- 尽量引用可见的页面名称、字段名称和按钮文字，不要自行改写成通用术语。
- 每个关键操作都尽可能附带时间戳。
- 结论必须标注证据等级：【视频明确看到】、【根据操作合理推断】或【无法确认】。
- 不要混入其他视频的内容。`;

type Usage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cost?: number | null;
  videoTokens?: number;
};

function assertConfiguration(): string {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();

  if (!DRY_RUN && !apiKey) {
    throw new Error(
      "缺少 OPENROUTER_API_KEY。请设置环境变量后重试；可先使用 --dry-run 检查配置。",
    );
  }
  if (MODELS.length === 0) {
    throw new Error("OPENROUTER_MODELS 中至少需要配置一个模型。");
  }
  if (!Number.isInteger(MAX_OUTPUT_TOKENS) || MAX_OUTPUT_TOKENS <= 0) {
    throw new Error("MAX_OUTPUT_TOKENS 必须是正整数。");
  }
  if (!Number.isFinite(REQUEST_TIMEOUT_MS) || REQUEST_TIMEOUT_MS <= 0) {
    throw new Error("REQUEST_TIMEOUT_MS 必须是正数。");
  }

  return apiKey ?? "";
}

async function findVideos(): Promise<string[]> {
  const entries = await readdir(VIDEO_DIR, { withFileTypes: true });
  const videos = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        SUPPORTED_VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase()),
    )
    .map((entry) => join(VIDEO_DIR, entry.name))
    .sort((a, b) => a.localeCompare(b, "zh-CN"));

  if (videos.length !== 4) {
    throw new Error(
      `期望在 ${VIDEO_DIR} 中找到 4 个视频，实际找到 ${videos.length} 个。为避免产生意外费用，已停止。`,
    );
  }

  return videos;
}

function mimeTypeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".mp4":
      return "video/mp4";
    case ".mpeg":
      return "video/mpeg";
    case ".mov":
      return "video/mov";
    case ".webm":
      return "video/webm";
    default:
      throw new Error(`不支持的视频格式：${path}`);
  }
}

async function toDataUrl(path: string): Promise<string> {
  const data = await readFile(path);
  return `data:${mimeTypeFor(path)};base64,${data.toString("base64")}`;
}

function extractResponseText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (
        part &&
        typeof part === "object" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function usageFrom(response: {
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cost?: number | null;
    promptTokensDetails?: { videoTokens?: number } | null;
  };
}): Usage {
  return {
    promptTokens: response.usage?.promptTokens,
    completionTokens: response.usage?.completionTokens,
    totalTokens: response.usage?.totalTokens,
    cost: response.usage?.cost,
    videoTokens: response.usage?.promptTokensDetails?.videoTokens,
  };
}

function formatDocument(input: {
  videoName: string;
  model: string;
  requestId: string;
  usage: Usage;
  analysis: string;
}): string {
  const cost =
    typeof input.usage.cost === "number"
      ? `$${input.usage.cost.toFixed(6)}`
      : "API 未返回";

  return `# ${parse(input.videoName).name}：系统分析

> 来源视频：${input.videoName}
>
> 实际模型：${input.model}
>
> OpenRouter 请求 ID：${input.requestId}
>
> 生成时间：${new Date().toISOString()}
>
> Token：输入 ${input.usage.promptTokens ?? "未知"} / 视频 ${input.usage.videoTokens ?? "未知"} / 输出 ${input.usage.completionTokens ?? "未知"} / 总计 ${input.usage.totalTokens ?? "未知"}
>
> 本次费用：${cost}

${input.analysis}
`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const status =
      "statusCode" in error && typeof error.statusCode === "number"
        ? `HTTP ${error.statusCode}: `
        : "";
    return `${status}${error.message}`;
  }
  return String(error);
}

async function analyzeVideo(
  client: OpenRouter,
  videoPath: string,
): Promise<void> {
  const videoName = parse(videoPath).base;
  const outputPath = join(
    OUTPUT_DIR,
    `${parse(videoName).name.replaceAll("/", "-")}-分析.md`,
  );

  console.log(`\n[开始] ${videoName}`);
  const videoUrl = await toDataUrl(videoPath);
  const prompt = `${ANALYSIS_PROMPT}\n\n当前视频文件名：${videoName}`;

  const response = await client.chat.send(
    {
      chatRequest: {
        models: MODELS,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "video_url",
                videoUrl: {
                  url: videoUrl,
                },
              },
            ],
          },
        ],
        maxCompletionTokens: MAX_OUTPUT_TOKENS,
        temperature: 0.1,
        provider: REQUIRE_ZDR ? { zdr: true } : undefined,
        stream: false,
      },
      appTitle: "SaaS Video Journey Analyzer",
    },
    {
      timeoutMs: REQUEST_TIMEOUT_MS,
    },
  );

  if (Symbol.asyncIterator in Object(response)) {
    throw new Error("收到流式响应，但脚本请求的是非流式响应。");
  }
  const result = response as ChatResult;

  const analysis = extractResponseText(result.choices[0]?.message.content);
  if (!analysis) {
    throw new Error("模型返回成功，但没有可写入的文本内容。");
  }

  const document = formatDocument({
    videoName,
    model: result.model,
    requestId: result.id,
    usage: usageFrom(result),
    analysis,
  });
  await writeFile(outputPath, document, "utf8");

  const usage = usageFrom(result);
  const cost =
    typeof usage.cost === "number" ? `$${usage.cost.toFixed(6)}` : "未知";
  console.log(`[完成] ${outputPath}`);
  console.log(
    `       模型=${result.model} tokens=${usage.totalTokens ?? "未知"} cost=${cost}`,
  );
}

async function main(): Promise<void> {
  const apiKey = assertConfiguration();
  const videos = await findVideos();

  console.log(`视频目录：${VIDEO_DIR}`);
  console.log(`输出目录：${OUTPUT_DIR}`);
  console.log(`视频数量：${videos.length}`);
  console.log(`模型顺序：${MODELS.join(" -> ")}`);
  console.log(`仅使用 ZDR provider：${REQUIRE_ZDR ? "是" : "否"}`);

  if (DRY_RUN) {
    for (const [index, video] of videos.entries()) {
      const bytes = (await readFile(video)).byteLength;
      console.log(
        `${index + 1}. ${parse(video).base} (${(bytes / 1024 / 1024).toFixed(2)} MiB)`,
      );
    }
    console.log("\nDry run 完成：没有发出 API 请求，也没有创建总结文档。");
    return;
  }

  await mkdir(OUTPUT_DIR, { recursive: true });
  const client = new OpenRouter({ apiKey });
  const failures: Array<{ video: string; error: string }> = [];

  // 串行执行，确保每个视频对应一个独立请求，并降低限流风险。
  for (const video of videos) {
    try {
      await analyzeVideo(client, video);
    } catch (error) {
      const message = errorMessage(error);
      failures.push({ video: parse(video).base, error: message });
      console.error(`[失败] ${parse(video).base}: ${message}`);
    }
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length}/${videos.length} 个视频分析失败：`);
    for (const failure of failures) {
      console.error(`- ${failure.video}: ${failure.error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`\n全部完成：4 份总结文档已写入 ${OUTPUT_DIR}`);
}

main().catch((error) => {
  console.error(`致命错误：${errorMessage(error)}`);
  process.exitCode = 1;
});
