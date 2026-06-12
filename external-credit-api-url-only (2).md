# 外部客户积分 API 对接文档：URL 直传版

本文档适合“外部系统直接调用 API、图片/音频/视频已经有公网 URL”的场景。调用方不需要使用网页，也不需要调用上传图片/上传音频接口，只要把素材链接放到 `images` / `audios` / `videos` 里即可。

这套接口会走积分体系：

```text
校验访问码 -> 检查积分 -> 创建任务时预扣 -> 生成成功确认扣费 -> 生成失败释放预扣
```

---

## 1. 调用地址

由部署方提供前端服务域名，例如：

```text
https://你的前端域名
```

创建任务：

```text
POST https://你的前端域名/api/app/generate
```

查询任务：

```text
POST https://你的前端域名/api/app/task
```

---

## 2. 你需要准备什么

| 字段 | 说明 |
|---|---|
| `licenseKey` | 用户卡密/访问码 |
| `fingerprint` | 调用方自定义的客户/设备标识，例如 `client-001` |
| `prompt` | 视频生成提示词 |
| `model` | 模型名，例如 `限时使用SD 2` |
| `duration` | 视频时长，例如 `5s`；优先使用 `/api/app/config.models[].durationOptions` 返回的当前模型可选秒数 |
| `aspectRatio` | 视频比例，例如 `16:9`、`9:16`、`1:1`；支持 `21:9`、`16:9`、`4:3`、`1:1`、`3:4`、`9:16` |
| `images` | 图片 URL 数组，可为空 |
| `audios` | 音频 URL 数组，可为空 |
| `videos` | 视频 URL 数组，可为空；仅部分外部通道模型支持 |

图片/音频/视频链接要求：

- 必须是 `http://` 或 `https://`；

比例字段建议使用 camelCase：

```json
{
  "aspectRatio": "16:9"
}
```

服务端也兼容 `aspect_ratio`、`videoAspectRatio`、`video_aspect_ratio` 和 `ratio`，但推荐统一传 `aspectRatio`。
- 必须能被服务器公网访问；
- 建议直接指向图片/音频文件，不要传网页地址；
- 图片最多 9 张；
- 音频最多 3 段；
- 视频最多 3 段；
- 音频建议 `mp3/wav`，单段 2-15 秒，总时长不超过 15 秒。

---

## 3. 创建任务

### 3.1 请求

```http
POST /api/app/generate
Content-Type: application/json
```

请求体：

```json
{
  "licenseKey": "用户卡密",
  "fingerprint": "client-001",
  "prompt": "让 @图片1 里的角色在城市夜景中走路",
  "model": "限时使用SD 2",
  "duration": "5s",
  "aspectRatio": "16:9",
  "images": ["https://example.com/a.png"],
  "audios": [],
  "videos": [],
  "referenceMode": "multimodal"
}
```

### 3.2 curl 示例

```bash
WEB="https://你的前端域名"

curl -sS -X POST "$WEB/api/app/generate" \
  -H "Content-Type: application/json" \
  --data-binary '{
    "licenseKey": "用户卡密",
    "fingerprint": "client-001",
    "prompt": "让 @图片1 里的角色在城市夜景中走路",
    "model": "限时使用SD 2",
    "duration": "5s",
    "aspectRatio": "16:9",
    "images": ["https://example.com/a.png"],
    "audios": [],
    "videos": [],
    "referenceMode": "multimodal"
  }'
```

### 3.3 返回示例

```json
{
  "task": {
    "taskCode": "TASK-xxx",
    "status": "pending"
  },
  "balance": {
    "valid": true,
    "points": {
      "availableBalance": 75,
      "heldBalance": 25
    }
  },
  "hold": {
    "points": {
      "hold": {
        "id": "hold_xxx",
        "status": "holding",
        "amount": 25
      }
    }
  },
  "charge": null,
  "quote": {
    "model": "限时使用SD 2",
    "modelName": "限时使用SD 2",
    "durationSeconds": 5,
    "totalPoints": 25
  },
  "chargeStage": "hold"
}
```

调用方需要保存：

```text
task.taskCode
hold.points.hold.id
model
duration
```

后面查询任务时要把这些字段带回去。

> 如果返回的 `chargeStage` 不是 `hold`，或者 `hold` 为空，查询任务时 `holdId` 可以传空字符串或不传。但当前推荐部署方式是 `hold`。

