// ==UserScript==
// @name         VideoDownloader
// @namespace    https://doubao.com
// @version      1.8.2
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

  // m3u8地址（通过fetch/XHR劫持捕获，比检查video.src更可靠）
  let m3u8Url = null;
  // 所有捕获到的m3u8地址（用于调试，排查地址是否正确）
  const m3u8UrlList = [];
  // 脚本是否已停止（没有视频流的页面，30秒后自动停止，恢复所有原型方法，避免性能影响）
  let scriptStopped = false;
  // 保存所有被劫持的原始方法引用，停止时恢复
  const nativeMethods = {};

  // ========== 劫持fetch/XHR捕获m3u8地址 ==========
  // Chrome里hls.js会把m3u8转成fMP4喂给MSE，video.src是blob:地址，
  // 所以通过拦截网络请求来捕获.m3u8地址
  const originalFetch = window.fetch;
  nativeMethods.fetch = originalFetch;
  window.fetch = wrapAsNative(function (input, init) {
    if (scriptStopped) return originalFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.includes('.m3u8')) {
        m3u8Url = url;
        if (!m3u8UrlList.includes(url)) m3u8UrlList.push(url);
      }
    } catch (e) {}
    return originalFetch.apply(this, arguments);
  });

  const originalXHROpen = XMLHttpRequest.prototype.open;
  nativeMethods.xhrOpen = originalXHROpen;
  XMLHttpRequest.prototype.open = wrapAsNative(function (method, url) {
    if (scriptStopped) return originalXHROpen.apply(this, arguments);
    try {
      if (url && url.includes('.m3u8')) {
        m3u8Url = url;
        if (!m3u8UrlList.includes(url)) m3u8UrlList.push(url);
      }
    } catch (e) {}
    return originalXHROpen.apply(this, arguments);
  });

  // 全局状态
  let fragCount = 0;
  let sourceBufferList = [];
  let endConfirmShown = false;
  let streamEnded = false;
  let countPending = false;
  let autoDownload = false;
  let autoDownloadDone = false; // 防止自动下载被重复触发
  let autoCompletePoll = null; // 自动下载时轮询检测buffered是否完整，完整就直接下载不用等放完
  let captureLocked = false; // 自动完整下载合成期间锁定捕获，防止自动连播的init segment清空数据
  let mseHijacked = false;
  let sbHijacked = false; // SourceBuffer原型是否已劫持
  // 自动捕获时临时修改的视频状态（静音+隐藏画面），下载结束后恢复
  let hiddenVideoState = null;
  // SourceBuffer实例 -> {mime,buffers,kind} 的映射（原型劫持时靠它拿到mime）
  let sbEntryMap = new WeakMap();
  // 已见过的MediaSource实例，用于识别"新流开始"并清空上一个视频的缓存
  const seenMediaSources = new WeakSet();
  // seek（跳至结尾/跳转进度条）时记录每个SourceBuffer已缓存的分片数量，
  // 下载时只取seek前的分片，避免把seek位置前后的分片混在一起导致音画不同步
  let seekedCutoff = null;
  // 完整锁定：视频完整加载后不再追加新分片，防止自动连播/重播的内容混进来；
  // 检测到切换视频或重播时清空旧数据并解除锁定
  let completeLocked = false;
  // 是否发生过大跳转（seek到后面）：跳转后endOfStream兜底逻辑不能误判为完整
  let seekedToEnd = false;
  // 是否因时间戳不连续被截断（seek跳转后加载的内容）：UI字体变红色提示
  let truncatedByGap = false;
  // 播放过程中持续记录的最大缓存end值（seek时buffered会被清理，用这个值判断跳转目标是否在已缓存范围内）
  let maxBufferedEnd = 0;
  // timeupdate事件持续记录的最新缓存范围（seek前最后一次记录的才准确，seek时buffered会被清理）
  let lastBufferedRanges = [];
  // 向前小幅跳转后暂时忽略ftyp清空（播放器重新初始化时会发ftyp，但同一条流不应清空旧数据）
  let smallSeekIgnoreFtyp = false;
  let smallSeekIgnoreUntil = 0;
  // 标红后点击自动下载主动seek到开头的标志（区分主动seek和视频播放完自动重播）
  let manualSeekToBeginning = false;

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
    seekedCutoff = null;
    completeLocked = false;
    seekedToEnd = false;
    truncatedByGap = false;
    maxBufferedEnd = 0;
    lastBufferedRanges = [];
    smallSeekIgnoreFtyp = false;
    smallSeekIgnoreUntil = 0;
    manualSeekToBeginning = false;
    // 重建WeakMap，防止切换视频复用SourceBuffer实例时返回旧entry（buffers里还有旧数据）
    sbEntryMap = new WeakMap();
  }

  // 注册（或取回）一个SourceBuffer实例对应的捕获条目
  function registerSourceBuffer(sb, mime) {
    let entry = sbEntryMap.get(sb);
    if (!entry) {
      entry = { mime: mime || '', buffers: [], kind: '', lastDts: 0 };
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
    nativeMethods.appendBuffer = origAppend;
    proto.appendBuffer = wrapAsNative(function (buf) {
      if (scriptStopped) return origAppend.call(this, buf);
      try {
        // 捕获锁定期间（自动完整下载合成中）不记录新数据，
        // 防止自动连播的新视频数据追加到旧数据后面，导致下载的是混合内容
        if (!captureLocked) {
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
              // 新流开始：解除完整锁定
              completeLocked = false;
              // 向前小幅跳转后5秒内，播放器重新初始化时会发ftyp，但同一条流不应清空旧数据
              // 只有非小跳转场景才清空，防止切换视频/重建缓冲区时旧分片与新分片混在一起
              const now = Date.now();
              if (!smallSeekIgnoreFtyp || now > smallSeekIgnoreUntil) {
                smallSeekIgnoreFtyp = false;
                entry.buffers = [];
                entry.kind = '';
                entry.lastDts = 0;
              }
            } else if (fb === 'moof') {
              // 完整锁定期间：不记录新的moof分片（视频已完整，防止自动连播/重播内容混进来）
              if (completeLocked) {
                return origAppend.call(this, buf);
              }
              // 记录最后一个moof分片的dts，用于调试和完整性检测
              const newDts = getFirstSampleDts(copy);
              if (newDts > 0) entry.lastDts = newDts;
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
              if (btnDownload) {
                // 三种颜色状态：截断（seek后不连续）红色、完整橙色、未完整默认白色
                // 自动完整下载模式下不标黄（还在捕获中），保持白色
                if (truncatedByGap && !autoDownload) {
                  btnDownload.innerHTML = `下载已捕获片段 (<span style="color:#f44336;font-weight:600">${fragCount}</span>)`;
                } else if (isBufferedComplete() && !autoDownload) {
                  btnDownload.innerHTML = `下载已捕获片段 (<span style="color:#ff9800;font-weight:600">${fragCount}</span>)`;
                  // 视频完整加载后锁定，不再追加新分片，防止自动连播/重播内容混进来。
                  // 自动完整下载模式不在这里锁定（有专门的autoEndedHandler处理，避免16倍速播放时误判提前锁定）
                  completeLocked = true;
                  // 完整加载后重置大跳转标志，防止之前标红后又完整加载时文件名还带"片段"后缀
                  truncatedByGap = false;
                  seekedToEnd = false;
                } else {
                  btnDownload.textContent = `下载已捕获片段 (${fragCount})`;
                }
              }
              countPending = false;
            });
          }
        }
      } catch (e) { /* 捕获逻辑绝不能影响网站正常播放 */ }
      return origAppend.call(this, buf);
    });

    // 注意：不在abort()/remove()时清空我们记录的moof分片。
    // 原因：B站等播放器在正常播放过程中会频繁调用abort()调整缓冲，
    // 如果每次abort都清空moof分片，会导致捕获的数据被反复清空，最后只剩一小段。
    // seek/切换视频的检测改由appendBuffer时的时间戳不连续检测和ftyp检测来完成。

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
    nativeMethods.endOfStream = origEnd;
    MS.prototype.endOfStream = wrapAsNative(function () {
      if (scriptStopped) return origEnd.call(this);
      streamEnded = true;
      if (!endConfirmShown) {
        // 检查视频是否真正播放到结尾（防止播放过程中切换清晰度/seek等触发endOfStream误弹窗）
        const v = document.querySelector('video');
        const isAtEnd = v && v.duration && v.currentTime > 0 && (v.duration - v.currentTime) < 3;
        const complete = isBufferedComplete();
        if (isAtEnd) {
          endConfirmShown = true;
          // 自动下载模式：静默下载，不弹confirm；用autoDownloadDone防止重复触发
          if (autoDownload && !autoDownloadDone) {
            autoDownloadDone = true;
            autoDownload = false;
            download(true, true);
          }
        }
      }
      origEnd.call(this);
    });

    const origAdd = MS.prototype.addSourceBuffer;
    nativeMethods.addSourceBuffer = origAdd;
    MS.prototype.addSourceBuffer = wrapAsNative(function (mime) {
      if (scriptStopped) return origAdd.call(this, mime);
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
  let merging = false;
  let scanTimer = null;
  let btnDownload, btnSpeed, btnSkip, btnAuto, btnOnline;

  // 倍速配置
  const normalSpeeds = [1, 2, 4];
  let speedIndex = 0;
  let is16x = false;
  let pressTimer = null;
  const pressDelay = 500;

  const ONLINE_TOOL = 'https://blog.luckly-mjw.cn/tool-show/m3u8-downloader/index.html';

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

  // 从fMP4 moof分片中提取第一个sample的dts（解码时间戳），
  // 用于判断是否从头开始捕获（seek到结尾时第一个moof的dts会很大）
  function getFirstSampleDts(buf) {
    if (!buf || buf.byteLength < 16) return 0;
    try {
      const dv = new DataView(buf);
      let offset = 0;
      const moofSize = dv.getUint32(offset);
      const moofType = String.fromCharCode(dv.getUint8(offset+4), dv.getUint8(offset+5), dv.getUint8(offset+6), dv.getUint8(offset+7));
      if (moofType !== 'moof') return 0;
      offset += 8;
      while (offset + 8 <= buf.byteLength) {
        const boxSize = dv.getUint32(offset);
        if (boxSize < 8 || offset + boxSize > buf.byteLength) break;
        const boxType = String.fromCharCode(dv.getUint8(offset+4), dv.getUint8(offset+5), dv.getUint8(offset+6), dv.getUint8(offset+7));
        if (boxType === 'traf') {
          let trafOffset = offset + 8;
          while (trafOffset + 8 <= offset + boxSize) {
            const subSize = dv.getUint32(trafOffset);
            if (subSize < 8) break;
            const subType = String.fromCharCode(dv.getUint8(trafOffset+4), dv.getUint8(trafOffset+5), dv.getUint8(trafOffset+6), dv.getUint8(trafOffset+7));
            if (subType === 'tfdt') {
              const version = dv.getUint8(trafOffset + 8);
              if (version === 1) {
                const high = dv.getUint32(trafOffset + 12);
                const low = dv.getUint32(trafOffset + 16);
                return high * 4294967296 + low;
              } else {
                return dv.getUint32(trafOffset + 12);
              }
            }
            trafOffset += subSize;
          }
        }
        offset += boxSize;
      }
    } catch (e) {}
    return 0;
  }

  // 检测分片时间戳不连续点（seek跳转后加载的内容dts会突然跳变），
  // 只保留前面连续的部分，去掉seek后加载的不连续内容，避免合成时音画不同步。
  // 用相邻分片的相对差值判断，不依赖固定timescale（视频通常90000、音频48000）。
  function truncateAtTimeGap(entry) {
    if (!entry || !entry.buffers || entry.buffers.length < 3) return entry.buffers;
    const result = [];
    let prevDts = -1;
    let normalDelta = 0; // 正常相邻分片的时间戳差值（取前几个分片的平均）
    let deltaCount = 0;
    for (let i = 0; i < entry.buffers.length; i++) {
      const buf = entry.buffers[i];
      if (buf.byteLength < 8) { result.push(buf); continue; }
      const u8 = new Uint8Array(buf);
      const fb = String.fromCharCode(u8[4], u8[5], u8[6], u8[7]);
      if (fb === 'ftyp') { result.push(buf); continue; } // init segment保留
      if (fb !== 'moof') { result.push(buf); continue; }
      const dts = getFirstSampleDts(buf);
      if (dts > 0 && prevDts >= 0) {
        const delta = dts - prevDts;
        if (normalDelta > 0 && deltaCount >= 2) {
          // 时间戳倒退，或差值远大于正常差值（>5倍），说明是seek后加载的不连续内容，截断
          if (delta < 0 || delta > normalDelta * 5) {
            break;
          }
        }
        if (delta > 0) {
          // 累计正常差值（前几个分片）
          if (deltaCount < 5) {
            normalDelta = (normalDelta * deltaCount + delta) / (deltaCount + 1);
            deltaCount++;
          }
        }
      }
      if (dts > 0) prevDts = dts;
      result.push(buf);
    }
    return result;
  }

  // 判断某个时间点是否在MSE已缓存范围内（缓存内跳转不会加载新分片，不会导致异常追加）
  function isTimeBuffered(time) {
    const v = document.querySelector('video');
    if (!v || !v.buffered || v.buffered.length === 0) return false;
    for (let i = 0; i < v.buffered.length; i++) {
      if (time >= v.buffered.start(i) - 1 && time <= v.buffered.end(i) + 1) {
        return true;
      }
    }
    return false;
  }

  function isBufferedComplete() {
    // 标红（发生过大跳转/跳至结尾）时直接认为不完整，防止自动重播后MSE buffered从0开始误判为完整
    if (truncatedByGap) return false;
    // 优先检查MSE buffered：跳至结尾时buffered从中间开始（start>3），不是完整视频
    const v = document.querySelector('video');
    if (v?.duration && v.buffered.length > 0) {
      const start = v.buffered.start(0);
      const end = v.buffered.end(v.buffered.length - 1);
      // 从中间开始（跳至结尾/seek）不是完整视频
      if (start > 3) return false;
      // 从接近0开始且覆盖到接近结尾 → 完整
      if (start < 3 && (v.duration - end) < 3) return true;
    }
    // MSE buffered不可用时（播放完成后被清理/自动连播替换），检查捕获状态：
    // endOfStream已调用 且 视频和音频都有init+moof分片 且 没有发生过大跳转 → 认为完整
    if (streamEnded && sourceBufferList.length >= 2 && !seekedToEnd) {
      const hasVideo = sourceBufferList.some(e => itemKind(e) === 'video' && e.buffers.length > 1);
      const hasAudio = sourceBufferList.some(e => itemKind(e) === 'audio' && e.buffers.length > 1);
      if (hasVideo && hasAudio) return true;
    }
    return false;
  }

  function concatBufs(bufs) {
    const len = bufs.reduce((s, b) => s + b.byteLength, 0);
    const res = new Uint8Array(len);
    let off = 0;
    bufs.forEach(b => { res.set(new Uint8Array(b), off); off += b.byteLength; });
    return res.buffer;
  }

  // 截断不完整的最后一个box：视频结束时最后一个moof可能被截断，
  // 导致mp4box解析错误。从末尾向前找最后一个完整的box，截断到那里。
  function truncateIncompleteBox(buf) {
    if (buf.byteLength < 8) return buf;
    const dv = new DataView(buf);
    let offset = 0;
    let lastComplete = 0;
    while (offset + 8 <= buf.byteLength) {
      const size = dv.getUint32(offset);
      if (size < 8 || offset + size > buf.byteLength) {
        // 这个box不完整，截断到上一个完整box
        break;
      }
      lastComplete = offset + size;
      offset += size;
    }
    if (lastComplete > 0 && lastComplete < buf.byteLength) {
      return buf.slice(0, lastComplete);
    }
    return buf;
  }

  // ajax辅助函数（用于注入下载时请求JS文件内容）
  function injectAjax(url, type) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      if (type === 'file') xhr.responseType = 'arraybuffer';
      xhr.onreadystatechange = function () {
        if (xhr.readyState === 4) {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(xhr.response);
          } else {
            reject(xhr.status);
          }
        }
      };
      xhr.open('GET', url, true);
      xhr.send(null);
    });
  }

  // 注入JS内容到当前页面（运行在当前页面上下文，避免跨域）
  function injectScriptContent(content) {
    const s = document.createElement('script');
    s.innerHTML = content;
    document.body.appendChild(s);
  }

  // M3U8下载：把原作者的m3u8下载工具注入到当前页面右下角小弹窗，避免跨域问题
  async function openOnlineTool() {
    if (!m3u8Url) {
      alert('未检测到 m3u8 地址');
      return;
    }
    // 如果已经注入过，直接显示，并更新输入框为当前捕获的m3u8地址
    const existing = document.getElementById('vd-online-tool-modal');
    if (existing) {
      existing.style.display = 'flex';
      // 更新Vue实例的url为当前捕获的地址
      const app = existing.querySelector('#m-app');
      if (app && app.__vue__) {
        app.__vue__.url = m3u8Url;
      }
      return;
    }
    try {
      // 1. 请求在线工具页面的HTML
      const html = await injectAjax(`${ONLINE_TOOL}?t=${Date.now()}`);
      // 2. 解析HTML，提取DOM和script
      const fileList = html.split('<!--vue 前端框架-->');
      if (fileList.length < 2) {
        alert('在线工具页面解析失败');
        return;
      }
      let dom = fileList[0];
      // 删掉原作者HTML里的<title>标签，防止注入后修改当前网页标题
      dom = dom.replace(/<title[^>]*>[\s\S]*?<\/title>/gi, '');
      // 在"转码为MP4下载"按钮里直接写死感叹号（避免JS动态添加时匹配错误按钮），并在后面添加"返回"按钮（只在范围下载模式下显示）
      dom = dom.replace(
        `<div @click="getMP4">转码为MP4下载</div>`,
        `<div @click="getMP4" title="注意：转码为MP4可能出现时长显示不准确、进度条无法拖动等问题，建议优先使用原格式下载"><span class="vd-mp4-warn">!</span>转码为MP4下载<span class="vd-mp4-warn">!</span></div><div class="range-back-btn" v-if="rangeDownload.isShowRange" @click="rangeDownload.isShowRange=false">返回</div>`
      );
      // 保存当前页面全局样式和标题，注入后恢复
      // 临时设置document.title为'm3u8 downloader'，防止原作者代码里fileName被错误设置
      const savedBodyStyle = document.body.style.cssText;
      const savedHtmlStyle = document.documentElement.style.cssText;
      const savedTitle = document.title;
      document.title = 'm3u8 downloader';
      let script = fileList.length >= 3 ? (fileList[1] + fileList[2]) : fileList[1];
      const scriptParts = script.split('// script注入');
      if (scriptParts.length >= 3) script = scriptParts[1] + scriptParts[2];
      else if (scriptParts.length === 2) script = scriptParts[1];
      // 3. 把m3u8地址填入script
      script = script.replace(`url: '', // 在线链接`, `url: '${m3u8Url}',`);
      // 4. 修复：下载完成后重置所有状态，允许重新下载/切换格式
      // 用自己的downloadBlob方法下载，不用原作者的downloadFile（避免文件名异常）
      // 注意：不重置rangeDownload.isShowRange，下载完成后保持范围下载模式，方便用户再次下载
      script = script.replace(
        `this.downloadFile(this.mediaFileList, fileName)`,
        `this.downloadBlob(fileName); var self=this; setTimeout(function(){ self.downloading=false; self.isPause=false; self.isGetMP4=false; self.mediaFileList=[]; self.errorNum=0; self.finishNum=0; self.downloadIndex=0; self.durationSecond=0; self.streamWriter=null; self.streamDownloadIndex=0; }, 1000);`
      );
      // 4.1 MP4转码：mux.js逐片段转码，keepOriginalTimestamps设为false（重新计算连续时间戳，可正常出画面）
      // 移除duration参数（durationSecond可能为0导致视频轨道信息错误）
      // 注意：逐片段独立转码存在时长显示不准确、进度条可能无法拖动的问题（原作者工具架构限制），建议优先用原格式下载
      script = script.replace(
        `keepOriginalTimestamps: true,
            duration: parseInt(this.durationSecond),`,
        `keepOriginalTimestamps: false,`
      );
      // 4.2 范围下载：完全使用原作者逻辑（Math.max/Math.min自动修正范围），不额外添加校验避免重复下载
      // 5. 添加重置方法和自己的下载方法
      script = script.replace(
        `// 拷贝剪切板`,
        `// 重置下载状态，允许切换格式重新下载
        resetDownload() {
          this.downloading = false;
          this.isPause = false;
          this.isGetMP4 = false;
          this.url = '';
          this.tsUrlList = [];
          this.finishList = [];
          this.mediaFileList = [];
          this.errorNum = 0;
          this.finishNum = 0;
          this.downloadIndex = 0;
          this.durationSecond = 0;
          this.tips = 'm3u8 视频在线提取工具';
          this.rangeDownload.isShowRange = false;
        },
        // 自己的下载方法：拼接mediaFileList为Blob，用a标签下载（文件名自己控制，避免原作者downloadFile的文件名异常）
        downloadBlob(fileName) {
          if (!this.mediaFileList || this.mediaFileList.length === 0) { alert('当前无已下载片段'); return; }
          const totalLength = this.mediaFileList.reduce((sum, item) => sum + (item.byteLength || item.length || 0), 0);
          const result = new Uint8Array(totalLength);
          let offset = 0;
          this.mediaFileList.forEach(item => {
            const arr = item instanceof Uint8Array ? item : new Uint8Array(item);
            result.set(arr, offset);
            offset += arr.byteLength;
          });
          const ext = this.isGetMP4 ? 'mp4' : 'ts';
          const blob = new Blob([result], { type: this.isGetMP4 ? 'video/mp4' : 'video/mp2t' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = (fileName || 'video') + '.' + ext;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        },
        // 拷贝剪切板`
      );
      // 6. 创建右下角小弹窗（无遮罩层，简洁布局）
      const modal = document.createElement('div');
      modal.id = 'vd-online-tool-modal';
      modal.style.cssText = `
        position: fixed; right: 20px; bottom: 20px;
        width: 420px; max-width: 92vw; height: auto; max-height: 70vh;
        background-color: white; border-radius: 8px; overflow: hidden;
        box-shadow: 0 8px 30px rgba(0,0,0,0.25); z-index: 2147483646;
        display: flex; flex-direction: column;
      `;
      // 内容区域（可滚动）
      const contentArea = document.createElement('div');
      contentArea.style.cssText = 'flex: 1; overflow-y: auto; overflow-x: hidden;';
      // 关闭按钮（modal层，不随内容滚动，z-index提高）
      const closeBtn = document.createElement('span');
      closeBtn.textContent = '×';
      closeBtn.style.cssText = `
        position: absolute; top: 12px; right: 8px; z-index: 100;
        font-size: 18px; cursor: pointer; line-height: 1;
        padding: 4px 8px; border-radius: 4px; color: #666;
      `;
      closeBtn.onmouseover = () => closeBtn.style.backgroundColor = '#e9ecef';
      closeBtn.onmouseout = () => closeBtn.style.backgroundColor = 'transparent';
      closeBtn.onclick = (e) => { e.stopPropagation(); modal.style.display = 'none'; };
      // 重置按钮（modal层，不随内容滚动）
      const resetBtn = document.createElement('span');
      resetBtn.textContent = '重置';
      resetBtn.style.cssText = `
        position: absolute; top: 13px; right: 42px; z-index: 100;
        font-size: 12px; cursor: pointer; line-height: 1;
        padding: 5px 8px; border-radius: 4px; color: #666;
        background: #e9ecef;
      `;
      resetBtn.onmouseover = () => resetBtn.style.backgroundColor = '#dee2e6';
      resetBtn.onmouseout = () => resetBtn.style.backgroundColor = '#e9ecef';
      resetBtn.onclick = (e) => {
        e.stopPropagation();
        const app = document.querySelector('#vd-online-tool-modal #m-app');
        if (app && app.__vue__ && typeof app.__vue__.resetDownload === 'function') {
          app.__vue__.resetDownload();
        } else if (app && app.__vue__) {
          // 兜底：手动重置关键状态
          const v = app.__vue__;
          v.downloading = false; v.isPause = false; v.isGetMP4 = false;
          v.url = '';
          v.tsUrlList = []; v.finishList = []; v.mediaFileList = [];
          v.errorNum = 0; v.finishNum = 0; v.downloadIndex = 0;
          v.durationSecond = 0; v.rangeDownload.isShowRange = false;
        }
      };
      modal.appendChild(closeBtn);
      modal.appendChild(resetBtn);
      // 隐藏冗余功能 + 重新布局的样式
      const hideStyle = document.createElement('style');
      hideStyle.textContent = `
        /* 隐藏所有冗余功能 */
        #vd-online-tool-modal .m-p-temp-url,
        #vd-online-tool-modal .m-p-cross,
        #vd-online-tool-modal .m-p-mse,
        #vd-online-tool-modal .m-p-tamper,
        #vd-online-tool-modal .m-p-github,
        #vd-online-tool-modal .m-p-other,
        #vd-online-tool-modal .m-p-language,
        #vd-online-tool-modal .m-p-help,
        #vd-online-tool-modal .m-p-refer,
        #vd-online-tool-modal .m-p-stream,
        #vd-online-tool-modal .m-p-report,
        #vd-online-tool-modal .m-p-final,
        #vd-online-tool-modal .m-p-action,
        #vd-online-tool-modal .m-p-line,
        #vd-online-tool-modal #m-app > h1,
        #vd-online-tool-modal #m-loading { display: none !important; }
        /* 整体布局 */
        #vd-online-tool-modal #m-app { padding: 0 !important; margin: 0 !important; }
        /* 输入框和按钮区域：flex-wrap布局，input占满第一行，三个按钮平分第二行 */
        #vd-online-tool-modal .m-p-input-container { 
          margin: 0 !important; 
          padding: 8px !important;
          display: flex !important; 
          flex-wrap: wrap !important;
          gap: 8px !important; 
          align-items: stretch !important; 
        }
        /* 输入框：占满第一行，右侧留出关闭/重置按钮位置 */
        #vd-online-tool-modal .m-p-input-container input { 
          flex: 0 0 100% !important;
          width: 100% !important;
          height: auto !important;
          margin: 0 !important;
          padding: 8px 70px 8px 10px !important; 
          font-size: 13px !important; 
          line-height: 1.4 !important;
          box-sizing: border-box !important;
          border: 1px solid #ccc !important;
          border-radius: 4px !important;
        }
        /* 范围输入框：缩小宽度，给下载按钮留空间 */
        #vd-online-tool-modal .m-p-input-container .range-input {
          flex: 0 0 72px !important;
          min-width: 72px !important;
          width: 72px !important;
          height: auto !important;
          margin: 0 !important;
          padding: 8px 4px !important;
          font-size: 12px !important;
          line-height: 1.4 !important;
          text-align: center !important;
          box-sizing: border-box !important;
          border-radius: 4px !important;
          display: inline-block !important;
        }
        /* 转码MP4按钮感叹号样式（红色加粗，两边各一个） */
        #vd-online-tool-modal .m-p-input-container .vd-mp4-warn {
          display: inline-block !important;
          margin: 0 1px !important;
          font-size: 11px !important;
          font-weight: bold !important;
          color: #f44336 !important;
          vertical-align: middle !important;
          line-height: 1 !important;
        }
        /* 范围下载"返回"按钮：强制窄宽度，flex居中，覆盖原作者的content-box和大字体 */
        #vd-online-tool-modal .m-p-input-container .range-back-btn {
          flex: 0 0 28px !important;
          min-width: 28px !important;
          max-width: 28px !important;
          width: 28px !important;
          height: auto !important;
          margin: 0 !important;
          padding: 8px 0 !important;
          font-size: 11px !important;
          line-height: 1.2 !important;
          text-align: center !important;
          white-space: nowrap !important;
          overflow: hidden !important;
          box-sizing: border-box !important;
          border-radius: 4px !important;
          display: flex !important;
          justify-content: center !important;
          align-items: center !important;
          cursor: pointer !important;
          background-color: #6c757d !important;
          color: #fff !important;
        }
        #vd-online-tool-modal .m-p-input-container .range-back-btn:hover {
          background-color: #5a6268 !important;
        }
        /* 下载按钮：放宽宽度，flex居中 */
        #vd-online-tool-modal .m-p-input-container > div:nth-of-type(1),
        #vd-online-tool-modal .m-p-input-container > div:nth-of-type(2),
        #vd-online-tool-modal .m-p-input-container > div:nth-of-type(3) {
          flex: 1 1 0 !important;
          min-width: 0 !important;
          width: auto !important;
          height: auto !important;
          margin: 0 !important;
          padding: 8px 4px !important;
          font-size: 12px !important;
          line-height: 1.4 !important;
          text-align: center !important;
          white-space: nowrap !important;
          box-sizing: border-box !important;
          border-radius: 4px !important;
          display: flex !important;
          justify-content: center !important;
          align-items: center !important;
        }
        /* 下载状态提示：隐藏二维码区域（div），保留状态文字（p） */
        #vd-online-tool-modal .m-p-tips { 
          font-size: 11px !important; 
          padding: 4px 8px !important; 
          line-height: 1.4 !important; 
          margin: 0 !important;
        }
        #vd-online-tool-modal .m-p-tips > div { display: none !important; }
        #vd-online-tool-modal .m-p-tips p { width: auto !important; display: inline !important; margin-right: 10px !important; }
        /* 重试/强制下载按钮 */
        #vd-online-tool-modal .m-p-retry,
        #vd-online-tool-modal .m-p-force {
          margin: 4px 8px !important;
          padding: 6px 8px !important;
          font-size: 11px !important;
          height: auto !important;
          line-height: 1.4 !important;
          text-align: center !important;
        }
        /* 片段列表 */
        #vd-online-tool-modal .m-p-segment { 
          padding: 4px 8px 8px !important; 
          margin: 0 !important;
        }
        #vd-online-tool-modal .m-p-segment .item { 
          width: 20px !important; 
          height: 20px !important; 
          font-size: 10px !important; 
          line-height: 20px !important; 
          margin: 2px !important; 
        }
      `;
      contentArea.appendChild(hideStyle);
      contentArea.innerHTML += dom;
      modal.appendChild(contentArea);
      document.body.appendChild(modal);
      // 7. 依次加载依赖JS
      const deps = [
        'https://upyun.luckly-mjw.cn/lib/stream-saver.js',
        'https://blog.luckly-mjw.cn/tool-show/m3u8-downloader/mux-mp4.js',
        'https://blog.luckly-mjw.cn/tool-show/m3u8-downloader/aes-decryptor.js',
        'https://upyun.luckly-mjw.cn/lib/vue.js',
      ];
      for (const depUrl of deps) {
        const content = await injectAjax(depUrl);
        injectScriptContent(content);
      }
      // 8. 执行业务代码（保护history，防止原作者工具修改页面历史记录）
      const origReplaceState = history.replaceState.bind(history);
      const origPushState = history.pushState.bind(history);
      history.replaceState = function () {};
      history.pushState = function () {};
      try {
        // eslint-disable-next-line no-eval
        eval(script);
      } finally {
        history.replaceState = origReplaceState;
        history.pushState = origPushState;
      }
      // 8.1 恢复被原作者全局样式污染的页面样式（body/html等）和标题
      document.body.style.cssText = savedBodyStyle;
      document.documentElement.style.cssText = savedHtmlStyle;
      document.title = savedTitle;
      // 兜底：1秒后再恢复一次（防止Vue异步修改样式和标题）
      setTimeout(() => {
        document.body.style.cssText = savedBodyStyle;
        document.documentElement.style.cssText = savedHtmlStyle;
        document.title = savedTitle;
      }, 1000);
      // 9. 感叹号已在HTML模板里直接写死（.vd-mp4-warn），无需JS动态添加，避免匹配错误按钮
    } catch (e) {
      console.error('注入在线工具失败:', e);
      alert('注入在线工具失败: ' + (e.message || e));
    }
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
        let vParseError = null, aParseError = null;

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
        vFile.onError = e => {
          // 不直接reject：最后一个分片可能被截断（视频结束时moof不完整），
          // 此时已解析的样本仍然可用，标记错误后继续等待完成。
          vParseError = e;
        };

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
        aFile.onError = e => {
          aParseError = e;
        };

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
            const errInfo = vParseError ? `（解析警告: ${vParseError}）` : '';
            reject(new Error(`视频样本提取失败（0个样本）${errInfo}`));
            return;
          }
          if (aSamples.length === 0) {
            const errInfo = aParseError ? `（解析警告: ${aParseError}）` : '';
            reject(new Error(`音频样本提取失败（0个样本）${errInfo}`));
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
        // 截断不完整的最后一个box（视频结束时moof可能被截断，导致解析错误）
        const fullVideo = truncateIncompleteBox(concatBufs(videoBufs));
        const fullAudio = truncateIncompleteBox(concatBufs(audioBufs));

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

  // ========== 共用：主动seek到开头（自动完整下载和跳至结尾按钮共用） ==========
  // 先暂停→清空moof保留ftyp→解除锁定→seek到开头，play由调用方处理
  // 必须先解除锁定再seek，否则设置currentTime=0后播放器加载的分片会因为completeLocked=true被跳过
  function seekToBeginning(video) {
    if (!video) return;
    video.pause();
    // 先清空moof保留ftyp初始化片段
    sourceBufferList.forEach(entry => {
      const initBuffers = [];
      for (const buf of entry.buffers) {
        if (buf.byteLength >= 8) {
          const u8 = new Uint8Array(buf);
          const fb = String.fromCharCode(u8[4], u8[5], u8[6], u8[7]);
          if (fb === 'ftyp') initBuffers.push(buf);
        }
      }
      entry.buffers = initBuffers;
      entry.lastDts = 0;
    });
    fragCount = sourceBufferList.reduce((sum, e) => sum + e.buffers.length, 0);
    if (btnDownload) {
      btnDownload.textContent = `下载已捕获片段 (${fragCount})`;
    }
    // 先解除锁定（重置所有相关变量），再seek到开头
    captureLocked = false;
    completeLocked = false;
    truncatedByGap = false;
    seekedToEnd = false;
    maxBufferedEnd = 0;
    manualSeekToBeginning = false;
    streamEnded = false;
    endConfirmShown = false;
    lastBufferedRanges = [];
    smallSeekIgnoreFtyp = false;
    smallSeekIgnoreUntil = 0;
    // 用标志区分主动seek和自动重播，防止seeked事件里误调用resetCaptureState()把ftyp清掉
    manualSeekToBeginning = true;
    video.currentTime = 0;
  }

  // ========== 跳至结尾（如果已在结尾则跳至开头） ==========
  function skipToEnd() {
    const video = document.querySelector('video');
    if (!video || !video.duration || !isFinite(video.duration) || video.duration <= 0) return;
    // 如果已经在结尾（ended或currentTime与duration相差小于3秒），则跳至开头
    if (video.ended || video.duration - video.currentTime < 3) {
      // 直接调用共用的seekToBeginning函数，和自动完整下载的跳转逻辑完全一样
      seekToBeginning(video);
      video.play();
      if (btnSkip) btnSkip.textContent = '跳至结尾';
      return;
    }
    // 跳至结尾前先标红锁定（变色=锁定），防止跳转后的片尾内容混入已捕获分片
    if (sourceBufferList.length > 0 && !completeLocked) {
      seekedToEnd = true;
      truncatedByGap = true;
      completeLocked = true;
      if (btnDownload) {
        btnDownload.innerHTML = `下载已捕获片段 (<span style="color:#f44336;font-weight:600">${fragCount}</span>)`;
      }
    }
    video.currentTime = video.duration - 0.1;
    // 立即更新按钮文字为"跳至开头"，不用等timeupdate事件触发
    if (btnSkip) btnSkip.textContent = '跳至开头';
  }

  // ========== 自动完整下载（静默启动，再点一次可暂停取消） ==========
  let autoEndedHandler = null; // 保存ended事件处理函数，方便取消时移除
  let originalSpeed = 1; // 记录自动下载前的播放倍数，完成/取消时恢复
  function autoCompleteDownload() {
    const video = document.querySelector('video');
    if (!video) return alert('未找到视频元素');
    if (merging) return;

    // 如果已经在自动下载中，再次点击则暂停取消
    if (autoDownload) {
      autoDownload = false;
      autoDownloadDone = false;
      is16x = false;
      applySpeed(originalSpeed);
      btnSpeed.textContent = `${originalSpeed}×`;
      btnAuto.textContent = '自动完整下载';
      if (autoCompletePoll) { clearInterval(autoCompletePoll); autoCompletePoll = null; }
      if (autoEndedHandler) {
        video.removeEventListener('ended', autoEndedHandler);
        autoEndedHandler = null;
      }
      // 暂停时更新vdLastCt为当前播放位置（自动下载过程中正常播放不会触发seeked事件，
      // vdLastCt停留在开始位置0，导致暂停后跳转方向判定错误，正常标红逻辑失效）
      // 这只是更新位置变量，暂停后完全回到正常模式，遵循正常标红逻辑
      video.dataset.vdLastCt = video.currentTime;
      video.pause();
      // 恢复视频的静音和隐藏状态
      if (hiddenVideoState) {
        const hv = hiddenVideoState;
        hiddenVideoState = null;
        try {
          hv.el.muted = hv.muted;
          hv.el.style.visibility = hv.visibility;
          hv.el.style.opacity = hv.opacity;
        } catch (e) {}
      }
      return;
    }

    if (isBufferedComplete()) {
      download(true, true);
      return;
    }

    // 关键：先设置autoDownload=true和autoDownloadDone=false，再操作video
    // 视频播放完会自动从头开始，不需要主动设置currentTime=0；
    // 在seeked事件里检测到从头开始时再解除锁定并清空分片
    originalSpeed = video.playbackRate || 1; // 记录原来的倍数，完成/取消时恢复
    autoDownload = true;
    autoDownloadDone = false;
    is16x = true;
    applySpeed(16);
    btnSpeed.textContent = '16×';
    btnAuto.textContent = '自动捕获中(点击暂停)';
    // 不重置endConfirmShown，避免旧流关闭触发的endOfStream被当成新的一次

    // 如果已经标红（发生过大跳转，视频已不完整），主动从头开始播放，
    // 直接调用共用的seekToBeginning函数，和跳至结尾按钮的跳转逻辑完全一样
    if (truncatedByGap || completeLocked) {
      seekToBeginning(video);
    }

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

    // 自动下载完成后的统一处理（锁定捕获、恢复状态、开始下载）
    const finishAutoDownload = () => {
      if (autoCompletePoll) { clearInterval(autoCompletePoll); autoCompletePoll = null; }
      if (autoEndedHandler) { video.removeEventListener('ended', autoEndedHandler); autoEndedHandler = null; }
      if (!autoDownload || autoDownloadDone) return;
      autoDownloadDone = true;
      autoDownload = false;
      video.pause();
      captureLocked = true;
      completeLocked = true;
      truncatedByGap = false;
      seekedToEnd = false;
      is16x = false;
      applySpeed(originalSpeed);
      btnSpeed.textContent = `${originalSpeed}×`;
      if (btnAuto) btnAuto.textContent = '自动完整下载';
      if (btnDownload) {
        btnDownload.innerHTML = `下载已捕获片段 (<span style="color:#ff9800;font-weight:600">${fragCount}</span>)`;
      }
      // 恢复视频的静音和隐藏状态
      if (hiddenVideoState) {
        const hv = hiddenVideoState;
        hiddenVideoState = null;
        try {
          hv.el.muted = hv.muted;
          hv.el.style.visibility = hv.visibility;
          hv.el.style.opacity = hv.opacity;
        } catch (e) {}
      }
      download(true, true);
    };

    // 监听视频播放结束（兜底：有些网站buffered不会完整，等放完再下载）
    autoEndedHandler = () => {
      // 放完后等2秒让最后几个分片加载完成，再走统一完成逻辑
      setTimeout(finishAutoDownload, 2000);
    };
    video.addEventListener('ended', autoEndedHandler);

    // 轮询检测：buffered一旦完整就直接下载，不用等视频放完（避免自动重播多捕获片段）
    autoCompletePoll = setInterval(() => {
      if (!autoDownload || autoDownloadDone) return;
      if (isBufferedComplete()) {
        clearInterval(autoCompletePoll);
        autoCompletePoll = null;
        // buffered已完整，等500ms让最后几个分片稳定，直接下载
        setTimeout(finishAutoDownload, 500);
      }
    }, 500);

    // 开始播放（seek是异步的，play会等待seek完成）
    video.play();
  }

  // ========== 扫描视频资源 ==========
  function scanVideos() {
    // 不重置m3u8Url：保留fetch/XHR劫持捕获到的m3u8地址
    // 只有当video.src直接包含.m3u8时才更新（覆盖劫持捕获到的地址）
    document.querySelectorAll('video').forEach(v => {
      const src = v.currentSrc || v.src;
      if (!src) return;
      if (src.includes('.m3u8')) m3u8Url = src;

      // 持续记录最大缓存end值（seek时buffered会被清理，用这个值判断跳转目标是否在已缓存范围内）
      // 用progress事件驱动更新（缓冲变化时立即更新），比轮询更及时
      if (!v.dataset.vdBufBound) {
        v.dataset.vdBufBound = '1';
        v.addEventListener('progress', () => {
          if (completeLocked) return;
          if (v.buffered && v.buffered.length > 0) {
            for (let i = 0; i < v.buffered.length; i++) {
              if (v.buffered.end(i) > maxBufferedEnd) maxBufferedEnd = v.buffered.end(i);
            }
          }
        });
        // timeupdate事件持续记录最新缓存范围（seek前最后一次记录的才准确，seek时buffered会被清理）
        v.addEventListener('timeupdate', () => {
          // 动态更新跳至结尾按钮文字：视频在结尾时显示"跳至开头"，否则显示"跳至结尾"
          if (btnSkip && v.duration && isFinite(v.duration) && v.duration > 0) {
            if (v.ended || v.duration - v.currentTime < 3) {
              if (btnSkip.textContent !== '跳至开头') btnSkip.textContent = '跳至开头';
            } else {
              if (btnSkip.textContent !== '跳至结尾') btnSkip.textContent = '跳至结尾';
            }
          }
          if (completeLocked) return;
          lastBufferedRanges = [];
          if (v.buffered && v.buffered.length > 0) {
            for (let i = 0; i < v.buffered.length; i++) {
              lastBufferedRanges.push({ start: v.buffered.start(i), end: v.buffered.end(i) });
            }
          }
        });
        // 刚加载视频时检测是否从头播放：不是从头（currentTime>3秒）就直接标红锁定
        // 避免视频从中间开始播放时，向后跳转判断不准确导致捕获异常
        v.addEventListener('canplay', () => {
          if (completeLocked || autoDownload) return;
          if (v.currentTime > 3) {
            seekedToEnd = true;
            truncatedByGap = true;
            completeLocked = true;
            if (btnDownload) {
              btnDownload.innerHTML = `下载已捕获片段 (<span style="color:#f44336;font-weight:600">${fragCount}</span>)`;
            }
          }
        }, { once: true });
      }
      if (!completeLocked && v.buffered && v.buffered.length > 0) {
        for (let i = 0; i < v.buffered.length; i++) {
          if (v.buffered.end(i) > maxBufferedEnd) maxBufferedEnd = v.buffered.end(i);
        }
      }

      // 监听video元素的src变化：抖音等平台切换视频时复用同一个video元素，
      // 只改变src，不发ftyp也不创建新MediaSource，此时需要重置捕获状态，
      // 防止旧视频数据和新视频数据混合。用dataset标志避免重复监听。
      if (!v.dataset.vdSrcBound) {
        v.dataset.vdSrcBound = '1';
        v.dataset.vdLastSrc = src;
        const observer = new MutationObserver(() => {
          const newSrc = v.currentSrc || v.src;
          if (newSrc && newSrc !== v.dataset.vdLastSrc && !captureLocked) {
            v.dataset.vdLastSrc = newSrc;
            resetCaptureState();
          }
        });
        observer.observe(v, { attributes: true, attributeFilter: ['src', 'currentSrc'] });
      } else if (v.dataset.vdLastSrc !== src && !captureLocked) {
        // 兜底：scanVideos轮询时也检查一次src变化
        v.dataset.vdLastSrc = src;
        resetCaptureState();
      }

      // 监听seeked事件：重播检测（seek到开头且已完整则清空旧数据）、大跳转标记
      if (!v.dataset.vdSeekBound) {
        v.dataset.vdSeekBound = '1';
        v.addEventListener('seeked', () => {
          // 注意：不能因为captureLocked就return，否则自动下载完成后跳转进度条时，
          // 重播检测和正常标红逻辑都会被拦截。captureLocked只用于阻止MSE捕获新分片，
          // 不应该阻止seeked事件的状态判断。
          // 自动完整下载模式下：用户手动跳转时，和正常模式一样的标红逻辑
          // 向前跳转：立即中断自动下载并标红
          // 向后跳转：超出缓存才中断自动下载并标红，在缓存内不中断
          // 重播/主动seek到开头不中断，继续自动下载
          if (autoDownload) {
            // 主动seek到开头（标红/标黄后点击自动下载）或重播：不中断，继续自动下载
            if (manualSeekToBeginning || (v.currentTime < 3 && completeLocked)) {
              if (!manualSeekToBeginning) {
                // 重播：重置捕获状态
                resetCaptureState();
                if (btnDownload) {
                  btnDownload.textContent = `下载已捕获片段 (0)`;
                }
              }
              manualSeekToBeginning = false; // 重置标志
              v.dataset.vdLastCt = v.currentTime;
              return; // 不中断，继续自动下载
            }
            const lastCt = parseFloat(v.dataset.vdLastCt) || 0;
            const isForward = v.currentTime > lastCt; // 向后跳转
            // 向前跳转：立即中断并标红
            // 向后跳转：超出最大缓存end才中断并标红
            let needInterrupt = false;
            if (!isForward) {
              needInterrupt = true;
            } else if (v.currentTime > maxBufferedEnd) {
              needInterrupt = true;
            }
            if (needInterrupt) {
              autoDownload = false;
              autoDownloadDone = false;
              is16x = false;
              applySpeed(originalSpeed);
              if (btnSpeed) btnSpeed.textContent = `${originalSpeed}×`;
              if (btnAuto) {
                btnAuto.textContent = '自动下载异常(点击重试)';
              }
              if (autoCompletePoll) { clearInterval(autoCompletePoll); autoCompletePoll = null; }
              if (autoEndedHandler) {
                v.removeEventListener('ended', autoEndedHandler);
                autoEndedHandler = null;
              }
              // 恢复视频的静音和隐藏状态（和暂停一样）
              if (hiddenVideoState) {
                const hv = hiddenVideoState;
                hiddenVideoState = null;
                try {
                  hv.el.muted = hv.muted;
                  hv.el.style.visibility = hv.visibility;
                  hv.el.style.opacity = hv.opacity;
                } catch (e) {}
              }
              // 标红（自动下载过程中跳转一定是不完整的）
              seekedToEnd = true;
              truncatedByGap = true;
              completeLocked = true;
              if (btnDownload) {
                btnDownload.innerHTML = `下载已捕获片段 (<span style="color:#f44336;font-weight:600">${fragCount}</span>)`;
              }
              v.dataset.vdLastCt = v.currentTime;
              return; // 不继续走到正常模式的逻辑
            }
            // 向后跳转在缓存内：不中断，继续自动下载，更新位置
            v.dataset.vdLastCt = v.currentTime;
            return;
          }
          // 主动seek到开头（跳至结尾按钮触发的跳至开头）：不标红，重置标志，更新位置
          if (manualSeekToBeginning) {
            manualSeekToBeginning = false;
            v.dataset.vdLastCt = v.currentTime;
            return;
          }
          const lastCt = parseFloat(v.dataset.vdLastCt) || 0;
          const isForward = v.currentTime > lastCt; // 向后跳转
          // 向前跳转：只要向前跳转就标红（重复的向前跳转哪怕只有一点点也会导致片段数异常）
          // 向后跳转：只要超出最大缓存end就标红，不限制幅度（是否标红只取决于有没有超过已缓存部分）
          if (!isForward) {
            // 重播检测：seek到开头（currentTime<3）且之前已经锁定，说明是重播，
            // 清空旧数据并解除锁定，开始捕获新的一遍
            if (v.currentTime < 3 && completeLocked) {
              resetCaptureState();
            } else if (!completeLocked) {
              seekedToEnd = true;
              truncatedByGap = true;
              completeLocked = true;
              if (btnDownload) {
                btnDownload.innerHTML = `下载已捕获片段 (<span style="color:#f44336;font-weight:600">${fragCount}</span>)`;
              }
            }
          } else {
            // 向后跳转：只要超出历史最大缓存end就标红（maxBufferedEnd方案最稳，不会导致片段数少）
            if (v.currentTime < 3 && completeLocked) {
              resetCaptureState();
            } else if (!completeLocked && v.currentTime > maxBufferedEnd) {
              seekedToEnd = true;
              truncatedByGap = true;
              completeLocked = true;
              if (btnDownload) {
                btnDownload.innerHTML = `下载已捕获片段 (<span style="color:#f44336;font-weight:600">${fragCount}</span>)`;
              }
            }
          }
          v.dataset.vdLastCt = v.currentTime;
        });
        // 普通模式下视频播放完成（ended）后锁定捕获，防止自动重播的内容被追加
        v.addEventListener('ended', () => {
          if (captureLocked || autoDownload) return; // 自动完整下载模式有专门的autoEndedHandler处理
          if (sourceBufferList.length > 0 && !completeLocked) {
            completeLocked = true;
            // 大跳转后是红色，正常完整是橙色
            const color = seekedToEnd ? '#f44336' : '#ff9800';
            if (btnDownload) {
              btnDownload.innerHTML = `下载已捕获片段 (<span style="color:${color};font-weight:600">${fragCount}</span>)`;
            }
          }
        });
      }
    });

    if (sourceBufferList.length > 0) {
      btnAuto.style.display = 'block';
      // 有m3u8地址时也显示M3U8下载按钮（MSE和m3u8可以同时存在）
      btnOnline.style.display = m3u8Url ? 'block' : 'none';
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

    // 大跳转后下载：询问是否继续（可能音画不同步等问题）
    if ((seekedToEnd || truncatedByGap) && !autoMode) {
      if (!confirm('检测到大跳转或视频未从头播放，下载的视频可能出现音画不同步、后半段无声、进度条无法拖拽或画面异常等问题，建议从头播放或使用自动完整下载获取完整视频\n是否继续下载？')) return;
    }

    // 直接开始合成，不弹"未完整加载是否继续"的提醒；
    // 合成成功直接下载，合成失败才弹弹窗询问是否分开下载
    merging = true;
    const oldText = btnDownload.textContent;
    btnDownload.textContent = '合成中...';

    try {
      const title = getTitle();
      // 不完整下载时文件名加"片段"后缀
      // 自动完整下载模式下认为是完整视频（从头播到尾），不加片段后缀；
      // 标红（seekedToEnd/truncatedByGap）即使completeLocked=true也是不完整，加片段后缀；
      // completeLocked=true（标黄/完整锁定）且未标红认为是完整视频，不加片段后缀
      const isIncomplete = seekedToEnd || truncatedByGap || (!completeLocked && !isBufferedComplete());
      const nameSuffix = autoMode ? '' : (isIncomplete ? '_片段' : '');
      // 检测分片时间戳不连续点（seek跳转后加载的内容dts会突然跳变），
      // 只保留前面连续的部分，去掉seek后加载的不连续内容，避免合成时音画不同步。
      // 如果发生了截断，标记truncatedByGap，UI字体变红色提示。
      let didTruncate = false;
      sourceBufferList.forEach(entry => {
        const before = entry.buffers.length;
        entry.buffers = truncateAtTimeGap(entry);
        if (entry.buffers.length < before) didTruncate = true;
      });
      if (didTruncate) {
        // 截断了不连续内容，标记红色（保持锁定状态，不解除）
        truncatedByGap = true;
      }
      fragCount = sourceBufferList.reduce((s, e) => s + e.buffers.length, 0);
      // 分类音视频：优先mime，mime缺失时用init内容判断的kind兜底
      let videoItems = sourceBufferList.filter(i => itemKind(i) === 'video');
      let audioItems = sourceBufferList.filter(i => itemKind(i) === 'audio');
      // 多个MediaSource时（抖音等平台会预加载下一个视频，同时存在当前视频和下一个视频的MediaSource），
      // 只取最后一组（最新创建的）音视频轨，避免下载到预加载的下一个视频。
      // sourceBufferList按创建顺序排列，每个MediaSource的video+audio连续排列。
      if (videoItems.length > 1 && audioItems.length > 1) {
        const lastVideo = videoItems[videoItems.length - 1];
        const lastAudio = audioItems[audioItems.length - 1];
        videoItems = [lastVideo];
        audioItems = [lastAudio];
      }
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
            a.download = `${title}${nameSuffix}.${ext}`;
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
        a.download = `${title}${nameSuffix}.mp4`;
        a.href = URL.createObjectURL(mergedBlob);
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      } catch (e) {
        // 合成失败
        const complete = isBufferedComplete();
        const hasVideo = videoItems.length > 0 && videoItems[0].buffers.length > 0;
        const hasAudio = audioItems.length > 0 && audioItems[0].buffers.length > 0;
        // 没有可下载的内容时，直接提示错误，不弹分开下载的confirm
        if (!hasVideo && !hasAudio) {
          alert(`${complete ? '✅ 视频已完整加载' : '⚠️ 视频未完整加载'}\n视频合成失败：${e.message || '未知错误'}\n暂无可下载的内容，请刷新页面后从头播放再下载`);
          return;
        }
        // 有可下载内容时，弹原生confirm询问是否分开下载
        const failMsg = `${complete ? '✅ 视频已完整加载' : '⚠️ 视频未完整加载'}
视频合成失败：${e.message || '未知错误'}
是否分开下载视频和音频文件？（也可点击面板「M3U8下载」使用在线工具处理）`;
        if (!confirm(failMsg)) return;

        [videoItems[0], audioItems[0]].forEach((item, idx) => {
          setTimeout(() => {
            const kind = itemKind(item);
            const mime = (item.mime || '').split(';')[0] || (kind === 'audio' ? 'audio/mp4' : 'video/mp4');
            const ext = mime.split('/')[1] || 'mp4';
            const type = kind === 'audio' ? '音频' : '视频';
            const blob = new Blob(item.buffers, { type: mime });
            const a = document.createElement('a');
            a.download = `${title}${nameSuffix}_${type}.${ext}`;
            a.href = URL.createObjectURL(blob);
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
          }, idx * 300);
        });
      }
    } finally {
      merging = false;
      // 三种颜色状态：截断红色、完整锁定橙色（等重播或切换视频时才解除），否则恢复下载前文字
      if (btnDownload) {
        if (truncatedByGap) {
          btnDownload.innerHTML = `下载已捕获片段 (<span style="color:#f44336;font-weight:600">${fragCount}</span>)`;
        } else if (completeLocked) {
          btnDownload.innerHTML = `下载已捕获片段 (<span style="color:#ff9800;font-weight:600">${fragCount}</span>)`;
        } else {
          btnDownload.textContent = oldText;
        }
      }
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
      // 释放捕获锁（自动完整下载合成完成后，允许init segment清空旧数据）
      captureLocked = false;
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
      position: fixed; top: 50px; right: 20px; z-index: 9999;
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
    btnOnline.textContent = 'm3u8下载';

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
        scanTimer = setInterval(scanVideos, 2000);
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

    // UI初始化完成后立即重置一次捕获状态：
    // 脚本在document-start就开始劫持MSE，此时抖音等平台可能已预加载了下一个视频的分片，
    // 导致一开始捕获的数据是错的（下载到第二个视频）。这里清掉预加载的错误数据，
    // 从当前正在播放的视频开始捕获。
    resetCaptureState();
    // 页面加载就扫描视频并添加事件监听（不依赖面板展开），确保跳转标红等功能始终生效
    scanVideos();
  }

  // 暴露给注入的在线工具使用：用我们的mp4box.js无损合成逻辑替代原作者mux.js转码
  window.__vdMergeMP4 = mergeMP4;
  window.__vdConcatBufs = concatBufs;
  window.__vdTruncateIncompleteBox = truncateIncompleteBox;

  // DOM就绪后监听视频元素，检测到才渲染面板（没有视频流的页面不显示面板）
  function tryRenderPanel() {
    if (document.getElementById('vd-panel')) return true;
    // 检测页面中是否有video元素
    if (document.querySelector('video')) {
      renderPanel();
      return true;
    }
    return false;
  }

  function waitForVideoThenRender() {
    if (tryRenderPanel()) return;
    // DOM就绪时没有video元素，用MutationObserver监听动态创建的video元素
    const observer = new MutationObserver(() => {
      if (tryRenderPanel()) {
        observer.disconnect();
      }
    });
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        observer.observe(document.body, { childList: true, subtree: true });
      });
    }
    // 30秒后还没有检测到video元素：停止脚本（所有劫持直接透传，性能影响最小），断开监听
    setTimeout(() => {
      observer.disconnect();
      scriptStopped = true;
    }, 30000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForVideoThenRender);
  } else {
    waitForVideoThenRender();
  }

  // 调试接口（正式版可保留，无副作用）
  window.__vd = {
    getBuffers: () => sourceBufferList,
    getFrag: () => fragCount,
    mergeMP4: mergeMP4,
    isBufferedComplete: isBufferedComplete,
    getState: () => ({ streamEnded, captureLocked, autoDownload, m3u8Url, m3u8UrlList })
  };
})();
