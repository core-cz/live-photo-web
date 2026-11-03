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

## 两个槽位

界面是两个上传框，互相组合：

| 主素材（画面） | 副素材（声音或动态） | 结果 |
|---|---|---|
| 照片 | 语音 | 照片缓慢推近 + 这段语音 |
| 照片 | 视频 | **用副素材的视频当动态**，主素材的照片当封面 |
| 视频 | 语音 | 视频画面 + 换成这段语音 |
| 实况照片 | 空 | 原样直通，一个字节都不改 |
| 实况照片 | 语音 | 复用画面，替换音轨 |

## 三条输入路径

同一个入口要吃三种完全不同的素材，分开处理才不会互相拖累：

| 输入 | 处理方式 | 音轨 |
|---|---|---|
| **已有实况照片**（JPEG 尾部挂 MP4，剪映/手机相册导出） | 解析出文件尾那段 MP4，**原样直通**（`-c:v copy`），封面用原图重编码 | 保留原始 AAC |
| 视频 / 音频 | 转 H.264，封面落在第 0.5 秒 | 保留；原片无音轨则补静音 AAC |
| 普通照片 | 缓慢推近（Ken Burns） | **补一条静音 AAC** |

前两条是踩坑踩出来的：

- 只按扩展名判断类型，会把一条 9 秒 HEVC+AAC 的实况照片当成「一张静态图」，
  重新做 3 秒推镜 —— 结果就是**能识别、但没声音、只播几秒**。所以先找 EOI，
  再在尾部找 `ftyp`，命中就按视频处理。
- 剪映导出的实况全是 HEVC，wasm 里解得了但编不动（libx265 单线程编码 6 秒要 4 分钟），
  而原片本来就是相册和微信都认的规格，所以直接 copy，不重编码。
- 静态图必须补静音 AAC：剪映的每条实况都是 video+aac 双轨，纯视频容器在微信里
  经常表现为「图标在、点开不播」。
- 复用别人的实况时，**连视频字节一起复用**：`-c copy` 重封装会丢掉原片
  `udta/meta`（`LvMetaInfo`、`Hw` 等），微信对这类改动很敏感，会提示「格式不全」，
  而微博能读。所以整段复用的场景直接跳过 ffmpeg，视频与原件逐字节相同。
- 定格帧时间戳要**沿用原片的** `MotionPhotoPresentationTimestampUs`（剪映写 1.5s），
  不能一律按 0.5s 写，否则播放器从错误的帧起播。

## Android 侧的八条硬性要求

这一节的结论全部来自与「剪映 21.8.0 导出产物」的逐字节比对，而不是文档：

1. **段序固定** `Exif → XMP → JFIF → ICC → MPF`，XMP 紧跟 EXIF，MPF 排在所有 APP 段最后。
2. **MPF 只有一条 Primary**（`NumberOfImages=1`）。伪造 `NumberOfImages=2 + GainMap` 会让播放器把副本当第二张图，结果是「识别成实况、开关自动打开、一点就播不出来」。
3. **视频紧贴主图 EOI**，中间零填充、零副本。播放器定位视频有两种算法：「EOF − `Item:Length`」和「扫到主图 EOI 之后」，中间多塞任何字节后者就废。
4. **EXIF 不写 `Make`／`Model`**。写 `Apple` 会进 iOS 配对分支；写 `Google`/`Pixel` 会让微信把它当 Pixel Motion Photo。剪映真实产物这两个字段是空的。
5. **ftyp 必须是 isom 版式**（`isom` + `iso2` / `<实际编码>` / `mp41`）。HEVC 源就写 `hvc1`，别一律写 `avc1`。ffmpeg 默认的 `qt  ` 单 brand 头会被部分国产相册当成 QuickTime 直接跳过；重建时同步修正 `stco`/`co64` 偏移。
6. **视频是单轨**（视频 + AAC）。带 `mebx` 元数据轨的多轨结构会让 OPPO 播放器「识别正常但播放失败」，所以 Android 版用注入 UUID 之前的原始片段。
7. **ExifIFD 里的 `UserComment` 必须保留**，并且要带 `oplus` 标记（剪映写 `{"oplustag":8388608,...}`）。这条是回归验证出来的：一度以为「少即是多」把它删干净，结果 ColorOS 相册和微信双双认不出来。`Make`/`Model` 可以空，`UserComment` 不能。**`source_type` 必须是 `douyin_beauty_me`**——剪映写的就是这个值，不是 `live_photo_export`；写错时 ColorOS 认、微信掉图标。
8. **moov 里必须带 `udta → meta(mdta) → keys + ilst`**，七个私有键 `DreaminaMetaInfo / Hw / LvMetaInfo / bitrate / maxrate / te_is_reencode / encoder`，`LvMetaInfo` 的值与 `UserComment` 是同一段 JSON。ffmpeg 重封装会把它换成 33 字节的空 udta（只含 `©swr Lavf…`），所以不能只判断「有没有 udta」，必须判断「有没有 meta」，缺了就合并进去。

## 为什么本机会提示「规格较高」

ColorOS 对实况视频的尺寸有个软上限：剪映导出的是 **480×852**（短边 480）。超过这个尺寸，相册会提示「该实况照片规格较高，播放时可能会卡顿」，然后切到降级播放路径——**画面还能动，声音没了**。所以流水线把短边一律压到 480，用户自己传的 1080p 视频也会重编码到这个尺寸（`libx264 -preset ultrafast -crf 24 -profile:v baseline`）。

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
│   ├── embedded.js     从实况照片里取内嵌视频 / 音轨判断 / 定格时间戳
│   ├── box.js          MP4 box 解析
│   ├── cover.js        canvas 抽封面
│   ├── exif.js         iOS / Android 两套 EXIF + MakerNote
│   ├── motion.js       Android Motion Photo（单条目 MPF + ftyp 重建）
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
