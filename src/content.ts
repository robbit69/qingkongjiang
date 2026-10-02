import type { VideoCaptions, VideoInfo } from './bilibili';
import type { AnalysisResult, StageResult } from './analysis';
import { cacheKey, captionsAsText, DEFAULT_SETTINGS, formatElapsed, formatTime, formatUsd, isAnalysisCacheReusable, isAutoSkippable, isSeekBackIntoSkipped, mergeSegments, moveSegmentBoundary, nearestCueIndex, normalizeWhitelist, segmentKey, shouldDetectUp, summarizeCalls, type Cue, type DetectionRecord, type Segment, type Settings, type Up } from './core';
import { resolveStages } from './stages';
import { copyTextToClipboard } from './clipboard';

type VideoContext = VideoInfo & { cues?: Cue[]; track?: string };
type Cache = { segments: Segment[]; savedAt: number; analysisMs: number; epoch?: number };
type ContextReply = { video?: VideoContext; error?: string };
type PageState = { video: VideoInfo | null; status: string; statusKind: string; segments: Segment[]; analysisMs: number | null; cacheHit: boolean; track: string; ccCount: number; listed: boolean; settings: Pick<Settings, 'autoSkip' | 'cacheAnalysis'> };

const root = document.createElement('div');
root.id = 'qingkongjiang-root';
const shadow = root.attachShadow({ mode: 'closed' });
shadow.innerHTML = `<style>
  :host { all: initial; font-family: system-ui, sans-serif; color: #202228; }
  * { box-sizing: border-box; }
  button { border: 1px solid #cbd1df; background: #fff; color: #202228; border-radius: 7px; padding: 5px 8px; cursor: pointer; }
  button:hover { background: #f1f3fb; }
  .launcher { position: fixed; top: 110px; right: 22px; z-index: 2147483647; background: #263bdb; color: white; border: 0; border-radius: 17px; padding: 8px 12px; box-shadow: 0 4px 14px #0004; font-size: 12px; }
  .panel { position: fixed; top: 151px; right: 22px; z-index: 2147483647; width: 390px; max-height: min(78vh, 780px); overflow: auto; background: white; border: 1px solid #dce1eb; border-radius: 12px; box-shadow: 0 12px 36px #0004; padding: 12px; font-size: 12px; }
  .hidden { display: none; }
  .heading { display: flex; align-items: center; justify-content: space-between; font-size: 16px; font-weight: 700; }
  .status { white-space: pre-wrap; line-height: 1.45; background: #f1f3fb; padding: 8px; border-radius: 7px; margin: 10px 0; }
  .controls, .rowactions { display: flex; gap: 6px; margin: 8px 0; flex-wrap: wrap; }
  .row { border-top: 1px solid #e7eaf0; padding: 8px 0; }
  .rowhead { display: flex; justify-content: space-between; }
  .cue-preview { margin-top: 7px; padding: 6px 8px; border-radius: 6px; background: #f5f7fc; line-height: 1.45; }
  .cue-preview summary { cursor: pointer; color: #4f5d75; }
  .cue-preview p { margin: 5px 0; overflow-wrap: anywhere; }
  .badge { color: #263bdb; }
  .interval { display: flex; align-items: center; gap: 5px; margin-top: 6px; }
  .interval input { width: 68px; padding: 4px; border: 1px solid #cbd1df; border-radius: 5px; }
  .sub { color: #687287; line-height: 1.4; }
  .history { margin: 10px 0; border: 1px solid #e3e6ed; border-radius: 8px; padding: 8px; }
  .history h3 { margin: 0 0 6px; font-size: 13px; }
  .history-list { max-height: 260px; overflow: auto; }
  .history-list details { border-top: 1px solid #e7eaf0; padding: 6px 0; }
  .history-list summary { cursor: pointer; line-height: 1.4; }
  .history-list p { margin: 4px 0; color: #596478; line-height: 1.4; overflow-wrap: anywhere; }
  iframe { display: block; width: 100%; height: 570px; border: 1px solid #e3e6ed; border-radius: 8px; margin-top: 10px; background: #f6f7fb; }
</style>
<button class="launcher" type="button">调试</button>
<section class="panel hidden" aria-label="请空降调试面板">
  <div class="heading"><span>请空降 · 调试</span><button class="close" type="button" aria-label="关闭">×</button></div>
  <div class="status">正在准备…</div>
  <div class="controls"><button class="refresh" type="button">重新分析</button><button class="add" type="button">添加手动区间</button></div>
  <div class="rows"></div>
  <div class="history"><h3>历次检测</h3><div class="history-list"><span class="sub">暂无检测记录</span></div><div class="sub">Jev 成本按 TypeSafe 公布的输入单价估算；LLM 按设置的单价估算。</div></div>
  <div class="sub">下面可直接修改扩展设置、白名单和 API。</div>
  <iframe title="请空降设置" loading="lazy"></iframe>
</section>`;
document.documentElement.append(root);

