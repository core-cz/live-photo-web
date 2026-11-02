# Live Photo Studio（网页版）

把**视频 / 语音 / 照片**转成实况照片，直接在浏览器里完成，文件不上传任何服务器。

| 目标 | 产物 | 说明 |
|---|---|---|
| iPhone / iPad | `IMG_0001.livp` | Apple Live Photo，JPG + MOV 双文件 + 共享 UUID + `still-image-time` 轨 |
| Android | `IMG_0001.MP.jpg` | Google Motion Photo 1.0，MP4 字节追加在 JPEG 尾部 |
| 两者 | `live-photo.zip` | 两套文件 + 导入说明 |

> iOS 与 Android 是两套**互不兼容**的容器，一个文件无法同时被两端识别，所以必须生成两份。

## 在线使用

**https://core-cz.github.io/live-photo-web/**

打开即用，首次点「生成」时会下载约 10MB 编码器（之后走浏览器缓存）。文件全程留在本地，不会上传。

## 为什么不用后端

这套格式改写原本依赖 `ffmpeg + MP4Box + exiftool`。网页版把三件事全部用 JS 重写了：

1. **转码**：`ffmpeg.wasm`（单线程 core，无需 COOP/COEP 响应头，因此能跑在 GitHub Pages 上）
2. **still-image-time 轨道**：从一份真实 Live Photo 里取出的 `trak` 二进制模板，整块搬到新视频的 `moov` 尾部，只修正 `stco` / `tkhd` / `elst`
3. **UUID 配对**：JPEG 侧手写 Apple MakerNote（`0x0011`），MOV 侧直接覆盖 `meta` 盒模板里的 36 字节 UUID

模板法比从头拼 box 稳得多——`mebx` 轨的 `keys` 嵌套结构、`next_track_ID` 偏移、FullBox 标志位，任何一处算错都会让 iOS 直接当普通视频处理。

## 目录

```
index.html              单页界面
assets/
├── app.js              交互逻辑
├── style.css
├── metadata_tpl.mov    真实 still-image-time 元数据轨（10KB）
├── lib/
│   ├── pipeline.js     转码 → 抽封面 → 写元数据 → 打包
│   ├── livephoto.js    注入元数据轨 + 写 content.identifier
│   ├── box.js          MP4 box 解析
│   ├── cover.js        canvas 抽封面
│   ├── exif.js         Apple MakerNote
│   ├── motion.js       Android Motion Photo
│   └── zip.js          最小 ZIP 打包
└── vendor/             ffmpeg.wasm（core 以 gzip 存放，加载时用 DecompressionStream 解压）
```

## 本地运行

任意静态服务器即可（不能直接双击 `index.html`，ES module 和 fetch 需要 http 协议）：

```bash
python3 -m http.server 8080
# 打开 http://localhost:8080
```

## 兼容性

- Chrome / Edge 80+、Safari 16.4+、iOS 16.4+、微信内置浏览器（X5 / WKWebView）
- 依赖 `DecompressionStream`（用于解压 wasm）；更老的浏览器会给出明确提示

## 已知限制

- **iOS 不能从网页直接写相册**。下载的 `.livp` 需要 AirDrop，或在「文件」App 里打开后导入相册。
- **微信朋友圈上限约 3.9 秒**，超出会被平台转成静态图。
- 纯前端转码受设备性能限制，长视频建议先自行裁剪到 10 秒内。
- 个别 Android 厂商只识别自家格式，标准 Motion Photo 1.0 在多数机型可用。

## 相关

- 后端版本（FastAPI + ffmpeg + MP4Box + exiftool）：[live-photo-studio](https://github.com/core-cz/live-photo-studio)
- 元数据轨模板来自 [tmfadhlul/apple-video-to-livephotos](https://github.com/tmfadhlul/apple-video-to-livephotos)（MIT）

## License

MIT