---

## 4. 查询任务

### 4.1 请求

```http
POST /api/app/task
Content-Type: application/json
```

请求体：

```json
{
  "taskCode": "TASK-xxx",
  "licenseKey": "用户卡密",
  "fingerprint": "client-001",
  "model": "限时使用SD 2",
  "duration": "5s",
  "holdId": "hold_xxx",
  "includeRawError": true
}
```

`includeRawError` 可选，默认不传。传 `true` 时，失败任务会额外返回上游原始错误字段，方便外部系统排查；页面展示仍建议用 `task.errorMsg`。

### 4.2 curl 示例

```bash
curl -sS -X POST "$WEB/api/app/task" \
  -H "Content-Type: application/json" \
  --data-binary '{
    "taskCode": "TASK-xxx",
    "licenseKey": "用户卡密",
    "fingerprint": "client-001",
    "model": "限时使用SD 2",
    "duration": "5s",
    "holdId": "hold_xxx",
    "includeRawError": true
  }'
```

### 4.3 生成中返回

```json
{
  "task": {
    "taskCode": "TASK-xxx",
    "status": "generating",
    "progress": 70,
    "progressText": "生成中",
    "files": []
  },
  "quote": {
    "totalPoints": 25
  },
  "chargeStage": "hold"
}
```

继续轮询即可，建议 5-10 秒查一次。

### 4.4 成功返回

```json
{
  "task": {
    "taskCode": "TASK-xxx",
    "status": "completed",
    "progress": 100,
    "progressText": "已完成",
    "files": [
      {
        "fileUrl": "https://file.hjsuanli.com/a8Kx2FdQ",
        "fileType": "video_hd",
        "mimeType": "video/mp4"
      },
      {
        "fileUrl": "https://file.hjsuanli.com/b9Lm3QaR",
        "fileType": "video_sd",
        "mimeType": "video/mp4"
      }
    ]
  },
  "charge": {
    "valid": true,
    "points": {
      "hold": {
        "id": "hold_xxx",
        "status": "confirmed"
      }
    }
  }
}
```

视频文件字段说明：

| 字段 | 说明 |
| --- | --- |
| `task.files[].fileType` | 视频类型。`video_hd` 是无水印版本；`video_sd` 是普通/有水印预览版本。 |
| `task.files[].fileUrl` | 调用方实际使用的视频地址。所有 `fileUrl` 都会走文件中转短链，格式通常是 `https://file.hjsuanli.com/<code>`。 |
| `task.files[].mimeType` | 文件 MIME 类型，通常是 `video/mp4`。 |

使用建议：

- 播放/预览优先选择 `fileType = "video_sd"` 的 `fileUrl`；
- 下载无水印版本选择 `fileType = "video_hd"` 的 `fileUrl`；
- 所有 `fileUrl` 都是中转短链接，可能带有效期；过期后重新查询任务获取新链接；
- 对外 API 不返回上游原始视频链接，也不会返回 `sourceFileUrl`；原始链接只保留在服务端数据库/后台排查。

### 4.5 失败返回

```json
{
  "task": {
    "taskCode": "TASK-xxx",
    "status": "failed",
    "progressText": "生成失败",
    "errorMsg": "生成失败",
    "rawError": {
      "code": "generate_rejected",
      "message": "upstream failed",
      "ret": "-6",
      "errmsg": "shark not pass reject",
      "fail_code": "4013",
      "fail_starling_key": "web_risk_control_message_reject_generation",
      "fail_starling_message": "The prompt may contain content that violates our Community Guidelines. Change it and try again."
    },
    "files": []
  },
  "rawError": {
    "code": "generate_rejected",
    "message": "upstream failed",
    "ret": "-6",
    "errmsg": "shark not pass reject",
    "fail_code": "4013",
    "fail_starling_key": "web_risk_control_message_reject_generation",
    "fail_starling_message": "The prompt may contain content that violates our Community Guidelines. Change it and try again."
  },
  "hold": {
    "points": {
      "hold": {
        "id": "hold_xxx",
        "status": "released"
      }
    }
  }
}
```

失败时展示：

```text
生成失败
```

如果查询时传了 `includeRawError: true`，可以把 `rawError.errmsg`、`rawError.fail_code`、`rawError.fail_starling_key` 保存到自己的日志里。

