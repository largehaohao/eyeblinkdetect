# Eye Blink Detector — Chrome 扩展设计文档

**日期**: 2026-05-20
**作者**: zhanghao + Claude
**状态**: Draft

## 1. 目标

工作场景下,通过笔记本/外接摄像头检测用户盯电脑屏幕时的眨眼频率,记录时序数据,以图表展示长期趋势,当短期眨眼频率低于阈值时弹出系统通知或全屏遮罩提醒用户休息眼睛。

**非目标**

- 不做情绪/疲劳的复合判定,只看眨眼频率这一个信号。
- 不做远程同步、不做账号系统、不做数据上传。
- 不在 Chrome 之外的浏览器/操作系统运行。
- 不替代正规干眼/疲劳的医学建议。

## 2. 核心需求

| 需求 | 决定 |
|---|---|
| 眨眼检测算法 | MediaPipe Face Landmarker (本地 WASM),基于 EAR 算法 |
| 摄像头开启时机 | 手动点击插件图标开/关 |
| 提醒规则 | 滑动窗口平均 + 阈值持续 N 分钟才触发 |
| 数据存储 | IndexedDB 永久保留,提供手动 CSV/JSON 导出 |
| UI 形态 | popup 显示当前频率/最近 1h + 独立 dashboard 页看长期趋势 |
| 提醒形式 | 系统通知 + 可选全屏遮罩(设置里切换) |
| 人脸丢失 | 暂停计数(不计分子也不计分母),避免离桌误报为低频 |
| 隐私边界 | 严格本地:模型文件随扩展包打包,零网络请求 |

## 3. 架构

Chrome MV3 扩展,四个运行时单元:

```
┌─────────────────────────────────────────────────────────────┐
│ Service Worker (background)                                 │
│  - 状态机 (RUNNING / PAUSED / ABSENT / OFF)                 │
│  - 接收 detector 的 blink/face_lost 事件                    │
│  - chrome.alarms 每分钟聚合,写 IndexedDB                    │
│  - 滑窗判定 → 触发 chrome.notifications 和 badge            │
└─────────────────────────────────────────────────────────────┘
        ▲ chrome.runtime.sendMessage              ▲
        │                                          │
┌───────┴───────────────┐                ┌────────┴─────────┐
│ Offscreen Document    │                │ Popup / Dashboard│
│  - getUserMedia       │                │  - 读 IndexedDB  │
│  - MediaPipe 推理      │                │  - 渲染图表       │
│  - EAR 计算 + FSM     │                │  - 开关/设置      │
│  - 仅发送 blink 事件   │                └──────────────────┘
└───────────────────────┘                       │
                                                ▼
                                       ┌────────────────────┐
                                       │ Content Script     │
                                       │ (按需注入:遮罩)    │
                                       └────────────────────┘
```

**为什么需要 Offscreen Document**: MV3 service worker 没有 DOM、不能用 `getUserMedia`。Chrome 109+ 引入 offscreen document 专门承载这类需求。SW 负责持久逻辑、offscreen 负责摄像头与推理。

## 4. 数据流

```
camera frame
   ↓ (offscreen, requestVideoFrameCallback ≈ 30-60fps)
MediaPipe FaceLandmarker.detectForVideo(frame)
   ↓ landmarks
EAR (Eye Aspect Ratio,左右眼平均)
   ↓ ear
眨眼 FSM:
   OPEN  --(ear < CLOSE_THRESH 持续 ≥2 帧)--> CLOSING
   CLOSING --(ear > OPEN_THRESH)--> OPEN  + emit "blink"
   人脸丢失 ≥1.5s --> emit "face_lost"
   人脸恢复 --> emit "face_present"
   ↓
chrome.runtime.sendMessage({type:'blink' | 'face_lost' | 'face_present', t})
   ↓ (service worker)
ring buffer (60s 内的 blink 时间戳,内存)
   ↓ chrome.alarms('minute', period:1)
每分钟:
  - blinks = 过去 1 分钟事件数
  - faceVisibleMs = 过去 1 分钟人脸在位时长
  - 若 faceVisibleMs < 30s → 该分钟标记 "insufficient"
  - 写 IndexedDB: {tsMinute, blinks, faceVisibleMs, status}
  - 滑窗 (默认 5 分钟) 平均 = Σblinks / Σfaceminutes
  - 平均 < 阈值 且 持续 ≥ N 分钟 且 不在冷却窗口 → 触发 reminder
```

**EAR 阈值**: 业界经验 CLOSE 0.20 / OPEN 0.25。首次启动做 10 秒标定,按用户眼型缩放;设置页可手调。

**为什么存分钟桶不存原始事件**: 一天 1440 行,30 天 ~43k 行,占空间小、查询快。原始 blink 时间戳只在内存 ring buffer 里活 60 秒,丢了无影响。