const $ = <T extends Element>(selector: string): T => shadow.querySelector(selector) as T;
const launcher = $<HTMLButtonElement>('.launcher');
const panel = $<HTMLElement>('.panel');
const statusEl = $<HTMLElement>('.status');
const rows = $<HTMLElement>('.rows');
const historyList = $<HTMLElement>('.history-list');
$<HTMLIFrameElement>('iframe').src = chrome.runtime.getURL('popup.html');

let settingsState: Settings = { ...DEFAULT_SETTINGS };
let whitelist: Up[] = [];
let current: VideoContext | null = null;
let currentCues: Cue[] = [];
let track = '';
let segments: Segment[] = [];
let analysisMs: number | null = null;
let cacheHit = false;
let statusKind = 'idle';
let statusText = '正在准备…';
let key = '';
let manualKey = '';
let run = 0;
let analysisStartedAt = 0;
let route = '';
let suppressionRoute = '';
let video: HTMLVideoElement | null = null;
let progressWrap: Element | null = null;
let markerLayer: HTMLDivElement | null = null;
let controlHost: Element | null = null;
let controlBox: HTMLDivElement | null = null;
let autoButton: HTMLButtonElement | null = null;
let upButton: HTMLButtonElement | null = null;
let rejudgeButton: HTMLButtonElement | null = null;
let copyCcButton: HTMLButtonElement | null = null;
let controlsHideTimer: number | undefined;
let controlsHovered = false;
let undoToast: HTMLDivElement | null = null;
let undoHideTimer: number | undefined;
const autoSkipped = new Set<string>();
const suppressed = new Set<string>();

function renderHistory(history: DetectionRecord[]): void {
  historyList.replaceChildren();
  if (!history.length) { historyList.textContent = '暂无检测记录'; return; }
  for (const record of history.slice(0, 50)) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    const recordedCalls = Array.isArray(record.calls) ? record.calls : [];
    const total = summarizeCalls(recordedCalls);
    const cost = !recordedCalls.length && record.status !== 'success' ? '用量未知'
      : total.missingCost ? `已知 ${formatUsd(total.costUsd)}，部分未计价` : formatUsd(total.costUsd);
    summary.textContent = `${new Date(record.at).toLocaleString('zh-CN')} · ${record.title || record.bvid} · ${formatElapsed(record.elapsedMs)} · ${cost}`;
    details.append(summary);
    const meta = document.createElement('p');
    meta.textContent = `${record.status === 'success' ? '完成' : record.status === 'partial' ? '部分失败' : '中断'} · ${record.cueCount} 条字幕 / ${record.windowCount} 阶段 / ${record.segmentCount} 个区间 · ${recordedCalls.length ? `${total.attempts} 次请求 · ${total.missingUsage ? '已知 ' : ''}输入 ${total.inputTokens} / 输出 ${total.outputTokens} token${total.missingUsage ? '（部分接口未返回用量）' : ''}` : '接口用量未返回'}`;
    details.append(meta);
    if (record.warning) {
      const warning = document.createElement('p');
      warning.textContent = `原因：${record.warning}`;
      details.append(warning);
    }
    recordedCalls.forEach((call, index) => {
      const line = document.createElement('p');
      line.textContent = `#${index + 1} ${call.provider.toUpperCase()} ${call.model} · ${formatElapsed(call.elapsedMs)} · 输入 ${call.inputTokens ?? '未知'} / 输出 ${call.outputTokens ?? '未知'} token · ${call.costUsd === null ? '成本未知' : formatUsd(call.costUsd)}${call.failed ? ' · 请求失败' : ''}${call.attempts > 1 ? ` · 重试 ${call.attempts - 1} 次` : ''}`;
      details.append(line);
    });
    historyList.append(details);
  }
}

