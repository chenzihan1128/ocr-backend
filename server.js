// backend/server.js  —— 覆盖版（ESM）

// 1) 先加载环境变量（必须在最顶部）
import dotenv from "dotenv";
dotenv.config();

// 2) 依赖
import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs/promises";
import os from "os";
import OpenAI from "openai";

// 3) 基础中间件
const app = express();
app.use(cors());
app.use(express.json());

// 4) 确保有上传目录
const UPLOAD_DIR = "uploads";
await fs.mkdir(UPLOAD_DIR, { recursive: true });

// 5) Multer：保存到磁盘（req.file.path 可用）
const upload = multer({ dest: UPLOAD_DIR });

// 6) OpenAI 客户端（.env 里需有 OPENAI_API_KEY=sk-xxxx）
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// 简短确认（不会泄露密钥）
console.log("OPENAI_API_KEY loaded:", (process.env.OPENAI_API_KEY || "").slice(0, 4) + "****");

// 7) 工具函数
function getLANIP() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const i of ifs[name] || []) {
      if (i.family === "IPv4" && !i.internal) return i.address;
    }
  }
  return "localhost";
}

// 8) OCR：图片→base64→视觉模型→纯文本
async function runYourOCR(filePath) {
  const b64 = (await fs.readFile(filePath)).toString("base64");

  // 按你账号可用的视觉模型填写：gpt-4o / gpt-4o-mini / gpt-4.1-mini 等
  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Extract ALL readable text from this receipt as plain text. Do NOT summarize." },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } },
        ],
      },
    ],
  });

  return resp.choices?.[0]?.message?.content || "";
}

// 9) 票据解析：从纯文本中抽取商家与金额
function parseReceipt(text) {
  const lines = (text || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);

  // 商家候选：前几行里不含系统字段的那行
  const ban = /total|date|time|invoice|batch|approval|trans id|customer|wechat|visa|master|sale|receipt|store|cashier|host|mid|tid|batch/i;
  let merchant = "-";
  for (let i = 0; i < Math.min(6, lines.length); i++) {
    const s = lines[i];
    if (!ban.test(s) && /[A-Za-z]/.test(s) && s.length >= 3) {
      merchant = s.replace(/[^\w\s\-\&\.\,]/g, "").slice(0, 60);
      break;
    }
  }

  // 金额候选
  const candidates = [
    /TOTAL[:\s]+(?:SGD|HKD|CNY|USD|S\$|\$|RM)?\s*([0-9]+[.,][0-9]{2})/i,
    /(AMOUNT|AMT|AMOUNT DUE)[:\s]+(?:SGD|HKD|CNY|USD|S\$|\$|RM)?\s*([0-9]+[.,][0-9]{2})/i,
    /(CNY|SGD|USD)\s*AMOUNT[:\s]+([0-9]+[.,][0-9]{2})/i,
    /\b(?:S\$|\$)\s*([0-9]+[.,][0-9]{2})\b/,
  ];

  let amount = null, currency = null, matched = "";
  for (const line of lines) {
    for (const re of candidates) {
      const m = line.match(re);
      if (m) {
        const val = m[m.length - 1];
        amount = parseFloat(val.replace(",", ""));
        if (/CNY/i.test(line)) currency = "CNY";
        else if (/SGD|S\$/i.test(line)) currency = "SGD";
        else if (/\$/.test(line)) currency = "SGD"; // 需要默认 USD 可改这里
        matched = line;
        break;
      }
    }
    if (amount != null) break;
  }

  return {
    merchant,
    currency: currency || "SGD",
    amount: amount ?? 0,
    debug: { matched } // 仅用于后端日志，不返回给前端
  };
}

// 10) 路由
app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// 前端 FormData 用 "file" 字段上传图片
app.post("/ocr", upload.single("file"), async (req, res) => {
  try {
    console.log("🟢 /ocr 收到请求");
    console.log("文件信息:", req.file);

    if (!req.file?.path) {
      return res.status(200).json({ ok: false, code: "NOFILE", message: "未接收到图片文件" });
    }

    // OCR → 文本
    const text = await runYourOCR(req.file.path);
    console.log("OCR 结果（前120字）:", (text || "").slice(0, 120));

    // 解析 → 结构化
    const parsed = parseReceipt(text || "");
    console.log("解析结果:", parsed);

    // ✅ 只返回结构化字段（不返回原始文本）
    return res.json({
      ok: true,
      merchant: parsed.merchant,
      amount: parsed.amount,
      currency: parsed.currency
    });
  } catch (e) {
    const code = e?.status || e?.response?.status;
    if (code === 429) {
      // 额度不足 → 返回友好提示（200 + ok:false，前端不必展示原始报错）
      return res.status(200).json({
        ok: false,
        code: "QUOTA",
        message: "识别服务额度不足，请在 OpenAI Billing 中开通/充值后再试。"
      });
    }
    console.error("[/ocr] ERROR:", e?.response?.data || e);
    return res.status(200).json({ ok: false, code: "ERROR", message: "识别失败，请稍后重试。" });
  }
});

// 11) 启动（0.0.0.0 便于手机访问）
const PORT = process.env.PORT || 8000;
// 简单根路由：用来确认服务活着
app.get("/", (_req, res) => res.send("OK"));

// 健康检查：App 用它来自检
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    hasKey: !!process.env.OPENAI_API_KEY,
    time: new Date().toISOString(),
  });
});

app.listen(PORT, "0.0.0.0", () => {
  const ip = getLANIP();
  console.log("🚀 AI OCR server running:");
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   Network: http://${ip}:${PORT}`);
});