## 5. 文件与模块

```
eyeblinkdetect/
├── manifest.json
├── src/
│   ├── background/
│   │   └── service-worker.ts
│   ├── offscreen/
│   │   ├── offscreen.html
│   │   └── detector.ts
│   ├── popup/
│   │   ├── popup.html
│   │   ├── popup.ts
│   │   └── popup.css
│   ├── dashboard/
│   │   ├── dashboard.html
│   │   ├── dashboard.ts
│   │   └── dashboard.css
│   ├── content/
│   │   └── overlay.ts
│   ├── lib/
│   │   ├── db.ts              IndexedDB (idb 包装)
│   │   ├── ear.ts             landmarks → EAR (纯函数)
│   │   ├── blink-fsm.ts       眨眼状态机 (纯函数)
│   │   ├── aggregator.ts      ring buffer + 分钟聚合 (纯函数)
│   │   ├── reminder-policy.ts 滑窗判定 + 冷却 (纯函数)
│   │   └── messages.ts        类型化消息协议
│   └── models/
│       └── face_landmarker.task   ~3MB,本地打包
├── tests/
│   ├── ear.test.ts
│   ├── blink-fsm.test.ts
│   ├── aggregator.test.ts
│   └── reminder-policy.test.ts
└── package.json / tsconfig.json / vite.config.ts
```

**关键边界**

- `lib/` 全部纯函数无副作用,Vitest Node 环境直接跑,目标覆盖率 90%+
- `offscreen/` 和 `background/` 只做编排(摄像头、消息、存储),不放纯逻辑
- TypeScript + Vite 构建,产物 `dist/` 作为 unpacked extension 加载

## 6. IndexedDB Schema

数据库: `eye-blink-detect`,version 1。

| Store | Key | Value |
|---|---|---|
| `minutes` | `tsMinute` (UTC 分钟戳, number) | `{blinks: number, faceVisibleMs: number, status: 'ok' \| 'insufficient', sessionId: string}` |
| `sessions` | `sessionId` (string, uuid) | `{startedAt: number, endedAt: number\|null, reason: 'manual'\|'idle'\|'error'}` |
| `settings` | string key | JSON value |

`settings` 默认值:

```ts
{
  threshold: { lowBpm: 10, windowMinutes: 5, sustainMinutes: 3 },
  cooldownMinutes: 5,
  reminderModes: { systemNotification: true, fullscreenOverlay: false },
  ear: { closeThresh: 0.20, openThresh: 0.25, personalized: false },
  twentyTwentyTwenty: false,   // 暂不启用 (用户选了"滑窗 + 阈值")
}
```

## 7. 消息协议

`offscreen → service worker`:

```ts
type DetectorMsg =
  | { type: 'blink', t: number }
  | { type: 'face_lost', t: number }
  | { type: 'face_present', t: number }
  | { type: 'error', code: string, message: string }
  | { type: 'calibration_done', closeThresh: number, openThresh: number }
```

`service worker → offscreen`:

```ts
type ControlMsg =
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'recalibrate' }
```

`popup/dashboard ↔ service worker`: 通过 `chrome.runtime.connect` 长连接订阅状态;查询历史走 `chrome.runtime.sendMessage({type:'query', range})`。

## 8. 错误处理与边界情况

| 场景 | 处理 |
|---|---|
| 用户拒绝摄像头权限 | popup 显式提示 + 引导到系统设置,状态置 OFF,不重试 |
| 摄像头被其他 app 占用 | offscreen 抛错 → SW 收到 → badge "!" + 系统通知,需手动重开 |
| 笔记本盖合 / 系统睡眠 | `chrome.idle` 监听 idle/locked → 自动 PAUSE,激活后自动 RESUME |
| 标定阶段有效帧 < 50% | 提示重试,不写个性化阈值,fallback 经验值 |
| 推理 FPS < 10 | 降到 15fps 仍不行 → 切换 detectForImage 2Hz 轮询 |
| 人脸短暂丢失 (< 1.5s) | 不改状态,防止头部小幅转动误判 |
| 人脸长时间丢失 (≥ 1.5s) | 进入 ABSENT,不计 blink 也不计分母 |
| 摄像头设备切换 | `ondevicechange` 重新 enumerate,提醒用户选择 |
| service worker 被 Chrome 杀掉 | 状态持久化在 `chrome.storage.session` + IndexedDB,唤醒后恢复 |
| IndexedDB 写失败 | 队列重试 3 次,仍失败则 popup 顶部红条 |
| 提醒频次失控 | reminder-policy 内置最小间隔 5 分钟冷却,冷却中不再触发同类提醒 |
| 全屏遮罩注入到 chrome:// 等受限页 | 失败回退为系统通知,SW 记 warning |

## 9. 状态机

**Service Worker 状态**