async function addDetectionRecord(record: DetectionRecord): Promise<void> {
  const stored = await chrome.storage.local.get('detectionHistory');
  const previous = Array.isArray(stored.detectionHistory) ? stored.detectionHistory as DetectionRecord[] : [];
  await chrome.storage.local.set({ detectionHistory: [record, ...previous].slice(0, 50) });
}

async function loadHistory(): Promise<void> {
  const stored = await chrome.storage.local.get('detectionHistory');
  renderHistory(Array.isArray(stored.detectionHistory) ? stored.detectionHistory as DetectionRecord[] : []);
}

function videoId(): { bvid: string; page: number } | null {
  const match = location.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})/i);
  if (!match) return null;
  const p = Number(new URLSearchParams(location.search).get('p') || '1');
  return { bvid: match[1], page: Number.isInteger(p) && p > 0 ? p : 1 };
}

function listed(): boolean { return Boolean(current?.owner.mid && whitelist.some(up => up.mid === current?.owner.mid)); }
function setStatus(kind: string, message: string): void {
  statusKind = kind; statusText = message;
  statusEl.textContent = `${message}${analysisMs !== null ? `\n广告判定用时：${formatElapsed(analysisMs)}` : ''}`;
}
function pageState(): PageState {
  return {
    video: current ? { bvid: current.bvid, cid: current.cid, title: current.title, duration: current.duration, owner: current.owner } : null,
    status: statusText, statusKind, segments, analysisMs, cacheHit, track, ccCount: currentCues.length, listed: listed(),
    settings: { autoSkip: settingsState.autoSkip, cacheAnalysis: settingsState.cacheAnalysis },
  };
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;
  const type = (message as { type?: string }).type;
  if (type === 'GET_PAGE_STATE') sendResponse(pageState());
  if (type === 'GET_CC_TEXT') sendResponse(currentCues.length
    ? { text: captionsAsText(currentCues), count: currentCues.length }
    : { error: '当前视频没有可用 CC 字幕' });
});

async function loadPreferences(): Promise<void> {
  const stored = await chrome.storage.local.get(['settings', 'upWhitelist']);
  settingsState = { ...DEFAULT_SETTINGS, ...(stored.settings ?? {}) };
  whitelist = normalizeWhitelist(stored.upWhitelist);
  renderPlayerControls();
}

async function saveManual(): Promise<void> {
  if (manualKey) await chrome.storage.local.set({ [manualKey]: segments.filter(s => s.source === 'manual') });
}

async function saveAnalysis(): Promise<void> {
  if (!settingsState.cacheAnalysis || !key || analysisMs === null || !current || listed()) return;
  const runAtSave = run;
  const startedAt = analysisStartedAt;
  const cacheKeyToWrite = key;
  const ownerMid = current.owner.mid;
  const segmentsToCache = segments.filter(s => s.source !== 'manual');
  const analysisMsToCache = analysisMs;
  const stored = await chrome.storage.local.get(['upWhitelist', 'analysisCacheEpoch']);
  if (run !== runAtSave || key !== cacheKeyToWrite || startedAt <= (Number(stored.analysisCacheEpoch) || 0) ||
    !shouldDetectUp(ownerMid, normalizeWhitelist(stored.upWhitelist))) return;
  const cache: Cache = { segments: segmentsToCache, savedAt: Date.now(), analysisMs: analysisMsToCache, epoch: Number(stored.analysisCacheEpoch) || 0 };
  await chrome.storage.local.set({ [cacheKeyToWrite]: cache });
}

