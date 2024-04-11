import { PassThrough } from "stream";
import path from "path";
import _ from "lodash";
import mime from "mime";
import axios, { AxiosResponse } from "axios";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import { createParser } from "eventsource-parser";
import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";

// 模型名称
const MODEL_NAME = "concise";
// 最大重试次数
const MAX_RETRY_COUNT = 0;
// 重试延迟
const RETRY_DELAY = 5000;
// 伪装headers
const FAKE_HEADERS = {
  Accept: "*/*",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-Language": "zh-CN,zh;q=0.9",
  Origin: "https://metaso.cn",
  "Sec-Ch-Ua":
    '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
};
// 文件最大大小
const FILE_MAX_SIZE = 100 * 1024 * 1024;
// access_token映射
const accessTokenMap = new Map();

// 先从页面爬取meta-token
// 需要提供sid和uid
// 使用sid和uid cookie+url编码的meta-token调用流

/**
 * 获取meta-token
 *
 * @param token 认证Token
 */
async function acquireMetaToken(token: string) {
  const result = await axios.get("https://metaso.cn/", {
    headers: {
      ...FAKE_HEADERS,
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
      Cookie: generateCookie(token),
    },
    timeout: 15000,
    validateStatus: () => true,
  });
  if (
    result.status != 200 ||
    result.headers["content-type"].indexOf("text/html") == -1
  )
    throw new APIException(EX.API_REQUEST_FAILED, result.data);
  const regex = /<meta id="meta-token" content="([^"]*)"/;
  const match = result.data.match(regex);
  if (!match || !match[1])
    throw new APIException(EX.API_REQUEST_FAILED, "meta-token not found");
  const metaToken = match[1];
  return encodeURIComponent(metaToken);
}

/**
 * 生成Cookie
 *
 * @param token 认证Token
 */
function generateCookie(token: string) {
  const [uid, sid] = token.split("-");
  return `uid=${uid}; sid=${sid}`;
}

/**
 * 创建会话
 *
 * 创建临时的会话用于对话补全
 *
 * @param token 认证Token
 */
async function createConversation(model: string, name: string, token: string) {
  const metaToken = await acquireMetaToken(token);
  const result = await axios.post(
    "https://metaso.cn/api/session",
    {
      question: name,
      // 创建简洁版本，绕过次数限制
      mode: "concise",
      engineType: "",
      scholarSearchDomain: "all",
    },
    {
      headers: {
        Cookie: generateCookie(token),
        Token: metaToken,
        "Is-Mini-Webview": "0",
        ...FAKE_HEADERS,
      },
      timeout: 15000,
      validateStatus: () => true,
    }
  );
  const {
    data: { id: convId },
  } = checkResult(result);
  return convId;
}

/**
 * 同步对话补全
 *
 * @param model 模型名称
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param token 认证Token
 * @param useSearch 是否开启联网搜索
 * @param retryCount 重试次数
 */
async function createCompletion(
  model = MODEL_NAME,
  messages: any[],
  token: string,
  useSearch = true,
  retryCount = 0
) {
  return (async () => {
    logger.info(messages);

    if (!["concise", "detail", "research"].includes(model)) model = MODEL_NAME;

    // 创建会话
    const convId = await createConversation(model, "新会话", token);

    // 请求流
    const metaToken = await acquireMetaToken(token);
    const result = await axios.get(
      `https://metaso.cn/api/searchV2?sessionId=${convId}&question=${messagesPrepare(
        messages
      )}&lang=zh&mode=${model}&is-mini-webview=0&token=${metaToken}`,
      {
        headers: {
          Cookie: generateCookie(token),
          ...FAKE_HEADERS,
          Accept: "text/event-stream",
        },
        // 300秒超时
        timeout: 300000,
        validateStatus: () => true,
        responseType: "stream",
      }
    );

    const streamStartTime = util.timestamp();
    // 接收流为输出文本
    const answer = await receiveStream(model, convId, result.data);
    logger.success(
      `Stream has completed transfer ${util.timestamp() - streamStartTime}ms`
    );

    return answer;
  })().catch((err) => {
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Stream response error: ${err.message}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createCompletion(
          model,
          messages,
          token,
          useSearch,
          retryCount + 1
        );
      })();
    }
    throw err;
  });
}

/**
 * 流式对话补全
 *
 * @param model 模型名称
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param token 认证Token
 * @param useSearch 是否开启联网搜索
 * @param retryCount 重试次数
 */
async function createCompletionStream(
  model = MODEL_NAME,
  messages: any[],
  token: string,
  useSearch = true,
  retryCount = 0
) {
  return (async () => {
    logger.info(messages);
    
    if (!["concise", "detail", "research"].includes(model)) model = MODEL_NAME;

    // 创建会话
    const convId = await createConversation(model, "新会话", token);

    // 请求流
    const metaToken = await acquireMetaToken(token);
    const result = await axios.get(
      `https://metaso.cn/api/searchV2?sessionId=${convId}&question=${messagesPrepare(
        messages
      )}&lang=zh&mode=${model}&is-mini-webview=0&token=${metaToken}`,
      {
        headers: {
          Cookie: generateCookie(token),
          ...FAKE_HEADERS,
          Accept: "text/event-stream",
        },
        // 300秒超时
        timeout: 300000,
        validateStatus: () => true,
        responseType: "stream",
      }
    );
    const streamStartTime = util.timestamp();
    // 创建转换流将消息格式转换为gpt兼容格式
    return createTransStream(model, convId, result.data, () => {
      logger.success(
        `Stream has completed transfer ${util.timestamp() - streamStartTime}ms`
      );
    });
  })().catch((err) => {
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Stream response error: ${err.message}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createCompletionStream(
          model,
          messages,
          token,
          useSearch,
          retryCount + 1
        );
      })();
    }
    throw err;
  });
}

