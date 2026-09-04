// ==UserScript==
// @name         VideoDownloader
// @namespace    https://doubao.com
// @version      1.0.7
// @author       mling1
// @description  MSE流媒体视频捕获与无损合成下载工具
// @include      *
// @exclude      http://blog.luckly-mjw.cn/tool-show/media-source-extract/player/player.html
// @grant        none
// @run-at       document-start
// @all-frames   true
// ==/UserScript==
(function () {
  'use strict';
  if (document.getElementById('vd-panel')) return;

  // ========== 第一步：立刻劫持MSE原型，不等待任何库 ==========
  const nativeToString = Function.prototype.toString;
  function wrapAsNative(fn) {
    fn.toString = () => nativeToString.call(nativeToString);
    return fn;
  }

  // 全局状态
  let fragCount = 0;
  let sourceBufferList = [];
  let endConfirmShown = false;
  let streamEnded = false;
  let countPending = false;
  let autoDownload = false;
  let autoDownloadDone = false; // 防止自动下载被重复触发
  let mseHijacked = false;
  let sbHijacked = false; // SourceBuffer原型是否已劫持
  // 自动捕获时临时修改的视频状态（静音+隐藏画面），下载结束后恢复
  let hiddenVideoState = null;
  // SourceBuffer实例 -> {mime,buffers,kind} 的映射（原型劫持时靠它拿到mime）
  const sbEntryMap = new WeakMap();
  // 已见过的MediaSource实例，用于识别"新流开始"并清空上一个视频的缓存
  const seenMediaSources = new WeakSet();

  // 通用：把任意类型的buffer（ArrayBuffer/TypedArray/DataView）复制为独立的ArrayBuffer
  // MSE的appendBuffer参数可以是这三种类型，必须统一处理，否则concat时会报错
  function toArrayBufferCopy(buf) {
    if (!buf) return buf;
    if (buf instanceof ArrayBuffer) return buf.slice(0);
    if (ArrayBuffer.isView(buf)) {
      // TypedArray或DataView，从底层buffer复制指定范围
      const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      return u8.slice().buffer;
    }
    return buf;
  }

  // 通过init segment内容判断音视频：ftyp+moov中第一个track hdlr box，
  // 'hdlr'后跳过version/flags(4)+pre_defined(4)，第12字节起是vide/soun
  function detectKindFromInit(buf) {
    try {
      const u8 = new Uint8Array(buf);
      const limit = Math.min(u8.length, 8192);
      for (let i = 0; i + 16 <= limit; i++) {
        if (u8[i] === 0x68 && u8[i + 1] === 0x64 && u8[i + 2] === 0x6c && u8[i + 3] === 0x72) {
          const t = String.fromCharCode(u8[i + 12], u8[i + 13], u8[i + 14], u8[i + 15]);
          if (t === 'vide') return 'video';
          if (t === 'soun') return 'audio';
          // 命中moov级hdlr（mdirappl）则继续找track级
        }
      }
    } catch (e) {}
    return '';
  }

  // 判断一个捕获条目是video还是audio（优先mime，缺失时用init内容kind兜底）
  function itemKind(item) {
    const m = (item.mime || '').toLowerCase();
    if (m.includes('video')) return 'video';
    if (m.includes('audio')) return 'audio';
    return item.kind || '';
  }

  // 新流开始：清空上一个视频残留的捕获缓存
  function resetCaptureState() {
    sourceBufferList = [];
    fragCount = 0;
    endConfirmShown = false;
    streamEnded = false;
    autoDownloadDone = false;
  }

  // 注册（或取回）一个SourceBuffer实例对应的捕获条目
  function registerSourceBuffer(sb, mime) {
    let entry = sbEntryMap.get(sb);
    if (!entry) {
      entry = { mime: mime || '', buffers: [], kind: '' };
      sbEntryMap.set(sb, entry);
      sourceBufferList.push(entry);
      renderPanel();
    } else if (mime) {
      entry.mime = mime;
    }
    return entry;
  }

  // ========== 核心劫持①：SourceBuffer.prototype.appendBuffer（最可靠的全局捕获点） ==========
  // document-start时SourceBuffer是浏览器内置对象、必然已存在；所有SourceBuffer实例的
  // appendBuffer都走这个原型方法。直接劫持原型，不依赖"能否拦截到addSourceBuffer"，
  // 从根本上解决劫持稍晚、SourceBuffer已创建后一个分片都捕获不到的问题。
  function hijackSourceBuffer() {
    const SB = window.SourceBuffer;
    if (sbHijacked || !SB || !SB.prototype) return;
    sbHijacked = true;
    const proto = SB.prototype;

    const origAppend = proto.appendBuffer;
    proto.appendBuffer = wrapAsNative(function (buf) {
      try {
        let entry = sbEntryMap.get(this);
        if (!entry) entry = registerSourceBuffer(this, this.mimeType || '');
        const copy = toArrayBufferCopy(buf);
        // 检测init segment（ftyp box开头）：代表一条新流开始，
        // 清空该轨旧缓存，确保buffers[0]是init。同时解决"切换视频/重建缓冲区后
        // 旧分片与新分片混在一起、重复捕获"的问题。
        if (copy.byteLength >= 8) {
          const u8 = new Uint8Array(copy);
          const fb = String.fromCharCode(u8[4], u8[5], u8[6], u8[7]);
          if (fb === 'ftyp') {
            entry.buffers = [];
            entry.kind = '';
          }
        }
        fragCount++;
        entry.buffers.push(copy);
        // mime缺失（addSourceBuffer没拦截到）时，用init segment内容兜底判断音视频
        if (!entry.kind) {
          const k = detectKindFromInit(copy);
          if (k) entry.kind = k;
        }
        if (!countPending) {
          countPending = true;
          requestAnimationFrame(() => {
            if (btnDownload) btnDownload.textContent = `下载已捕获片段 (${fragCount})`;
            countPending = false;
          });
        }
      } catch (e) { /* 捕获逻辑绝不能影响网站正常播放 */ }
      return origAppend.call(this, buf);
    });

    // 切换编码（changeType）时同步更新mime
    if (proto.changeType) {
      const origChange = proto.changeType;
      proto.changeType = wrapAsNative(function (mime) {
        const e = sbEntryMap.get(this);
        if (e) { e.mime = mime || e.mime; e.kind = ''; }
        return origChange.call(this, mime);
      });
    }
  }

  // ========== 核心劫持②：MediaSource.addSourceBuffer/endOfStream（拿准确mime、识别新流） ==========
  function hijackMediaSource() {
    if (mseHijacked || !window.MediaSource) return;
    mseHijacked = true;

    const MS = window.MediaSource;

    const origEnd = MS.prototype.endOfStream;
    MS.prototype.endOfStream = wrapAsNative(function () {
      streamEnded = true;
      if (!endConfirmShown) {
        endConfirmShown = true;
        // 自动下载模式：静默下载，不弹confirm；用autoDownloadDone防止重复触发
        if (autoDownload && !autoDownloadDone) {
          autoDownloadDone = true;
          autoDownload = false;
          download(true, true);
        } else if (!autoDownload) {
          // 非自动下载模式：正常弹confirm
          const complete = isBufferedComplete();
          const msg = complete
            ? '✅ 视频已完整加载，资源全部捕获成功，是否下载？'
            : '⚠️ 视频未完整加载，下载可能损坏。是否继续？';
          if (confirm(msg)) download(true, false);
        }
      }
      origEnd.call(this);
    });

    const origAdd = MS.prototype.addSourceBuffer;
    MS.prototype.addSourceBuffer = wrapAsNative(function (mime) {
      // 每个全新MediaSource实例第一次addSourceBuffer代表一条新流，清空上一条流的残留缓存
      if (!seenMediaSources.has(this)) {
        seenMediaSources.add(this);
        resetCaptureState();
      }
      const sb = origAdd.call(this, mime);
      registerSourceBuffer(sb, mime);
      return sb;
    });
  }

  // 劫持所有同源媒体源构造器（标准MediaSource + 可能的Managed/WebKit前缀）
  function hijackAllMediaSources() {
    hijackSourceBuffer();
    hijackMediaSource();
    // 兼容ManagedMediaSource（MSEv2）等，其prototype上的addSourceBuffer也要劫持
    ['ManagedMediaSource', 'WebKitMediaSource'].forEach(name => {
      const Ctor = window[name];
      if (Ctor && Ctor.prototype && Ctor.prototype.addSourceBuffer && Ctor !== window.MediaSource) {
        if (!Ctor.prototype.__vdAddWrapped) {
          Ctor.prototype.__vdAddWrapped = true;
          const origAdd = Ctor.prototype.addSourceBuffer;
          Ctor.prototype.addSourceBuffer = wrapAsNative(function (mime) {
            if (!seenMediaSources.has(this)) { seenMediaSources.add(this); resetCaptureState(); }
            const sb = origAdd.call(this, mime);
            registerSourceBuffer(sb, mime);
            return sb;
          });
        }
      }
    });
  }

  // 立即劫持（document-start时SourceBuffer/MediaSource这两个浏览器内置对象通常已存在）
  hijackAllMediaSources();

  // 兜底：若内置对象此刻还没就位，用defineProperty零延迟监听 + 1ms轮询双保险
  if (!sbHijacked || !mseHijacked) {
    const ensure = () => hijackAllMediaSources();
    // 监听window.MediaSource / window.SourceBuffer被赋值的瞬间
    ['MediaSource', 'SourceBuffer'].forEach(name => {
      if (window[name]) return;
      let _v;
      try {
        Object.defineProperty(window, name, {
          configurable: true,
          get() { return _v; },
          set(v) { _v = v; ensure(); }
        });
      } catch (e) {}
    });
    const poll = setInterval(() => {
      ensure();
      if (sbHijacked && mseHijacked) clearInterval(poll);
    }, 1);
    setTimeout(() => clearInterval(poll), 10000);
  }

  // ========== 基础兼容层 ==========
  function fixSandboxIframe(iframe) {
    try {
      if (!iframe.hasAttribute('sandbox')) return;
      const clone = iframe.cloneNode();
      clone.removeAttribute('sandbox');
      iframe.replaceWith(clone);
    } catch (e) {}
  }
  document.addEventListener('DOMContentLoaded', () => {
    new MutationObserver(muts => {
      muts.forEach(m => m.addedNodes.forEach(node => {
        if (node.nodeType !== 1) return;
        if (node.tagName === 'IFRAME') fixSandboxIframe(node);
        else node.querySelectorAll?.('iframe').forEach(fixSandboxIframe);
      }));
    }).observe(document.documentElement, { childList: true, subtree: true });
    document.querySelectorAll('iframe').forEach(fixSandboxIframe);
  });

  // ========== UI全局变量 ==========
  let expanded = false;
  let m3u8Url = null;
  let merging = false;
  let scanTimer = null;
  let btnDownload, btnSpeed, btnSkip, btnAuto, btnOnline;

  // 倍速配置
  const normalSpeeds = [1, 2, 4];
  let speedIndex = 0;
  let is16x = false;
  let pressTimer = null;
  const pressDelay = 500;

  const ONLINE_TOOL = 'http://blog.luckly-mjw.cn/tool-show/media-source-extract/player/player.html';

  // ========== mp4box库按需加载 ==========
  let mp4boxLoaded = false;

  function loadScript(url) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.onload = resolve;
      s.onerror = () => reject(new Error('脚本加载失败: ' + url));
      document.head.appendChild(s);
    });
  }

  async function loadMp4Box() {
    if (mp4boxLoaded) return;
    await loadScript('https://cdn.jsdelivr.net/npm/mp4box@0.5.2/dist/mp4box.all.min.js');
    mp4boxLoaded = true;
  }

  // ========== 工具函数 ==========
  function getTitle() {
    try { return window.top.document.title; }
    catch { return document.title; }
  }

  function isBufferedComplete() {
    const v = document.querySelector('video');
    if (!v?.duration || v.buffered.length === 0) return false;
    return v.buffered.start(0) < 1 && (v.duration - v.buffered.end(v.buffered.length - 1)) < 1;
  }

  function concatBufs(bufs) {
    const len = bufs.reduce((s, b) => s + b.byteLength, 0);
    const res = new Uint8Array(len);
    let off = 0;
    bufs.forEach(b => { res.set(new Uint8Array(b), off); off += b.byteLength; });
    return res.buffer;
  }

  function openOnlineTool() {
    // 有m3u8地址时带参数打开，没有时直接打开工具主页
    const url = m3u8Url ? `${ONLINE_TOOL}?url=${encodeURIComponent(m3u8Url)}` : ONLINE_TOOL;
    window.open(url, '_blank');
  }

  // 合成失败自定义弹窗：提供分开下载、在线完整下载、取消三个选项
  function showMergeFailDialog(complete, errorMsg, onSeparate) {
    // 移除已有弹窗
    const old = document.getElementById('vd-merge-fail-dialog');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = 'vd-merge-fail-dialog';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:2147483647;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,sans-serif;';

    const dialog = document.createElement('div');
    dialog.style.cssText = 'background:#fff;border-radius:12px;padding:24px;max-width:420px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.2);';

    const title = document.createElement('div');
    title.style.cssText = 'font-size:16px;font-weight:600;margin-bottom:12px;color:#1a1a1a;';
    title.textContent = '视频合成失败';

    const status = document.createElement('div');
    status.style.cssText = `font-size:13px;margin-bottom:8px;padding:8px 12px;border-radius:6px;${complete ? 'background:#e6f7ea;color:#1a7f37;' : 'background:#fff4e5;color:#9a6700;'}`;
    status.textContent = complete ? '✅ 视频已完整加载' : '⚠️ 视频未完整加载';

    const error = document.createElement('div');
    error.style.cssText = 'font-size:13px;color:#666;margin-bottom:16px;line-height:1.5;word-break:break-all;';
    error.textContent = '错误信息：' + (errorMsg || '未知错误');

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';

    const btnSeparate = document.createElement('button');
    btnSeparate.style.cssText = 'flex:1;min-width:100px;padding:8px 12px;border:1px solid #d0d7de;border-radius:6px;background:#f6f8fa;color:#1a1a1a;font-size:13px;cursor:pointer;';
    btnSeparate.textContent = '分开下载';
    btnSeparate.onclick = () => { overlay.remove(); onSeparate(); };

    const btnOnline = document.createElement('button');
    btnOnline.style.cssText = 'flex:1;min-width:100px;padding:8px 12px;border:1px solid #0969da;border-radius:6px;background:#0969da;color:#fff;font-size:13px;cursor:pointer;';
    btnOnline.textContent = '在线完整下载';
    btnOnline.onclick = () => { overlay.remove(); openOnlineTool(); };

    const btnCancel = document.createElement('button');
    btnCancel.style.cssText = 'flex:1;min-width:80px;padding:8px 12px;border:1px solid #d0d7de;border-radius:6px;background:#fff;color:#666;font-size:13px;cursor:pointer;';
    btnCancel.textContent = '取消';
    btnCancel.onclick = () => { overlay.remove(); };

    btnRow.appendChild(btnSeparate);
    btnRow.appendChild(btnOnline);
    btnRow.appendChild(btnCancel);

    dialog.appendChild(title);
    dialog.appendChild(status);
    dialog.appendChild(error);
    dialog.appendChild(btnRow);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
  }

  // ========== 核心修复：mp4box无损合成（修复时序：数据喂完后才start） ==========
  async function mergeMP4(videoBufs, audioBufs) {
    await loadMp4Box();
    return new Promise((resolve, reject) => {
      try {
        const vFile = MP4Box.createFile();
        const aFile = MP4Box.createFile();
        const outFile = MP4Box.createFile();
        let vSamples = [], aSamples = [];
        let vInfo = null, aInfo = null;
        let vReady = false, aReady = false;
        let vDataFed = false, aDataFed = false;
        let vStarted = false, aStarted = false;
        let finished = false;

        // 视频onReady：只设置提取选项，不立即start（数据还没喂完）
        vFile.onReady = info => {
          vInfo = info;
          if (!info.videoTracks?.[0]) {
            reject(new Error('未找到视频轨道'));
            return;
          }
          vFile.setExtractionOptions(info.videoTracks[0].id, null, { nbSamples: 1000000 });
          vReady = true;
          tryStart();
        };
        vFile.onSamples = (id, user, samples) => {
          vSamples = vSamples.concat(samples);
        };
        vFile.onError = e => { if (!finished) reject(new Error('视频解析错误: ' + e)); };

        // 音频onReady：只设置提取选项，不立即start
        aFile.onReady = info => {
          aInfo = info;
          if (!info.audioTracks?.[0]) {
            reject(new Error('未找到音频轨道'));
            return;
          }
          aFile.setExtractionOptions(info.audioTracks[0].id, null, { nbSamples: 1000000 });
          aReady = true;
          tryStart();
        };
        aFile.onSamples = (id, user, samples) => {
          aSamples = aSamples.concat(samples);
        };
        aFile.onError = e => { if (!finished) reject(new Error('音频解析错误: ' + e)); };

        // 关键：两个都ready且数据都喂完后，才调用start
        function tryStart() {
          if (!vReady || !aReady || !vDataFed || !aDataFed) return;
          if (!vStarted) { vFile.start(); vStarted = true; }
          if (!aStarted) { aFile.start(); aStarted = true; }
          // start后等待样本提取完成
          waitForCompletion();
        }

        // 等待样本数不再增加
        let lastVCount = -1, lastACount = -1, stableCount = 0;
        function waitForCompletion() {
          if (finished) return;
          if (vSamples.length === lastVCount && aSamples.length === lastACount) {
            stableCount++;
            if (stableCount >= 5) { // 连续5次检测无变化，认为完成
              finish();
              return;
            }
          } else {
            stableCount = 0;
            lastVCount = vSamples.length;
            lastACount = aSamples.length;
          }
          setTimeout(waitForCompletion, 150);
        }

        function finish() {
          if (finished) return;
          finished = true;

          if (vSamples.length === 0) {
            reject(new Error('视频样本提取失败（0个样本）'));
            return;
          }
          if (aSamples.length === 0) {
            reject(new Error('音频样本提取失败（0个样本）'));
            return;
          }

          try {
            const vTrack = vInfo.videoTracks[0];
            const aTrack = aInfo.audioTracks[0];
            // 根据codec判断mp4box的type字段（avc1/hvc1/av01，不是video）
            const vCodec = vTrack.codec || '';
            let vType = 'avc1';
            if (vCodec.startsWith('hvc1') || vCodec.startsWith('hev1')) vType = 'hvc1';
            else if (vCodec.startsWith('av01')) vType = 'av01';

            // 创建输出track。必须显式指定hdlr：视频vide、音频soun，
            // 否则addTrack默认handler="vide"，音频轨会被当成视频轨导致无声
            outFile.addTrack({
              timescale: vTrack.timescale,
              width: vTrack.video?.width || 1920,
              height: vTrack.video?.height || 1080,
              codec: vCodec,
              language: vTrack.language || 'und',
              type: vType,
              hdlr: 'vide',
              name: 'Video'
            });
            outFile.addTrack({
              timescale: aTrack.timescale,
              codec: aTrack.codec,
              language: aTrack.language || 'und',
              type: 'mp4a',
              hdlr: 'soun',
              name: 'Audio',
              audio: {
                sample_rate: aTrack.audio?.sample_rate || 44100,
                channel_count: aTrack.audio?.channel_count || 2,
                sample_size: aTrack.audio?.sample_size || 16
              }
            });

            // 视频轨音量0；音频轨必须显式设为1（mp4box addTrack默认volume=0，
            // 不设的话严格播放器会按tkhd.volume=0静音；write时内部 1<<8=0x0100=满音量。
            // 注意绝不能设256：256<<8会溢出writeInt16变成0）
            outFile.moov.traks[0].tkhd.volume = 0;
            outFile.moov.traks[1].tkhd.volume = 1;

            const vStbl = outFile.moov.traks[0].mdia.minf.stbl;
            const aStbl = outFile.moov.traks[1].mdia.minf.stbl;

            // 用原始sample entry整体替换，完整保留codec配置box（av1C/avcC/hvcC/esds/pasp）
            if (vSamples[0]?.description) vStbl.stsd.entries[0] = vSamples[0].description;
            if (aSamples[0]?.description) aStbl.stsd.entries[0] = aSamples[0].description;

            // 手动构建普通MP4（non-fragmented）的sample table。
            // addSample生成的是fragmented MP4（每样本一个moof/mdat、sample table为空），
            // 会导致无法拖动进度条、部分播放器无声；普通MP4用一个mdat+完整sample table。
            function fillStbl(stbl, samples, isVideo) {
              // stts：对连续相同duration做run-length编码
              const counts = [], deltas = [];
              for (const s of samples) {
                if (deltas.length > 0 && deltas[deltas.length - 1] === s.duration) counts[counts.length - 1]++;
                else { counts.push(1); deltas.push(s.duration); }
              }
              stbl.stts.sample_counts = counts;
              stbl.stts.sample_deltas = deltas;
              // stsc：全部样本放在同一个chunk
              stbl.stsc.first_chunk = [1];
              stbl.stsc.samples_per_chunk = [samples.length];
              stbl.stsc.sample_description_index = [1];
              // stsz：每个样本的字节大小
              stbl.stsz.sample_sizes = samples.map(s => s.data.byteLength);
              // stss：视频关键帧索引（1-based），播放器依赖它seek；音频不需要
              if (isVideo) {
                const stss = new BoxParser.stssBox();
                stss.sample_numbers = samples.map((s, i) => s.is_sync ? i + 1 : 0).filter(x => x > 0);
                stbl.addBox(stss);
              }
              // stco先占位，待moov大小确定后回填chunk绝对偏移
              stbl.stco.chunk_offsets = [0];
            }
            fillStbl(vStbl, vSamples, true);
            fillStbl(aStbl, aSamples, false);

            // 所有样本数据连续拼入一个mdat，布局为[视频数据][音频数据]
            const vTotal = vSamples.reduce((s, x) => s + x.data.byteLength, 0);
            const aTotal = aSamples.reduce((s, x) => s + x.data.byteLength, 0);
            const mdatData = new Uint8Array(vTotal + aTotal);
            let off = 0;
            for (const s of vSamples) { mdatData.set(s.data, off); off += s.data.byteLength; }
            const aDataStart = off;
            for (const s of aSamples) { mdatData.set(s.data, off); off += s.data.byteLength; }
            outFile.add('mdat').data = mdatData;

            // 移除mvex（fragmented MP4标志，普通MP4不能保留）
            const mvexIdx = outFile.moov.boxes.findIndex(b => b.type === 'mvex');
            if (mvexIdx >= 0) { outFile.moov.boxes.splice(mvexIdx, 1); outFile.moov.mvex = undefined; }

            // 计算box大小后回填stco：mdat数据起始 = ftyp + moov + mdat头(8字节)
            outFile.boxes.forEach(b => b.computeSize());
            const mdatDataStart = outFile.ftyp.size + outFile.moov.size + 8;
            vStbl.stco.chunk_offsets = [mdatDataStart];
            aStbl.stco.chunk_offsets = [mdatDataStart + aDataStart];

            // 设置各track与movie时长（mvhd统一到视频timescale）
            const vDuration = vSamples.reduce((s, x) => s + x.duration, 0);
            const aDuration = aSamples.reduce((s, x) => s + x.duration, 0);
            outFile.moov.traks[0].mdia.mdhd.duration = vDuration;
            outFile.moov.traks[1].mdia.mdhd.duration = aDuration;
            outFile.moov.mvhd.timescale = vTrack.timescale;
            outFile.moov.mvhd.duration = Math.max(vDuration, Math.round(aDuration * vTrack.timescale / aTrack.timescale));

            // mp4box的write()需要传入BIG_ENDIAN的DataStream对象
            const ds = new DataStream();
            ds.endianness = DataStream.BIG_ENDIAN;
            outFile.write(ds);
            const output = ds.buffer;

            if (!output || output.byteLength === 0) {
              reject(new Error('输出文件为空'));
              return;
            }
            resolve(new Blob([output], { type: 'video/mp4' }));
          } catch (e) {
            reject(new Error('合成输出失败: ' + e.message));
          }
        }

        // 拼接所有分片后一次性喂入（fMP4分片拼接后是完整文件）
        // 注意：mp4box的appendBuffer必须接收ArrayBuffer，不能接收Uint8Array，否则会报DataView错误
        const fullVideo = concatBufs(videoBufs);
        const fullAudio = concatBufs(audioBufs);

        // 检测是否包含初始化片段（ftyp box），缺少则无法解析
        function getFirstBoxType(buf) {
          if (buf.byteLength < 8) return '';
          const u8 = new Uint8Array(buf, 4, 4);
          return String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
        }
        const vFirstBox = getFirstBoxType(fullVideo);
        const aFirstBox = getFirstBoxType(fullAudio);
        if (vFirstBox !== 'ftyp' || aFirstBox !== 'ftyp') {
          reject(new Error(`缺少初始化片段（视频首box:${vFirstBox}，音频首box:${aFirstBox}），请刷新页面后从头播放再下载`));
          return;
        }

        fullVideo.fileStart = 0;
        vFile.appendBuffer(fullVideo);
        vFile.flush();
        vDataFed = true;
        tryStart();

        fullAudio.fileStart = 0;
        aFile.appendBuffer(fullAudio);
        aFile.flush();
        aDataFed = true;
        tryStart();

        // 超时保护：15秒后强制完成
        setTimeout(() => { if (!finished) finish(); }, 15000);
      } catch (e) {
        reject(e);
      }
    });
  }

  // ========== 倍速功能 ==========
  function applySpeed(rate) {
    document.querySelectorAll('video').forEach(v => v.playbackRate = rate);
  }
  function shortPress() {
    if (is16x) return;
    speedIndex = (speedIndex + 1) % normalSpeeds.length;
    const r = normalSpeeds[speedIndex];
    applySpeed(r);
    btnSpeed.textContent = `${r}×`;
  }
  function longPress() {
    is16x = !is16x;
    const r = is16x ? 16 : normalSpeeds[speedIndex];
    applySpeed(r);
    btnSpeed.textContent = `${r}×`;
  }

  // ========== 跳至结尾 ==========
  function skipToEnd() {
    document.querySelectorAll('video').forEach(v => {
      if (v.duration) v.currentTime = v.duration - 0.1;
    });
  }

  // ========== 自动完整下载（静默启动） ==========
  function autoCompleteDownload() {
    const video = document.querySelector('video');
    if (!video) return alert('未找到视频元素');
    if (merging || autoDownload) return;

    if (isBufferedComplete()) {
      download(true, true);
      return;
    }

    // 关键：先设置autoDownload=true和autoDownloadDone=false，再操作video
    // video.currentTime=0可能导致旧流关闭触发endOfStream，再导致新流结束触发第二次endOfStream
    // 用autoDownloadDone确保只有第一次endOfStream会触发下载，第二次不会弹confirm
    autoDownload = true;
    autoDownloadDone = false;
    is16x = true;
    applySpeed(16);
    btnSpeed.textContent = '16×';
    btnAuto.textContent = '自动捕获中...';
    // 不重置endConfirmShown，避免旧流关闭触发的endOfStream被当成新的一次

    // 快速捕获期间静音并隐藏画面（不用display:none，那会暂停播放导致不再加载分片；
    // visibility:hidden只停止画面绘制、不影响MSE持续拉流），下载结束后在download()里恢复
    hiddenVideoState = {
      el: video,
      muted: video.muted,
      visibility: video.style.visibility,
      opacity: video.style.opacity
    };
    video.muted = true;
    video.style.visibility = 'hidden';
    video.style.opacity = '0';

    // 监听视频播放结束（有些网站不会调用endOfStream，用ended事件兜底）
    const onEnded = () => {
      video.removeEventListener('ended', onEnded);
      if (autoDownload && !autoDownloadDone) {
        autoDownloadDone = true;
        autoDownload = false;
        download(true, true);
      }
    };
    video.addEventListener('ended', onEnded);

    video.currentTime = 0;
    video.play();
  }

  // ========== 扫描视频资源 ==========
  function scanVideos() {
    m3u8Url = null;
    document.querySelectorAll('video').forEach(v => {
      const src = v.currentSrc || v.src;
      if (!src) return;
      if (src.includes('.m3u8')) m3u8Url = src;
    });

    if (sourceBufferList.length > 0) {
      btnAuto.style.display = 'block';
      btnOnline.style.display = 'none';
    } else if (m3u8Url) {
      btnAuto.style.display = 'none';
      btnOnline.style.display = 'block';
    } else {
      btnAuto.style.display = 'none';
      btnOnline.style.display = 'none';
    }
  }

  // ========== 下载核心 ==========
  async function download(skipCheck = false, autoMode = false) {
    if (fragCount === 0) return alert('暂未捕获到视频片段');
    if (merging) return;

    if (!skipCheck && !autoMode) {
      const complete = isBufferedComplete();
      const msg = complete
        ? '✅ 视频已完整加载，是否开始下载？'
        : '⚠️ 视频未完整加载\n下载可能出现无画面、卡顿、无法拖动进度条等问题。\n\n是否继续下载？';
      if (!confirm(msg)) return;
    }

    merging = true;
    const oldText = btnDownload.textContent;
    btnDownload.textContent = '合成中...';

    try {
      const title = getTitle();
      // 分类音视频：优先mime，mime缺失时用init内容判断的kind兜底
      let videoItems = sourceBufferList.filter(i => itemKind(i) === 'video');
      let audioItems = sourceBufferList.filter(i => itemKind(i) === 'audio');
      // 最终兜底：视频或音频缺失时，用未分类条目按数据总量补全（视频通常远大于音频）。
      // 不要求unknown>=2：常见场景是一个轨识别出来了、另一个轨kind缺失（不完整捕获时
      // mime没记录+init segment错过），此时只有1个unknown，也必须补全否则会走单轨道分开下载。
      if (videoItems.length === 0 || audioItems.length === 0) {
        const unknown = sourceBufferList.filter(i => !itemKind(i));
        if (unknown.length > 0) {
          const sized = unknown
            .map(i => ({ i, total: i.buffers.reduce((s, b) => s + b.byteLength, 0) }))
            .sort((a, b) => b.total - a.total);
          if (videoItems.length === 0) videoItems = [sized[0].i];
          if (audioItems.length === 0) {
            // 优先取第二大的unknown（最大的已分配给视频），只有1个时取它本身
            audioItems = [sized[1] ? sized[1].i : sized[0].i];
          }
        }
      }

      // 单轨道：直接下载
      if (videoItems.length === 0 || audioItems.length === 0) {
        sourceBufferList.forEach((item, idx) => {
          setTimeout(() => {
            const kind = itemKind(item);
            const mime = (item.mime || '').split(';')[0] || (kind === 'audio' ? 'audio/mp4' : 'video/mp4');
            const ext = mime.split('/')[1] || 'mp4';
            const blob = new Blob(item.buffers, { type: mime });
            const a = document.createElement('a');
            a.download = `${title}.${ext}`;
            a.href = URL.createObjectURL(blob);
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
          }, idx * 300);
        });
        return;
      }

      // 双轨道：mp4box无损合成
      try {
        btnDownload.textContent = '合成中...';
        const mergedBlob = await mergeMP4(videoItems[0].buffers, audioItems[0].buffers);
        const a = document.createElement('a');
        a.download = `${title}.mp4`;
        a.href = URL.createObjectURL(mergedBlob);
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      } catch (e) {
        // 合成失败：自定义弹窗，提供分开下载/在线完整下载/取消三个选项
        const complete = isBufferedComplete();
        showMergeFailDialog(complete, e.message, () => {
          [videoItems[0], audioItems[0]].forEach((item, idx) => {
            setTimeout(() => {
              const kind = itemKind(item);
              const mime = (item.mime || '').split(';')[0] || (kind === 'audio' ? 'audio/mp4' : 'video/mp4');
              const ext = mime.split('/')[1] || 'mp4';
              const type = kind === 'audio' ? '音频' : '视频';
              const blob = new Blob(item.buffers, { type: mime });
              const a = document.createElement('a');
              a.download = `${title}_${type}.${ext}`;
              a.href = URL.createObjectURL(blob);
              a.style.display = 'none';
              document.body.appendChild(a);
              a.click();
              a.remove();
              setTimeout(() => URL.revokeObjectURL(a.href), 1000);
            }, idx * 300);
          });
        });
      }
    } finally {
      merging = false;
      btnDownload.textContent = oldText;
      if (btnAuto) btnAuto.textContent = '自动完整下载';
      // 恢复自动捕获期间临时静音/隐藏的视频画面
      if (hiddenVideoState) {
        const hv = hiddenVideoState;
        hiddenVideoState = null;
        try {
          hv.el.muted = hv.muted;
          hv.el.style.visibility = hv.visibility;
          hv.el.style.opacity = hv.opacity;
        } catch (e) { /* 视频元素可能已被页面移除，忽略 */ }
      }
    }
  }

  // ========== 渲染UI ==========
  function renderPanel() {
    if (document.getElementById('vd-panel')) return;

    const panel = document.createElement('div');
    const btnToggle = document.createElement('div');
    const body = document.createElement('div');
    btnDownload = document.createElement('div');
    btnSpeed = document.createElement('div');
    btnSkip = document.createElement('div');
    btnAuto = document.createElement('div');
    btnOnline = document.createElement('div');

    panel.id = 'vd-panel';
    panel.style = `
      position: fixed; top: 50px; right: 50px; z-index: 9999;
      display: flex; flex-direction: column; align-items: flex-end;
    `;

    btnToggle.textContent = '◀';
    btnToggle.style = `
      width: 32px; height: 32px; line-height: 32px; text-align: center;
      color: #fff; cursor: pointer; font-size: 14px; font-weight: bold;
      border-radius: 4px; background: #3498db;
      box-shadow: 0 3px 6px rgba(0,0,0,.3); user-select: none;
      margin-bottom: 8px; flex-shrink: 0;
    `;

    body.style = `
      display: flex; visibility: hidden; opacity: 0;
      transform: translateX(20px); transition: all 0.25s ease-out;
      flex-direction: column; align-items: flex-end; gap: 8px;
      pointer-events: none;
    `;

    const baseBtn = `
      display: block; width: auto; padding: 0 14px;
      color: #fff; cursor: pointer; font-size: 14px; font-weight: bold;
      line-height: 36px; text-align: center; border-radius: 4px;
      background: #3498db; box-shadow: 0 3px 6px rgba(0,0,0,.3);
      user-select: none; white-space: nowrap;
    `;

    btnDownload.textContent = '下载已捕获片段 (0)';
    btnSpeed.textContent = '1×';
    btnSkip.textContent = '跳至结尾';
    btnAuto.textContent = '自动完整下载';
    btnOnline.textContent = '在线完整下载';

    [btnDownload, btnSpeed, btnSkip, btnAuto, btnOnline].forEach(el => el.style = baseBtn);
    btnAuto.style.background = '#e67e22';
    btnOnline.style.background = '#27ae60';
    btnAuto.style.display = 'none';
    btnOnline.style.display = 'none';

    btnDownload.onclick = () => download(false, false);
    btnSkip.onclick = skipToEnd;
    btnAuto.onclick = autoCompleteDownload;
    btnOnline.onclick = openOnlineTool;

    // 倍速长短按
    btnSpeed.addEventListener('mousedown', () => {
      pressTimer = setTimeout(() => { longPress(); pressTimer = null; }, pressDelay);
    });
    btnSpeed.addEventListener('mouseup', () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; shortPress(); }
    });
    btnSpeed.addEventListener('mouseleave', () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    });

    // 展开收起
    btnToggle.onclick = () => {
      expanded = !expanded;
      btnToggle.textContent = expanded ? '×' : '◀';
      if (expanded) {
        body.style.visibility = 'visible';
        body.style.opacity = '1';
        body.style.transform = 'translateX(0)';
        body.style.pointerEvents = 'auto';
        scanVideos();
        scanTimer = setInterval(scanVideos, 1500);
      } else {
        body.style.visibility = 'hidden';
        body.style.opacity = '0';
        body.style.transform = 'translateX(20px)';
        body.style.pointerEvents = 'none';
        if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
      }
    };

    panel.appendChild(btnToggle);
    panel.appendChild(body);
    body.appendChild(btnDownload);
    body.appendChild(btnSpeed);
    body.appendChild(btnSkip);
    body.appendChild(btnOnline);
    body.appendChild(btnAuto);
    document.documentElement.insertBefore(panel, document.head);
  }

  // DOM就绪后渲染UI
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderPanel);
  } else {
    renderPanel();
  }

  // 调试接口（正式版可保留，无副作用）
  window.__vd = {
    getBuffers: () => sourceBufferList,
    getFrag: () => fragCount,
    mergeMP4: mergeMP4
  };
})();