function renderRows(): void {
  rows.replaceChildren();
  if (!segments.length) {
    const empty = document.createElement('p'); empty.className = 'sub'; empty.textContent = '暂无区间。可手动添加。'; rows.append(empty); return;
  }
  segments.forEach((segment, index) => {
    const row = document.createElement('div'); row.className = 'row';
    const head = document.createElement('div'); head.className = 'rowhead';
    const label = document.createElement('span'); label.textContent = `${formatTime(segment.start)} – ${formatTime(segment.end)}`;
    const badge = document.createElement('span'); badge.className = 'badge';
    badge.textContent = segment.source === 'manual' ? '手动' : segment.source === 'jev' ? `Jev ${Math.round((segment.confidence ?? 0) * 100)}%` : 'LLM 待核对';
    head.append(label, badge);
    const interval = document.createElement('div'); interval.className = 'interval';
    const first = document.createElement('input'); const last = document.createElement('input');
    for (const input of [first, last]) { input.type = 'number'; input.min = '0'; input.step = '0.1'; }
    first.value = segment.start.toFixed(1); last.value = segment.end.toFixed(1);
    first.setAttribute('aria-label', '开始秒数'); last.setAttribute('aria-label', '结束秒数');
    const separator = document.createElement('span'); separator.textContent = '至';
    const unit = document.createElement('span'); unit.textContent = '秒';
    interval.append(first, separator, last, unit);
    const actions = document.createElement('div'); actions.className = 'rowactions';
    const saveButton = document.createElement('button'); saveButton.textContent = '保存区间';
    saveButton.onclick = () => {
      const start = Number(first.value), end = Number(last.value);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) { setStatus('error', '区间须满足：开始 ≥ 0，结束 > 开始'); return; }
      commitManualSegment(index, { start, end, source: 'manual', confirmed: true }, '区间已保存到本机');
    };
    const jumpButton = document.createElement('button'); jumpButton.textContent = '跳过';
    jumpButton.onclick = () => { if (video) { autoSkipped.add(segmentKey(segment)); video.currentTime = segment.end + 0.1; } };
    const deleteButton = document.createElement('button'); deleteButton.textContent = '删除';
    deleteButton.onclick = () => { segments.splice(index, 1); renderRows(); renderMarkers(); void saveManual(); void saveAnalysis(); };
    actions.append(saveButton, jumpButton, deleteButton);
    row.append(head, interval);
    if (currentCues.length) {
      const preview = document.createElement('details'); preview.className = 'cue-preview';
      const summary = document.createElement('summary'); summary.textContent = '查看起止附近的 CC 字幕'; preview.append(summary);
      for (const boundary of ['start', 'end'] as const) {
        const cueIndex = nearestCueIndex(currentCues, segment[boundary], boundary);
        const line = document.createElement('p');
        const neighbors = currentCues.slice(Math.max(0, cueIndex - 1), Math.min(currentCues.length, cueIndex + 2));
        line.textContent = `${boundary === 'start' ? '起点' : '终点'}：${neighbors.map(cue => `${cue === currentCues[cueIndex] ? '【' : ''}${cue.content}${cue === currentCues[cueIndex] ? '】' : ''}`).join(' ／ ')}`;
        preview.append(line);
      }
      row.append(preview);
      const adjust = document.createElement('div'); adjust.className = 'rowactions';
      for (const boundary of ['start', 'end'] as const) {
        for (const direction of [-1, 1] as const) {
          const button = document.createElement('button'); button.type = 'button';
          button.textContent = `${boundary === 'start' ? '起点' : '终点'}${direction < 0 ? '前一句' : '后一句'}`;
          const cueIndex = nearestCueIndex(currentCues, segment[boundary], boundary);
          button.disabled = cueIndex + direction < 0 || cueIndex + direction >= currentCues.length;
          button.onclick = () => {
            const adjusted = moveSegmentBoundary(segments[index], currentCues, boundary, direction);
            if (!adjusted) { setStatus('error', '无法再移动该边界，或起点会超过终点'); return; }
            commitManualSegment(index, adjusted);
          };
          adjust.append(button);
        }
      }
      row.append(adjust);
    }
    row.append(actions); rows.append(row);
  });
}

function commitManualSegment(index: number, segment: Segment, message = '已按 CC 字幕时间戳保存区间'): void {
  segments[index] = segment;
  renderRows(); renderMarkers();
  void saveManual(); void saveAnalysis();
  setStatus('success', message);
}