---

## 5. 图片和音频引用规则

### 5.1 图片引用

请求：

```json
{
  "prompt": "让 @图片1 里的人走进 @图片2 的房间",
  "images": [
    "https://example.com/person.png",
    "https://example.com/room.png"
  ]
}
```

对应关系：

```text
@图片1 -> images[0]
@图片2 -> images[1]
@image1 -> images[0]
@image2 -> images[1]
```

### 5.2 音频引用

请求：

```json
{
  "prompt": "根据 @音频1 的节奏生成一段城市夜景视频",
  "audios": ["https://example.com/music.mp3"]
}
```

对应关系：

```text
@音频1 -> audios[0]
@音频2 -> audios[1]
@audio1 -> audios[0]
@audio2 -> audios[1]
```

`audios` 也可以传对象，便于带上音频时长和名称：

```json
{
  "audios": [
    {
      "url": "https://example.com/music.mp3",
      "duration": 5,
      "title": "music.mp3"
    }
  ]
}
```

---

## 6. 常见调用场景

### 6.1 纯文本生成

```json
{
  "licenseKey": "用户卡密",
  "fingerprint": "client-001",
  "prompt": "一个男孩在操场上跑步，电影感，阳光穿过树影",
  "model": "限时使用SD 2",
  "duration": "5s",
  "aspectRatio": "16:9",
  "images": [],
  "audios": [],
  "referenceMode": "multimodal"
}
```

### 6.2 单张图片参考

```json
{
  "licenseKey": "用户卡密",
  "fingerprint": "client-001",
  "prompt": "让 @图片1 里的角色在城市夜景中走路",
  "model": "限时使用SD 2",
  "duration": "5s",
  "aspectRatio": "16:9",
  "images": ["https://example.com/a.png"],
  "audios": [],
  "referenceMode": "multimodal"
}
```

### 6.3 多张图片参考

```json
{
  "licenseKey": "用户卡密",
  "fingerprint": "client-001",
  "prompt": "让 @图片1 里的人物进入 @图片2 的场景，镜头缓慢推进",
  "model": "限时使用SD 2",
  "duration": "5s",
  "aspectRatio": "16:9",
  "images": [
    "https://example.com/person.png",
    "https://example.com/scene.png"
  ],
  "audios": [],
  "referenceMode": "multimodal"
}
```

### 6.4 图片 + 音频参考

```json
{
  "licenseKey": "用户卡密",
  "fingerprint": "client-001",
  "prompt": "让 @图片1 里的角色根据 @音频1 的节奏跳舞",
  "model": "限时使用SD 2",
  "duration": "5s",
  "aspectRatio": "16:9",
  "images": ["https://example.com/person.png"],
  "audios": [
    {
      "url": "https://example.com/music.mp3",
      "duration": 5,
      "title": "music.mp3"
    }
  ],
  "referenceMode": "multimodal"
}
```

### 6.5 首尾帧模式

```json
{
  "licenseKey": "用户卡密",
  "fingerprint": "client-001",
  "prompt": "从第一张画面自然过渡到第二张画面，电影感",
  "model": "限时使用SD 2",
  "duration": "5s",
  "aspectRatio": "16:9",
  "images": [
    "https://example.com/first.png",
    "https://example.com/last.png"
  ],
  "audios": [],
  "referenceMode": "first_last_frame"
}
```

首尾帧限制：

- `images` 至少 1 张，最多 2 张；
- 第 1 张为首帧，第 2 张为尾帧；
- 不支持音频。

---

## 7. 完整轮询脚本

依赖 `curl` 和 `jq`。

