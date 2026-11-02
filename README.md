# Live Photo Studio（网页版）

把**视频 / 语音 / 照片**转成实况照片，全程在浏览器里完成，文件不上传任何服务器。

**在线使用：https://core-cz.github.io/live-photo-web/**

| 目标 | 产物 | 格式 |
|---|---|---|
| iPhone / iPad | `IMG_0001.zip`（内含同名 JPG + MOV） | Apple Live Photo：共享 UUID + `still-image-time` 轨 |
| Android | `IMG_0001.MP.jpg` | Google Motion Photo 1.0：MP4 追加在 JPEG 尾部 + XMP + MPF |
| 备用 | `ios-备用.livp` | 仅 macOS「照片」App / AirDrop 到另一台苹果设备时有用 |

> iOS 与 Android 是两套**互不兼容**的容器，一个文件无法被两端同时识别，所以必须给两份。

## 怎么导入（这一步比生成更容易踩坑）

### iPhone / iPad

**不要用 `.livp`** —— iOS 的「文件」App 导不进 `.livp`，这也是很多人「生成了却识别不了」的原因。

正确做法：

1. 下载 `IMG_0001.zip`
2. 打开「文件」App，点 ZIP 解压，得到 `IMG_0001.JPG` 和 `IMG_0001.MOV`
3. 点右上角「选择」，把这两个文件**一起勾上**
4. 点「分享」→「存储到照片」

第 3 步是关键：**必须在同一次操作里同时选中两个文件**，iOS 才会读配对标识符把它们合并成一张实况照片。分开存会变成一张照片 + 一段视频。

存好后打开「照片」，长按照片应该能动。发朋友圈时从相册选这张，左下角有「实况」开关。

### Android

1. 下载 `IMG_0001.MP.jpg`
2. **移动到 `DCIM/Camera` 或 `Pictures` 目录** —— 相册只索引这几个目录，留在 `Download` 里不会出现
3. 打开系统相册，长按照片

厂商差异：OPPO / 一加 / realme、小米、Google 相册可识别；三星用自家 SEFT 格式，不认标准 Motion Photo。

### 两者通用

- **微信 / QQ 普通传输会重新压缩图片并剥掉全部元数据**，测试时务必用数据线或「原图」
- 朋友圈实况上限约 3.9 秒，超了会被转成静态图

## 为什么不用后端

这套格式改写原本依赖 `ffmpeg + MP4Box + exiftool`。网页版把三件事全部用 JS 重写了：

1. **转码**：`ffmpeg.wasm`（单线程 core，无需 COOP/COEP 响应头，因此能跑在 GitHub Pages 上）
2. **still-image-time 轨道**：从一份真实 Live Photo 里取出的 `trak` 二进制模板，整块搬进新视频的 `moov` 尾部，只修正 `stco` / `tkhd` / `elst`
3. **UUID 配对**：JPEG 侧手写 Apple MakerNote（`0x0011`），MOV 侧覆盖 `meta` 盒模板里的 36 字节 UUID

## Android 侧的三个硬性要求

这部分是最容易做错的地方，全部来自真机 A/B 二分实验的结论，而不是文档：

1. **MPF 必须是双条目**（`NumberOfImages=2`，Primary + GainMap），并且要有**实体 GainMap 数据**和 **16 字节 0 填充**。只写 XMP 字段在 ColorOS / 一加上永远显示静态图——识别开关根本不在这堆字段上。
2. **EXIF 的 `Make` 不能是 Apple**。相册看到 `Make="Apple"` 或 Apple MakerNote 会直接走「去找同名 MOV」的配对分支，对内嵌视频视而不见。所以 Android 版和 iOS 版必须是两份不同的 JPEG。
3. **视频必须是双轨**（视频 + AAC）。带 `mebx` 元数据轨的多轨结构会让 OPPO 播放器「识别正常但播放失败」，所以 Android 版用的是注入 UUID 之前的原始片段。

视频定位靠「文件尾回退 `Item:Length` 字节」，所以视频必须紧贴 EOF，长度字段错一个字节就废。

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
│   ├── exif.js         iOS / Android 两套 EXIF + MakerNote
│   ├── motion.js       Android Motion Photo（MPF + GainMap）
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

- Chrome / Edge 80+、Safari 16.4+、iOS 16.4+、微信内置浏览器
- 依赖 `DecompressionStream`（用于解压 wasm）；更老的浏览器会给出明确提示

## 已知限制

- 纯前端转码受设备性能限制，长视频建议先裁到 10 秒内
- iPhone 13 上 3 秒 720p 约 1.5 秒出片，照片 Ken Burns 约 3 秒，语音波形约 8 秒

## 相关

- 后端版本（FastAPI + ffmpeg + MP4Box + exiftool）：[live-photo-studio](https://github.com/core-cz/live-photo-studio)
- 元数据轨模板来自 [tmfadhlul/apple-video-to-livephotos](https://github.com/tmfadhlul/apple-video-to-livephotos)（MIT）
- Android 布局参考 [weibo-image-downloader/LIVEPHOTO.md](https://github.com/gbandszxc/weibo-image-downloader/blob/main/docs/LIVEPHOTO.md) 的真机逆向结论

## License

MIT