function renderMarkers(): void {
  const wrap = document.querySelector('.bpx-player-progress-wrap');
  if (wrap !== progressWrap) { markerLayer?.remove(); markerLayer = null; progressWrap = wrap; }
  if (!wrap) return;
  if (!markerLayer) {
    markerLayer = document.createElement('div');
    markerLayer.className = 'qkj-marker-layer';
    markerLayer.style.cssText = 'position:absolute;left:0;top:7px;width:100%;height:5px;pointer-events:none;z-index:42;overflow:visible;';
    wrap.append(markerLayer);
  }
  markerLayer.replaceChildren();
  const duration = video?.duration && Number.isFinite(video.duration) ? video.duration : current?.duration || 0;
  if (!duration) return;
  for (const segment of segments) {
    const start = Math.max(0, Math.min(100, segment.start / duration * 100));
    const end = Math.max(start, Math.min(100, segment.end / duration * 100));
    const marker = document.createElement('div');
    marker.style.cssText = `position:absolute;left:${start}%;width:${Math.max(end - start, 0.2)}%;top:0;height:100%;border-radius:2px;background:${segment.source === 'llm' ? '#e6a23c' : segment.source === 'manual' ? '#4d84f5' : '#31b46b'};`;
    markerLayer.append(marker);
  }
}

function renderPlayerControls(): void {
  if (!autoButton || !upButton || !rejudgeButton || !copyCcButton) return;
  autoButton.textContent = `自动跳过：${settingsState.autoSkip ? '开' : '关'}`;
  autoButton.setAttribute('aria-pressed', String(settingsState.autoSkip));
  const isListed = listed();
  upButton.textContent = `UP 免检测：${isListed ? '开' : '关'}`;
  upButton.setAttribute('aria-pressed', String(isListed));
  upButton.disabled = !current?.owner.mid;
  rejudgeButton.disabled = !current || isListed;
  rejudgeButton.title = isListed ? '先将当前 UP 移出白名单' : '忽略本地缓存，重新调用 Jev 判断';
  copyCcButton.disabled = !currentCues.length;
  copyCcButton.title = currentCues.length ? `复制当前 ${currentCues.length} 条 CC 字幕及时间戳` : '当前没有可用 CC 字幕';
  copyCcButton.textContent = '复制 CC';
}

function dismissUndoToast(): void {
  window.clearTimeout(undoHideTimer);
  undoToast?.remove();
  undoToast = null;
}

function showUndoToast(segment: Segment): void {
  dismissUndoToast();
  const host = controlHost ?? video?.parentElement;
  if (!host || !video) return;
  if (getComputedStyle(host).position === 'static') (host as HTMLElement).style.position = 'relative';
  const skippedVideo = video;
  const skippedRoute = route;
  const start = segment.start;
  const id = segmentKey(segment);
  const toast = document.createElement('div');
  toast.className = 'qkj-undo-toast';
  toast.setAttribute('role', 'status');
  const top = 24 + Math.ceil(controlBox?.getBoundingClientRect().height || 31);
  toast.style.cssText = `position:absolute;top:${top}px;right:16px;z-index:80;display:flex;align-items:center;gap:8px;max-width:calc(100% - 32px);padding:7px 9px;border-radius:8px;background:#20242ae8;color:white;font:600 12px system-ui,sans-serif;box-shadow:0 4px 14px #0005;`;
  const label = document.createElement('span');
  label.textContent = `已跳过 ${formatTime(segment.start)}–${formatTime(segment.end)}`;
  const button = document.createElement('button');
  button.type = 'button'; button.textContent = '撤销';
  button.style.cssText = 'border:1px solid #ffffffaa;border-radius:6px;background:white;color:#202228;padding:4px 7px;font:700 12px system-ui,sans-serif;cursor:pointer;';
  toast.addEventListener('pointerdown', event => event.stopPropagation());
  toast.addEventListener('click', event => event.stopPropagation());
  button.onclick = () => {
    if (video === skippedVideo && route === skippedRoute) {
      suppressed.add(id);
      video.currentTime = start;
      setStatus('success', `已回到 ${formatTime(start)}，本次观看不会再跳过该区间。`);
    }
    dismissUndoToast();
  };
  toast.append(label, button);
  host.append(toast);
  undoToast = toast;
  undoHideTimer = window.setTimeout(dismissUndoToast, 6500);
}

function hidePlayerControls(): void {
  if (!controlBox) return;
  controlBox.style.opacity = '0';
  controlBox.style.pointerEvents = 'none';
}