```bash
#!/usr/bin/env bash
set -euo pipefail

WEB="${WEB:-https://你的前端域名}"
LICENSE_KEY="${LICENSE_KEY:?set LICENSE_KEY}"
FINGERPRINT="${FINGERPRINT:-client-001}"
MODEL="${MODEL:-限时使用SD 2}"
DURATION="${DURATION:-5s}"
IMAGE_URL="${IMAGE_URL:-https://example.com/a.png}"

CREATE_RESP="$(
  curl -sS -X POST "$WEB/api/app/generate" \
    -H "Content-Type: application/json" \
    --data-binary "$(jq -n \
      --arg licenseKey "$LICENSE_KEY" \
      --arg fingerprint "$FINGERPRINT" \
      --arg model "$MODEL" \
      --arg duration "$DURATION" \
      --arg imageUrl "$IMAGE_URL" \
      '{
        licenseKey:$licenseKey,
        fingerprint:$fingerprint,
        prompt:"让 @图片1 里的角色在城市夜景中走路",
        model:$model,
        duration:$duration,
        aspectRatio:"16:9",
        images:[$imageUrl],
        audios:[],
        referenceMode:"multimodal"
      }')"
)"

echo "$CREATE_RESP" | jq .

TASK_CODE="$(printf '%s' "$CREATE_RESP" | jq -r '.task.taskCode')"
HOLD_ID="$(printf '%s' "$CREATE_RESP" | jq -r '.hold.points.hold.id // empty')"

while true; do
  RESP="$(
    curl -sS -X POST "$WEB/api/app/task" \
      -H "Content-Type: application/json" \
      --data-binary "$(jq -n \
        --arg taskCode "$TASK_CODE" \
        --arg licenseKey "$LICENSE_KEY" \
        --arg fingerprint "$FINGERPRINT" \
        --arg model "$MODEL" \
        --arg duration "$DURATION" \
        --arg holdId "$HOLD_ID" \
        '{
          taskCode:$taskCode,
          licenseKey:$licenseKey,
          fingerprint:$fingerprint,
          model:$model,
          duration:$duration,
          holdId:$holdId
        }')"
  )"

  echo "$RESP" | jq .
  STATUS="$(printf '%s' "$RESP" | jq -r '.task.status')"

  if [[ "$STATUS" == "completed" ]]; then
    PREVIEW_URL="$(printf '%s' "$RESP" | jq -r '[.task.files[]? | select(.fileType=="video_sd") | .fileUrl][0] // empty')"
    HD_URL="$(printf '%s' "$RESP" | jq -r '[.task.files[]? | select(.fileType=="video_hd") | .fileUrl][0] // empty')"
    printf 'preview_video=%s\n' "$PREVIEW_URL"
    printf 'no_watermark_video=%s\n' "$HD_URL"
    break
  fi

  if [[ "$STATUS" == "failed" ]]; then
    echo "生成失败"
    break
  fi

  sleep 10
done
```

---

## 8. 错误处理

接口错误格式：

```json
{
  "error": {
    "code": "upstream_error",
    "message": "insufficient_points",
    "upstream": {
      "reason": "insufficient_points"
    }
  }
}
```

常见错误：

| 错误 | 说明 |
|---|---|
| `insufficient_points` | 用户卡密积分不足 |
| `model_not_supported` | 模型名错误或未启用 |
| `bad_duration` | 时长格式错误，应为 `5s` 这种格式 |
| `too_many_images` | 图片数量超过限制 |
| `too_many_audios` | 音频数量超过限制 |
| `unsupported_image_reference` | 图片链接不是 `http/https` |
| `unsupported_audio_reference` | 音频链接不是 `http/https` |
| `first_last_frame_requires_image` | 首尾帧模式必须传图片 |
| `first_last_frame_audio_not_supported` | 首尾帧模式不支持音频 |
| `task_not_found` | 任务不存在或无法访问 |

业务展示建议：

- 创建任务接口报 `insufficient_points`：展示“积分不足”；
- 创建任务接口报参数错误：按错误提示修正参数；
- 任务状态为 `failed`：统一展示“生成失败”。

---

## 9. 对接注意事项

1. 外部系统直接传图片/音频 URL，不需要调用上传接口。
2. URL 必须能被服务器访问；如果链接有防盗链、过期签名、登录限制，生成可能失败。
3. 扣费幂等标识由前端服务内部生成，调用方不需要传额外幂等字段。
4. 创建任务成功后一定要保存 `taskCode` 和 `holdId`。
5. 查询任务时带回原来的 `model` 和 `duration`，用于确认/释放预扣积分。
6. 轮询间隔建议 5-10 秒。
7. 成功后播放/预览优先使用 `fileType=video_sd` 的 `fileUrl`。
8. 下载无水印版本使用 `fileType=video_hd` 的 `fileUrl`；该链接通常是中转链接，可能有有效期，过期后重新查询任务可拿到新的链接。