```
       手动开                      idle/locked
OFF ─────────── RUNNING ◄──────────── PAUSED
 ▲              │ ▲                     │
 │ 手动关        │ │ active              │ active
 └──────────────┘ └─────────────────────┘
                  │
                  │ face_lost (≥1.5s)
                  ▼
                 ABSENT
                  │ face_present
                  ▼
                RUNNING
```

`RUNNING` 与 `ABSENT` 都允许聚合写入,区别只是 `ABSENT` 的 faceVisibleMs 不累加。`PAUSED` 完全停摄像头。

## 10. UI

**Popup** (~ 320×400px):
- 顶部: 当前状态 + 大开关按钮
- 中部: 当前 5 分钟平均 BPM (大字) + 与阈值的对比色标
- 下部: 最近 1 小时迷你折线图
- 底部: "打开仪表盘" + "设置"

**Dashboard** (chrome-extension://.../dashboard.html):
- 时间范围切换: 当天 / 7 天 / 30 天 / 全部
- 主图: 折线图 (BPM/分钟),叠加阈值线和提醒事件点
- 副图: 每日总览 (在线时长、平均 BPM、提醒次数)
- 数据导出: CSV / JSON
- 设置区: 阈值、滑窗、冷却、提醒形式、个性化标定按钮

**全屏遮罩** (content script,可选):
- 半透明背景 + 居中卡片 "你最近 5 分钟眨眼太少,看远处 20 秒"
- 20 秒倒计时按钮 / "稍后" 链接

图表库: 暂选 Chart.js (轻量、无 React 依赖)。如未来 UI 复杂化可换。

## 11. 测试策略

**单元测试 (Vitest, Node 环境)**

| 模块 | 覆盖 |
|---|---|
| `ear.ts` | 固定 landmark fixture (睁眼/闭眼/半闭/侧脸),断言 EAR 数值范围 |
| `blink-fsm.ts` | EAR 时间序列输入,断言 emit 的 blink 数与时间戳。覆盖正常眨眼、长闭眼(打瞌睡不算 blink)、连续多次、抖动 EAR 防误判 |
| `aggregator.ts` | blink/face_lost 事件流 + mock 时钟,断言每分钟桶 blinks/faceVisibleMs 对得上 |
| `reminder-policy.ts` | 分钟序列输入,断言:阈值之下持续 N 分钟才触发、冷却窗口生效、人脸不足分母时不计入 |

目标覆盖率 90%+。

**集成测试**: 不做自动化,手测清单:

1. 首装 → 授权 → 10s 标定 → popup 实时心跳 → 1 分钟图表点
2. 关 popup,SW 休眠 30 分钟后重开,数据连续无缺
3. 故意低频眨眼 5 分钟 → 通知触发 → 5 分钟冷却内不再弹
4. 转头离开 30 秒回来 → 分母正确扣除
5. 锁屏 → idle 暂停 → 解锁恢复
6. dashboard 导出 CSV → Excel 列对齐

**TDD 顺序**: `ear → blink-fsm → aggregator → reminder-policy → 编排层`。先写测试,再写实现。

## 12. 隐私

- 不发起任何网络请求。`manifest.json` 不声明 `host_permissions` 中的远程域。
- MediaPipe 的 `.task` 模型文件随扩展包打包到 `src/models/`,推理 wasm 使用 `@mediapipe/tasks-vision` npm 包(本地 bundle)。
- 摄像头权限申请只在用户首次点击"开始"时弹出。
- 隐私页面在仪表盘里显式列出"数据存储位置 / 不外发的承诺 / 如何清除全部数据"。

## 13. 依赖

| 包 | 用途 |
|---|---|
| `@mediapipe/tasks-vision` | 人脸 landmark 推理 (含 wasm) |
| `idb` | IndexedDB 的 Promise 包装 |
| `chart.js` | 图表 |
| `typescript`, `vite`, `vitest` | 构建 + 测试 |

## 14. 验收标准

- 推理稳定 ≥ 15fps;CPU 占用单核 ≤ 30%
- 标定后,正常使用 5 分钟,blink 计数误差 ≤ 15% (对照人工计数)
- 离桌 30 秒返回后,聚合数据中该 30 秒不计入分母
- 阈值低于触发后 5 分钟内不会重复弹同类提醒
- 关闭浏览器再开,30 天历史数据完整可见
- 仪表盘导出 CSV 在 Excel 中列对齐、时间可解析

## 15. 待跟进 / 显式 Out of Scope

- 不做 macOS Sleep / Lid Close 之外的系统级闲置检测
- 不识别"用户在看的是不是屏幕"(只用人脸正面作为代理)
- 不做多用户/多人脸场景:出现多张人脸时,取 bounding box 面积最大的那张
- 不在隐身模式下默认启用(MV3 默认行为)