function showPlayerControls(): void {
  if (!controlBox) return;
  controlBox.style.opacity = '1';
  controlBox.style.pointerEvents = 'auto';
  window.clearTimeout(controlsHideTimer);
  if (!controlsHovered) controlsHideTimer = window.setTimeout(hidePlayerControls, 2800);
}

function onPlayerLeave(): void {
  controlsHovered = false;
  window.clearTimeout(controlsHideTimer);
  hidePlayerControls();
}

function attachPlayerControls(): void {
  const host = document.querySelector('.bpx-player-container') ?? video?.parentElement ?? null;
  if (host === controlHost) return;
  controlHost?.removeEventListener('mousemove', showPlayerControls);
  controlHost?.removeEventListener('mouseleave', onPlayerLeave);
  window.clearTimeout(controlsHideTimer);
  controlBox?.remove(); controlBox = null; autoButton = null; upButton = null; rejudgeButton = null; copyCcButton = null; controlHost = host;
  if (!host) return;
  if (getComputedStyle(host).position === 'static') (host as HTMLElement).style.position = 'relative';
  const box = document.createElement('div'); box.className = 'qkj-player-switches';
  box.style.cssText = 'position:absolute;right:16px;top:16px;display:flex;flex-wrap:wrap;justify-content:flex-end;max-width:calc(100% - 32px);gap:6px;z-index:70;opacity:0;pointer-events:none;transition:opacity .18s ease;';
  box.addEventListener('mouseenter', () => { controlsHovered = true; showPlayerControls(); });
  box.addEventListener('mouseleave', () => { controlsHovered = false; showPlayerControls(); });
  box.addEventListener('pointerdown', event => event.stopPropagation());
  box.addEventListener('click', event => event.stopPropagation());
  const makeButton = () => {
    const button = document.createElement('button'); button.type = 'button';
    button.style.cssText = 'border:1px solid #ffffffaa;border-radius:16px;background:#20242acc;color:white;padding:6px 9px;font:600 12px system-ui,sans-serif;cursor:pointer;white-space:nowrap;';
    return button;
  };
  autoButton = makeButton(); upButton = makeButton(); rejudgeButton = makeButton(); copyCcButton = makeButton();
  rejudgeButton.textContent = '重新判断';
  autoButton.onclick = () => {
    settingsState.autoSkip = !settingsState.autoSkip; renderPlayerControls();
    void chrome.storage.local.set({ settings: settingsState });
  };
  upButton.onclick = () => {
    if (!current?.owner.mid) return;
    const mid = current.owner.mid;
    const next = listed() ? whitelist.filter(up => up.mid !== mid) : [...whitelist, current.owner];
    void chrome.storage.local.set({ upWhitelist: normalizeWhitelist(next) });
  };
  rejudgeButton.onclick = () => void openVideo(true);
  copyCcButton.onclick = () => {
    if (!currentCues.length) return;
    const cuesToCopy = currentCues;
    const button = copyCcButton;
    void copyTextToClipboard(captionsAsText(cuesToCopy)).then(() => {
      setStatus('success', `已复制 ${cuesToCopy.length} 条 CC 字幕及时间戳。`);
      if (button && button === copyCcButton) button.textContent = `已复制 ${cuesToCopy.length} 条`;
    }).catch(error => {
      setStatus('error', `复制字幕失败：${error instanceof Error ? error.message : String(error)}`);
      if (button && button === copyCcButton) button.textContent = '复制失败';
    }).finally(() => {
      window.setTimeout(() => { if (button && button === copyCcButton) renderPlayerControls(); }, 2600);
    });
  };
  box.append(autoButton, upButton, copyCcButton, rejudgeButton); host.append(box); controlBox = box;
  host.addEventListener('mousemove', showPlayerControls);
  host.addEventListener('mouseleave', onPlayerLeave);
  renderPlayerControls();
}

function onSeeking(): void {
  if (!video) return;
  const target = video.currentTime;
  for (const segment of segments) {
    const id = segmentKey(segment);
    if (isSeekBackIntoSkipped(segment, target, autoSkipped)) suppressed.add(id);
  }
}

