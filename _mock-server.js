/* 临时 mock 服务：静态文件 + 模拟 /api/app/*，用于本地视觉联调 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = 8787;

const CONFIG = {
  productCode: "dreamina-video", actionName: "视频生成", activationType: "site",
  chargeStage: "hold", holdExpiresInSeconds: 7200,
  costHint: "普通版按次扣费，其他模型按模型每秒积分 × 视频秒数扣费",
  defaultModel: "限时使用SD 2", modelOptions: ["限时使用SD 2"],
  models: [{ name: "限时使用SD 2", model: "SD 2-limited", billingMode: "per_task", pointsPerSecond: 0, pointsPerTask: 40, durationOptions: [], enabled: true, actionCode: "SD 2-limited", description: "按次计费", accountPool: "limited" }],
  defaultImageModel: "Auto", imageModelOptions: ["Auto", "1K", "2K", "4K"],
  imageModels: [
    { name: "Auto", model: "gpt-image-2", billingMode: "per_task", pointsPerTask: 1, enabled: true, actionCode: "image.generate.auto", description: "自动尺寸生图", tier: "auto", durationOptions: [] },
    { name: "1K", model: "gpt-image-2", billingMode: "per_task", pointsPerTask: 0.8, enabled: true, actionCode: "image.generate.1k", description: "1K 生图", tier: "1K", durationOptions: [] },
    { name: "2K", model: "gpt-image-2", billingMode: "per_task", pointsPerTask: 1.6, enabled: true, actionCode: "image.generate.2k", description: "2K 生图", tier: "2K", durationOptions: [] },
    { name: "4K", model: "gpt-image-2", billingMode: "per_task", pointsPerTask: 3.2, enabled: true, actionCode: "image.generate.4k", description: "4K 生图", tier: "4K", durationOptions: [] }
  ],
  requireDynamicDreaminaToken: false
};

let balancePoints = { availableBalance: 360, heldBalance: 40, totalConsumed: 100, totalGranted: 500, label: "积分" };
const tasks = new Map();   // taskCode -> {createdAt, kind}
const assets = [
  { id: "as1", kind: "image", url: "https://picsum.photos/seed/a/400/400", name: "示例图 A.png" },
  { id: "as2", kind: "image", url: "https://picsum.photos/seed/b/400/300", name: "示例图 B.png" },
  { id: "as3", kind: "audio", url: "https://example.com/demo.mp3", name: "demo.mp3", duration: 5 }
];
let taskSeq = 0, assetSeq = 10;

const ANNOUNCEMENTS = [
  { id: "n1", title: "模型节点维护预告", content: "今晚 23:00 - 24:00 将升级渲染集群，期间任务可能排队 5-10 分钟，请避开高峰提交。", level: "warning", placement: "all", pinned: true, dismissible: true },
  { id: "n2", title: "图片生成上线", content: "工作台新增图片生成模式，支持文生图 / 图生图，Auto 档位 1 积分/张。", level: "success", placement: "composer", dismissible: true }
];

function json(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", c => data += c);
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}

/* 任务进度模拟：0-6s 等待，6-16s 生成中，>16s 完成 */
function taskState(code) {
  const t = tasks.get(code);
  if (!t) return null;
  const age = (Date.now() - t.createdAt) / 1000;
  if (/失败/.test(t.prompt || "")) {
    if (age > 6) return { phase: "failed" };
  }
  if (age < 6) return { phase: "pending", progress: Math.round(age / 6 * 20), text: "排队中" };
  if (age < 16) return { phase: "generating", progress: 20 + Math.round((age - 6) / 10 * 75), text: "生成中" };
  return { phase: "completed" };
}

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  /* ---------- API ---------- */
  if (p === "/api/app/config") return json(res, CONFIG);
  if (p === "/api/app/announcements") return json(res, { announcements: ANNOUNCEMENTS.filter(a => a.placement === "all" || a.placement === url.searchParams.get("placement")) });

  if (p === "/api/app/license/activate" || p === "/api/app/license/balance") {
    const body = await readBody(req);
    if (!/^LIC-/i.test(body.licenseKey || "")) {
      return json(res, { error: { code: "upstream_error", message: "license_not_found" } }, 400);
    }
    return json(res, { balance: { valid: true, points: balancePoints } });
  }

  if (p === "/api/app/generate" || p === "/api/app/image/generate") {
    const body = await readBody(req);
    const isImage = p.includes("image");
    const code = `${isImage ? "IMG" : "TASK"}-${String(++taskSeq).padStart(3, "0")}`;
    const pts = isImage ? 1 : 40;
    tasks.set(code, { createdAt: Date.now(), kind: isImage ? "image" : "video", prompt: body.prompt });
    balancePoints = { ...balancePoints, availableBalance: balancePoints.availableBalance - pts, heldBalance: balancePoints.heldBalance + pts };
    return json(res, {
      task: { taskCode: code, status: "pending" },
      balance: { valid: true, points: balancePoints },
      hold: { points: { hold: { id: `hold_${code}`, status: "holding", amount: pts } } },
      charge: null,
      quote: isImage
        ? { model: "gpt-image-2", modelName: body.model, totalPoints: pts, tier: "auto", size: "1024x1024" }
        : { model: "SD 2-limited", modelName: body.model, durationSeconds: 15, totalPoints: pts },
      chargeStage: "hold"
    });
  }

  if (p === "/api/app/task" || p === "/api/app/image/task") {
    const body = await readBody(req);
    const st = taskState(body.taskCode);
    const isImage = p.includes("image");
    if (!st) return json(res, { error: { code: "upstream_error", message: "task_not_found" } }, 404);
    if (st.phase === "failed") {
      return json(res, {
        task: { taskCode: body.taskCode, status: "failed", progressText: "生成失败", errorMsg: "生成失败：提示词可能违反社区规范", files: [] },
        hold: { points: { hold: { id: body.holdId, status: "released" } } }
      });
    }
    if (st.phase !== "completed") {
      return json(res, { task: { taskCode: body.taskCode, status: st.phase === "pending" ? "pending" : "generating", progress: st.progress, progressText: st.text, files: [] }, chargeStage: "hold" });
    }
    const files = isImage
      ? [{ fileUrl: `https://picsum.photos/seed/${body.taskCode}/1024/1024`, fileType: "image", mimeType: "image/png", sha256: "mock-" + body.taskCode, width: 1024, height: 1024, format: "png", size: 345678 }]
      : [
        { fileUrl: "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_1MB.mp4", fileType: "video_hd", mimeType: "video/mp4" },
        { fileUrl: "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4", fileType: "video_sd", mimeType: "video/mp4" }
      ];
    return json(res, {
      task: { taskCode: body.taskCode, status: "completed", progress: 100, progressText: "已完成", files },
      charge: { valid: true, points: { hold: { id: body.holdId, status: "confirmed" } } },
      balance: { valid: true, points: balancePoints }
    });
  }

  if (p === "/api/app/upload-image" || p === "/api/app/upload-audio") {
    /* 不解析 multipart，按 boundary 计数 file 段 */
    let raw = Buffer.alloc(0);
    req.on("data", c => raw = Buffer.concat([raw, c]));
    req.on("end", () => {
      const text = raw.toString("latin1");
      const count = (text.match(/name="file"/g) || []).length || 1;
      const isAudio = p.includes("audio");
      const files = Array.from({ length: count }, (_, i) => {
        const id = `as${++assetSeq}`;
        const f = isAudio
          ? { url: `https://example.com/up-${id}.mp3`, name: `上传音频${i + 1}.mp3`, duration: 5, assetId: id }
          : { url: `https://picsum.photos/seed/${id}/600/400`, name: `上传图片${i + 1}.png`, assetId: id };
        assets.unshift({ id, kind: isAudio ? "audio" : "image", url: f.url, name: f.name, duration: f.duration });
        return f;
      });
      json(res, { files });
    });
    return;
  }

  if (p === "/api/app/assets/list") return json(res, { assets });
  if (p === "/api/app/assets/register") {
    const body = await readBody(req);
    const exist = assets.find(a => a.url === body.url);
    if (exist) return json(res, { asset: { ...exist, reused: true } });
    const asset = { id: `as${++assetSeq}`, kind: "image", url: body.url, name: body.name };
    assets.unshift(asset);
    return json(res, { asset });
  }
  if (p === "/api/app/assets/delete") {
    const body = await readBody(req);
    const i = assets.findIndex(a => a.id === body.assetId);
    if (i >= 0) assets.splice(i, 1);
    return json(res, { ok: true });
  }
  if (p === "/api/app/download") {
    res.writeHead(302, { Location: url.searchParams.get("url") || "/" });
    return res.end();
  }
  if (p.startsWith("/api/")) return json(res, { error: { message: "not mocked: " + p } }, 404);

  /* ---------- 静态 ---------- */
  let file = p === "/" ? "/index.html" : p;
  const abs = path.join(ROOT, file.replace(/^\/+/, ""));
  if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    res.writeHead(404); return res.end("not found");
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(abs)] || "application/octet-stream" });
  fs.createReadStream(abs).pipe(res);
});

server.listen(PORT, () => console.log(`mock server: http://localhost:${PORT}/`));