/**
 * 消息预处理
 *
 * 由于接口只取第一条消息，此处会将多条消息合并为一条，实现多轮对话效果
 * user:旧消息1
 * assistant:旧消息2
 * user:新消息
 *
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 */
function messagesPrepare(messages: any[]) {
  // 注入消息提升注意力
  let latestMessage = messages[messages.length - 1];
  let hasFileOrImage =
    Array.isArray(latestMessage.content) &&
    latestMessage.content.some(
      (v) => typeof v === "object" && ["file", "image_url"].includes(v["type"])
    );
  // 第二轮开始注入system prompt
  if (messages.length > 2) {
    if (hasFileOrImage) {
      let newFileMessage = {
        content: "关注用户最新发送文件和消息",
        role: "system",
      };
      messages.splice(messages.length - 1, 0, newFileMessage);
      logger.info("注入提升尾部文件注意力system prompt");
    } else {
      let newTextMessage = {
        content: "关注用户最新的消息",
        role: "system",
      };
      messages.splice(messages.length - 1, 0, newTextMessage);
      logger.info("注入提升尾部消息注意力system prompt");
    }
  }

  const content = messages.reduce((content, message) => {
    if (Array.isArray(message.content)) {
      return message.content.reduce((_content, v) => {
        if (!_.isObject(v) || v["type"] != "text") return _content;
        return _content + `${message.role || "user"}:${v["text"] || ""}\n`;
      }, content);
    }
    return (content += `${message.role || "user"}:${message.content}\n`);
  }, "");
  logger.info("\n对话合并：\n" + content);
  return content;
}

/**
 * 检查请求结果
 *
 * @param result 结果
 */
function checkResult(result: AxiosResponse) {
  if (!result.data) return null;
  const { errCode, errMsg } = result.data;
  if (!_.isFinite(errCode) || errCode == 0) return result.data;
  throw new APIException(EX.API_REQUEST_FAILED, `[请求metaso失败]: ${errMsg}`);
}

/**
 * 从流接收完整的消息内容
 *
 * @param model 模型名称
 * @param convId 会话ID
 * @param stream 消息流
 */
async function receiveStream(model: string, convId: string, stream: any) {
  return new Promise((resolve, reject) => {
    // 消息初始化
    const data = {
      id: convId,
      model,
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      created: util.unixTimestamp(),
    };
    const parser = createParser((event) => {
      try {
        if (event.type !== "event") return;
        if (event.data == "[DONE]") return;
        // 解析JSON
        const result = _.attempt(() => JSON.parse(event.data));
        if (_.isError(result))
          throw new Error(`Stream response invalid: ${event.data}`);
        if (result.type == "append-text")
          data.choices[0].message.content += result.text;
      } catch (err) {
        logger.error(err);
        reject(err);
      }
    });
    // 将流数据喂给SSE转换器
    stream.on("data", (buffer) => parser.feed(buffer.toString()));
    stream.once("error", (err) => reject(err));
    stream.once("close", () => resolve(data));
  });
}

/**
 * 创建转换流
 *
 * 将流格式转换为gpt兼容流格式
 *
 * @param model 模型名称
 * @param convId 会话ID
 * @param stream 消息流
 * @param endCallback 传输结束回调
 */
function createTransStream(
  model: string,
  convId: string,
  stream: any,
  endCallback?: Function
) {
  // 消息创建时间
  const created = util.unixTimestamp();
  // 创建转换流
  const transStream = new PassThrough();
  !transStream.closed &&
    transStream.write(
      `data: ${JSON.stringify({
        id: convId,
        model,
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "" },
            finish_reason: null,
          },
        ],
        created,
      })}\n\n`
    );
  const parser = createParser((event) => {
    try {
      if (event.type !== "event") return;
      if (event.data == "[DONE]") {
        const data = `data: ${JSON.stringify({
          id: convId,
          model,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created,
        })}\n\n`;
        !transStream.closed && transStream.write(data);
        !transStream.closed && transStream.end("data: [DONE]\n\n");
        endCallback && endCallback();
        return;
      }
      // 解析JSON
      const result = _.attempt(() => JSON.parse(event.data));
      if (_.isError(result))
        throw new Error(`Stream response invalid: ${event.data}`);
      if (result.type == "append-text") {
        const data = `data: ${JSON.stringify({
          id: convId,
          model,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: { content: result.text },
              finish_reason: null,
            },
          ],
          created,
        })}\n\n`;
        !transStream.closed && transStream.write(data);
      }
    } catch (err) {
      logger.error(err);
      !transStream.closed && transStream.end("\n\n");
    }
  });
  // 将流数据喂给SSE转换器
  stream.on("data", (buffer) => parser.feed(buffer.toString()));
  stream.once(
    "error",
    () => !transStream.closed && transStream.end("data: [DONE]\n\n")
  );
  stream.once(
    "close",
    () => !transStream.closed && transStream.end("data: [DONE]\n\n")
  );
  return transStream;
}

/**
 * Token切分
 *
 * @param authorization 认证字符串
 */
function tokenSplit(authorization: string) {
  return authorization.replace("Bearer ", "").split(",");
}

/**
 * 获取Token存活状态
 */
async function getTokenLiveStatus(token: string) {
  return false
}

export default {
  createConversation,
  createCompletion,
  createCompletionStream,
  getTokenLiveStatus,
  tokenSplit,
};