function onTimeUpdate(): void {
  if (!video || !settingsState.autoSkip || !videoId()) return;
  const time = video.currentTime;
  const segment = segments.find(s => time >= s.start && time < s.end - 0.15 && isAutoSkippable(s, settingsState.jevThreshold) && !autoSkipped.has(segmentKey(s)) && !suppressed.has(segmentKey(s)));
  if (!segment) return;
  const id = segmentKey(segment);
  autoSkipped.add(id);
  video.currentTime = segment.end + 0.1;
  setStatus('success', `已自动跳过 ${formatTime(segment.start)}–${formatTime(segment.end)}。手动拖回后本次不再跳过该区间。`);
  showUndoToast(segment);
}

function attachVideo(): void {
  const next = document.querySelector('video');
  if (next === video) return;
  video?.removeEventListener('timeupdate', onTimeUpdate);
  video?.removeEventListener('seeking', onSeeking);
  video?.removeEventListener('loadedmetadata', renderMarkers);
  dismissUndoToast();
  video = next;
  video?.addEventListener('timeupdate', onTimeUpdate);
  video?.addEventListener('seeking', onSeeking);
  video?.addEventListener('loadedmetadata', renderMarkers);
}

async function analyze(captions: VideoCaptions, token: number): Promise<void> {
  if (!settingsState.jevKey && !settingsState.llmEnabled) {
    setStatus('ready', `已获取 ${captions.cues.length} 条 ${track} 字幕。填写 API Key 后可重新分析。`);
    return;
  }
  const start = performance.now();
  let summary: Awaited<ReturnType<typeof resolveStages>>;
  try {
    summary = await resolveStages(captions.cues,
      window => chrome.runtime.sendMessage({ type: 'ANALYZE_STAGE', window }) as Promise<StageResult>,
      window => chrome.runtime.sendMessage({ type: 'REFINE_BOUNDARIES', window }) as Promise<AnalysisResult>,
      () => token === run,
      (done, total) => setStatus('analyzing', `正在判定口播推广：${done}/${total} 个字幕阶段`));
  } catch (error) {
    if (token === run) setStatus('error', `判定中断：${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (token !== run) return;
  const { segments: found, warnings, calls, stageCount } = summary;
  if (stageCount) void addDetectionRecord({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(), bvid: captions.bvid, title: captions.title,
    cueCount: captions.cues.length, windowCount: stageCount,
    elapsedMs: performance.now() - start, segmentCount: found.length,
    status: warnings.some(w => !w.includes('已用 LLM 兜底')) ? 'partial' : 'success', calls,
    warning: warnings.filter(w => !w.includes('已用 LLM 兜底')).slice(0, 2).join('；') || undefined,
  }).catch(() => { /* Recording must not interrupt video playback. */ });
  analysisMs = performance.now() - start;
  segments = mergeSegments([...segments.filter(s => s.source === 'manual'), ...found]);
  renderRows(); renderMarkers();
  const failed = warnings.filter(w => !w.includes('已用 LLM 兜底'));
  if (failed.length) setStatus('partial', `部分判定失败：${[...new Set(failed)].slice(0, 2).join('；')}。已得到 ${found.length} 个候选区间。`);
  else setStatus('success', `判定完成：${found.length} 个候选区间，${captions.cues.length} 条 ${track} 字幕。`);
  if (!failed.length) await saveAnalysis();
}

async function openVideo(force = false): Promise<void> {
  const id = videoId(); if (!id) return;
  dismissUndoToast();
  const token = ++run;
  analysisStartedAt = Date.now();
  const nextRoute = `${id.bvid}:${id.page}`;
  if (nextRoute !== suppressionRoute) { autoSkipped.clear(); suppressed.clear(); suppressionRoute = nextRoute; }
  current = null; currentCues = []; track = ''; key = ''; manualKey = `manual:${id.bvid}:${id.page}`;
  segments = []; analysisMs = null; cacheHit = false;
  renderRows(); renderMarkers(); renderPlayerControls(); setStatus('loading', '正在读取视频信息…');
  try {
    await loadPreferences();
    const manualStored = await chrome.storage.local.get(manualKey);
    if (token !== run) return;
    segments = Array.isArray(manualStored[manualKey]) ? manualStored[manualKey] as Segment[] : [];
    renderRows(); renderMarkers();
    const reply = await chrome.runtime.sendMessage({ type: 'GET_VIDEO_CONTEXT', bvid: id.bvid, page: id.page }) as ContextReply;
    if (token !== run) return;
    if (!reply?.video) throw new Error(reply?.error || '视频信息获取失败');
    current = reply.video; track = reply.video.track || '';
    currentCues = reply.video.cues ?? [];
    renderPlayerControls(); renderMarkers();
    if (reply.error) { setStatus('error', `获取字幕失败：${reply.error}`); return; }
    if (!reply.video.cues?.length) { setStatus('error', '此视频没有可用 CC 字幕。'); return; }
    if (current.owner.mid > 0 && !shouldDetectUp(current.owner.mid, whitelist)) {
      setStatus('filtered', '当前 UP 在免检测白名单中；CC 字幕仍可复制。');
      return;
    }
    const captions = reply.video as VideoCaptions;
    key = cacheKey(captions.bvid, captions.cid, captions.cues);
    if (!force && settingsState.cacheAnalysis) {
      const cacheStart = performance.now();
      const epochKey = `upCacheEpoch:${current.owner.mid}`;
      const stored = await chrome.storage.local.get([key, epochKey, 'analysisCacheEpoch']);
      const cache = stored[key] as Cache | undefined;
      if (token !== run) return;
      const invalidatedAt = Math.max(Number(stored[epochKey]) || 0, Number(stored.analysisCacheEpoch) || 0);
      if (cache && (cache.epoch ?? 0) === (Number(stored.analysisCacheEpoch) || 0) && isAnalysisCacheReusable(cache.savedAt, invalidatedAt, Date.now())) {
        segments = mergeSegments([...segments, ...cache.segments]);
        analysisMs = cache.analysisMs; cacheHit = true;
        renderRows(); renderMarkers();
        setStatus('cached', `已命中本地缓存（读取 ${formatElapsed(performance.now() - cacheStart)}）：${segments.length} 个区间，${captions.cues.length} 条 ${track} 字幕。`);
        return;
      }
    }
    await analyze(captions, token);
  } catch (error) {
    if (token === run) setStatus('error', `读取失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

launcher.onclick = () => { panel.classList.toggle('hidden'); if (!panel.classList.contains('hidden')) void loadHistory(); };
$<HTMLButtonElement>('.close').onclick = () => panel.classList.add('hidden');
$<HTMLButtonElement>('.refresh').onclick = () => void openVideo(true);
$<HTMLButtonElement>('.add').onclick = () => {
  const start = video?.currentTime ?? 0;
  segments.push({ start, end: start + 10, source: 'manual', confirmed: true });
  renderRows(); renderMarkers(); void saveManual(); setStatus('success', '已添加 10 秒区间。可修改起止秒数。');
};

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings) {
    settingsState = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue ?? {}) };
    renderPlayerControls();
  }
  if (changes.detectionHistory) renderHistory(Array.isArray(changes.detectionHistory.newValue) ? changes.detectionHistory.newValue as DetectionRecord[] : []);
  if (changes.upWhitelist) {
    const wasEligible = current ? shouldDetectUp(current.owner.mid, whitelist) : null;
    whitelist = normalizeWhitelist(changes.upWhitelist.newValue);
    renderPlayerControls();
    if (current) {
      const nowEligible = shouldDetectUp(current.owner.mid, whitelist);
      if (wasEligible !== nowEligible) {
        void chrome.storage.local.set({ [`upCacheEpoch:${current.owner.mid}`]: Date.now() });
        if (!nowEligible && key) void chrome.storage.local.remove(key);
        void openVideo(nowEligible);
      }
    }
  }
});

function tick(): void {
  attachVideo(); attachPlayerControls(); renderMarkers();
  const id = videoId(); const next = id ? `${id.bvid}:${id.page}` : '';
  root.style.display = id ? '' : 'none';
  if (!id && route) { run++; route = ''; suppressionRoute = ''; current = null; currentCues = []; segments = []; autoSkipped.clear(); suppressed.clear(); dismissUndoToast(); controlHost?.removeEventListener('mousemove', showPlayerControls); controlHost?.removeEventListener('mouseleave', onPlayerLeave); controlBox?.remove(); markerLayer?.remove(); controlHost = null; progressWrap = null; return; }
  if (id && route !== next) { route = next; void openVideo(); }
}
tick();
setInterval(tick, 1000);
