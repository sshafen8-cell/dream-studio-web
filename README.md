# Dream Studio Web

HS 汇聚算力 AI 创作台前端 —— 一套零依赖、纯原生 JavaScript 实现的 AI 视频 / 图片生成工作台 UI，macOS 毛玻璃视觉风格。

## 特性

- **瀑布流作品画廊**：视频与图片作品混排展示，按列高自动分发，窗口与布局变化时平滑重排（带签名跳过机制，避免视频元素重复挂载闪烁）
- **底部指挥条**：收起状态即全功能 —— 多行自适应输入（回车生成 / Shift+回车换行）、参数摘要面板、上传图片 / 音频、粘贴素材链接、素材缩略管理（编辑标注 / 自动打码 / 移除）
- **可展开生成器**：指挥条与左侧通高面板之间的 FLIP 形变动画；展开时画廊自动让位重排，不遮挡作品
- **本地隐私打码**：基于 [Human](https://github.com/vladmandic/human) 的浏览器端人脸识别自动马赛克，以及画笔 / 形状手动编辑标注，处理全程不离开本机
- **素材库**：按访问码隔离的云端素材引用，重复上传自动复用，提示词中可用 `@图片1`、`@音频1` 引用定位
- **双主题**：浅色 / 深色一键切换，玻璃拟物 + 极光渐变壁纸
- **平滑迁移**：与旧版前端共用 localStorage 键名（访问码、任务记录、公告已读状态），同域部署无缝继承历史数据

## 项目结构

```
├── index.html            # 应用壳：SVG 图标雪碧图 + 三视图（启动 / 验证 / 工作台）
├── assets/
│   ├── app.css           # 设计系统：玻璃 token、双主题变量、全部组件样式
│   └── app.js            # 全部逻辑：API 客户端、状态、渲染器、动画、轮询
├── _real-server.js       # 本地开发：静态文件 + /api、/vendor 反代到真实后端
└── _mock-server.js       # 本地开发：离线模拟全部后端接口
```

## 本地开发

需要 Node.js 18+（使用内置 `fetch`）。

```bash
# 方式一：反代真实后端（需要有效访问码）
node _real-server.js        # http://localhost:8787

# 方式二：完全离线模拟（任意 LIC- 开头的码即可进入）
node _mock-server.js
```

## 部署

纯静态站点：将 `index.html` 与 `assets/` 部署到任意静态服务器即可，要求与后端 API（`/api/app/*`）及人脸模型资源（`/vendor/human/*`）同源（或由网关反代）。

## 技术说明

- 无构建步骤、无运行时依赖：单 IIFE 经典脚本，`el()` / `icon()` 辅助函数直接构建 DOM
- 接口约定：`/api/app/config`、`generate`、`task`（5s 轮询）、`image/generate`、`upload-image|audio`、`assets/*`、`announcements` 等，鉴权使用 `x-license-key` / `x-fingerprint` 头或请求体字段
- 计费模式：按次（`per_task`）与按秒（`per_second`）两种，提交前实时报价，支持预扣（hold）状态跟踪
