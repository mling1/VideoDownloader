# VideoDownloader

MSE 流媒体视频捕获与无损合成下载工具（Tampermonkey 油猴脚本）。

通过劫持 MediaSource Extension（MSE）的 `SourceBuffer.prototype.appendBuffer`，被动捕获网页播放器投喂的音视频 fMP4 分片，再用 mp4box.js 无损合成为**单个可正常播放、可拖动进度条、有声的 MP4 文件**。

## 功能特性

- **全站点通用**：只要网站使用 MSE 播放流媒体（B 站、腾讯视频、优酷等），均可捕获
- **原型级劫持**：直接劫持 `SourceBuffer.prototype.appendBuffer`，不依赖拦截 `addSourceBuffer`，注入稍晚也能稳定捕获分片
- **无损合成**：容器级 remux，不重新编码，画质音质无损；输出普通 MP4（非 fragmented），支持进度条拖动
- **音视频自动分类**：优先按 MIME 分类，缺失时通过 init segment 的 hdlr box 自动识别，最终兜底按数据大小区分
- **新流自动重置**：检测到新的 init segment（ftyp）自动清空旧缓存，切换视频不会新旧分片混杂
- **自动完整下载**：一键静音+16 倍速+隐藏画面对完整视频进行静默捕获，完成后自动合成下载
- **倍速加速**：1×/2×/4× 短按切换，长按 16×，加速视频加载和捕获
- **跳至结尾**：一键跳到视频结尾，触发剩余分片加载
- **完整性检测**：下载前检测缓冲是否完整，不完整时给出提示
- **在线兜底**：无法自动合成时，提供在线工具入口处理 m3u8 流

## 安装

### 一键安装（推荐）

确保已安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展，然后点击下方链接，油猴会自动弹出安装界面：

👉 **[点击安装 VideoDownloader](https://raw.githubusercontent.com/mling1/VideoDownloader/main/VideoDownloader.user.js)**

### 手动安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展
2. 打开 Tampermonkey 管理面板 → 「添加新脚本」
3. 删除默认模板，将 `VideoDownloader.user.js` 的全部内容粘贴进去
4. `Ctrl+S` 保存
5. 打开任意使用 MSE 播放的视频网站，页面右上角会出现蓝色面板

## 使用

| 按钮 | 功能 |
|------|------|
| 下载已捕获片段 (N) | 手动下载当前已捕获的分片（合成单个 MP4） |
| 1× / 2× / 4× | 短按切换倍速，长按切换 16× |
| 跳至结尾 | 跳到视频结尾，触发剩余分片加载 |
| 自动完整下载 | 静音+16 倍速+隐藏画面，从头静默捕获完整视频后自动下载 |
| 在线完整下载 | 无法自动合成时的兜底入口（跳转在线工具） |

**推荐用法**：打开视频后点击「自动完整下载」，等待静默捕获完成即可得到完整 MP4。

## 技术原理

1. **捕获层**：`document-start` 注入，劫持 `SourceBuffer.prototype.appendBuffer` 原型方法，将每次投喂的 fMP4 分片复制保存。用 `WeakMap` 建立 SourceBuffer 实例→{mime, buffers, kind} 映射。
2. **分类层**：优先按 `addSourceBuffer` 传入的 MIME 分类音视频；MIME 缺失时通过解析 init segment（ftyp+moov）中第一个 track hdlr box 的 handler_type（`vide`/`soun`）自动识别。
3. **合成层**：用 mp4box.js 分别解析音视频 fMP4 流，提取所有样本（sample），手动构建普通 MP4 的 sample table（stts/stsc/stsz/stco/stss），将所有样本数据拼入单个 mdat，输出非 fragmented MP4。
4. **关键修复**：音频轨必须显式设置 `tkhd.volume=1`（mp4box addTrack 默认 volume=0，会导致严格播放器无声）；视频轨补 stss 关键帧索引以支持 seek。

## 参考与致谢

本项目的 MSE 劫持思路参考了以下开源项目：

- [media-source-extract](https://github.com/Momo707577045/media-source-extract) — 毛静文（Momo707577045）的「无差别视频提取工具」，提供了 MSE 被动捕获的核心思路
- [m3u8-downloader](https://github.com/Momo707577045/m3u8-downloader) — 同作者的 m3u8 在线下载工具

> 注：上述参考项目未附带开源许可证文件，仅声明"仅用于学习交流"。本项目在其思路基础上做了大幅重构（原型级劫持、普通 MP4 手动合成、自动完整下载、UI 重构等），核心代码为独立实现。如原作者对二次发布有异议，请联系处理。

## 第三方依赖

- [mp4box.js](https://github.com/gpac/mp4box.js) — GPAC 出品的 MP4 处理库，**BSD-3-Clause 许可证**，通过 CDN 按需加载

## 许可证

[MIT License](./LICENSE)

## 免责声明

本工具仅供个人学习和研究使用，请勿用于侵犯他人知识产权或违反网站服务条款的行为。下载的视频版权归原网站及版权方所有，请遵守相关法律法规。
