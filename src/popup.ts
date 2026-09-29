import { analysisCacheKeys, DEFAULT_SETTINGS, formatElapsed, formatTime, normalizeWhitelist, type Segment, type Settings, type Up } from './core';
import type { VideoInfo } from './bilibili';
import { jevEndpoint } from './analysis';
import { copyTextToClipboard } from './clipboard';

type PageState = { video: VideoInfo | null; status: string; statusKind: string; segments: Segment[]; analysisMs: number | null; cacheHit: boolean; track: string; ccCount: number; listed: boolean; settings: Pick<Settings, 'autoSkip' | 'cacheAnalysis'> };

const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const element = (id: string) => document.getElementById(id) as HTMLElement;
let settings: Settings = { ...DEFAULT_SETTINGS };
let whitelist: Up[] = [];
let current: PageState | null = null;

function showMessage(message: string, success = false): void {
  const target = element('settingsStatus');
  target.style.color = success ? '#217245' : '#a52d2d';
  target.textContent = message;
}

function fillSettings(): void {
  for (const id of ['autoSkip', 'cacheAnalysis', 'llmEnabled'] as const) input(id).checked = settings[id];
  for (const id of ['jevHost', 'jevKey', 'jevModel', 'jevThreshold', 'llmUrl', 'llmKey', 'llmModel', 'llmInputUsdPerMillion', 'llmOutputUsdPerMillion'] as const) input(id).value = String(settings[id]);
}

function readSettings(): Settings {
  const threshold = Number(input('jevThreshold').value);
  if (!Number.isFinite(threshold) || threshold < 0.5 || threshold > 0.99) throw new Error('Jev 阈值需在 0.5–0.99 之间');
  const jevHost = input('jevHost').value.trim() || DEFAULT_SETTINGS.jevHost;
  jevEndpoint(jevHost);
  const llmInputUsdPerMillion = Number(input('llmInputUsdPerMillion').value || '0');
  const llmOutputUsdPerMillion = Number(input('llmOutputUsdPerMillion').value || '0');
  if (![llmInputUsdPerMillion, llmOutputUsdPerMillion].every(value => Number.isFinite(value) && value >= 0)) throw new Error('LLM 单价须为非负数');
  const result: Settings = {
    autoSkip: input('autoSkip').checked,
    cacheAnalysis: input('cacheAnalysis').checked,
    jevHost,
    jevKey: input('jevKey').value.trim(),
    jevModel: input('jevModel').value.trim() || 'jev-latest',
    jevThreshold: threshold,
    llmEnabled: input('llmEnabled').checked,
    llmUrl: input('llmUrl').value.trim(),
    llmKey: input('llmKey').value.trim(),
    llmModel: input('llmModel').value.trim(),
    llmInputUsdPerMillion,
    llmOutputUsdPerMillion,
  };
  if (result.llmEnabled && (!result.llmUrl || !result.llmModel)) throw new Error('启用 LLM 时需填写接口地址和模型');
  return result;
}

async function ensureApiPermissions(settingsToUse: Settings): Promise<void> {
  const origins: string[] = [];
  const endpoint = new URL(jevEndpoint(settingsToUse.jevHost));
  if (endpoint.origin !== 'https://api.typesafe.ai') origins.push(`${endpoint.origin}/*`);
  if (settingsToUse.llmEnabled) {
    const url = new URL(settingsToUse.llmUrl);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
      throw new Error('LLM 接口须使用 HTTPS，或本机 HTTP');
    }
    origins.push(`${url.origin}/*`);
  }
  if (!origins.length) return;
  const allowed = await chrome.permissions.request({ origins: [...new Set(origins)] });
  if (!allowed) throw new Error('需要允许访问所填写的 API Host，才能连接接口');
}

async function saveToggles(): Promise<void> {
  settings = {
    ...settings,
    autoSkip: input('autoSkip').checked,
    cacheAnalysis: input('cacheAnalysis').checked,
  };
  await chrome.storage.local.set({ settings });
}

function renderCurrent(): void {
  const status = element('videoStatus');
  const up = element('currentUp');
  const ranges = element('ranges');
  const elapsed = element('elapsed');
  const button = document.getElementById('toggleCurrentUp') as HTMLButtonElement;
  const copyButton = document.getElementById('copyCc') as HTMLButtonElement;
  ranges.replaceChildren();
  if (!current?.video) {
    status.textContent = current?.status || '打开 B 站视频后显示检测状态。';
    up.textContent = '当前不是可检测的 B 站视频';
    ranges.textContent = '—'; elapsed.textContent = '—'; button.disabled = true; copyButton.disabled = true;
    return;
  }
  status.textContent = `${current.statusKind === 'success' || current.statusKind === 'cached' ? '✓ ' : ''}${current.status}${current.cacheHit ? '（缓存）' : ''}`;
  up.textContent = `${current.video.owner.name} · UID ${current.video.owner.mid}\n${current.listed ? '已在白名单' : '未在白名单'}`;
  button.disabled = !current.video.owner.mid;
  copyButton.disabled = !current.ccCount;
  copyButton.textContent = current.ccCount ? `复制当前 CC 字幕（${current.ccCount} 条）` : '当前视频无可用 CC 字幕';
  button.textContent = current.listed ? '移出白名单' : '加入白名单';
  if (current.segments.length) {
    for (const segment of current.segments) {
      const line = document.createElement('div');
      line.textContent = `${formatTime(segment.start)}–${formatTime(segment.end)} · ${segment.source.toUpperCase()}`;
      ranges.append(line);
    }
  } else ranges.textContent = '暂无';
  elapsed.textContent = current.analysisMs === null ? '—' : formatElapsed(current.analysisMs);
}

function renderWhitelist(): void {
  element('upCount').textContent = String(whitelist.length);
  const list = element('upList'); list.replaceChildren();
  if (!whitelist.length) { const empty = document.createElement('li'); empty.textContent = '白名单为空'; list.append(empty); return; }
  for (const up of whitelist) {
    const row = document.createElement('li');
    const label = document.createElement('span'); label.textContent = `${up.name} · ${up.mid}`;
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '移出';
    remove.onclick = () => void setWhitelist(whitelist.filter(item => item.mid !== up.mid));
    row.append(label, remove); list.append(row);
  }
}

async function setWhitelist(list: Up[]): Promise<void> {
  whitelist = normalizeWhitelist(list);
  await chrome.storage.local.set({ upWhitelist: whitelist });
  renderWhitelist();
  await refreshState();
}

function parseMid(value: string): number {
  const trimmed = value.trim();
  const match = trimmed.match(/^(?:https?:\/\/space\.bilibili\.com\/)?(\d+)(?:\/.*)?$/i);
  const mid = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(mid) || mid <= 0) throw new Error('请输入有效的 UP UID 或 B 站空间链接');
  return mid;
}

async function refreshState(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('未找到当前标签页');
    current = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_STATE' }) as PageState;
  } catch { current = null; }
  renderCurrent();
}

void chrome.storage.local.get(['settings', 'upWhitelist']).then(stored => {
  settings = { ...DEFAULT_SETTINGS, ...(stored.settings ?? {}) };
  whitelist = normalizeWhitelist(stored.upWhitelist);
  fillSettings(); renderWhitelist();
});
void refreshState();
setInterval(() => void refreshState(), 1200);

for (const id of ['autoSkip', 'cacheAnalysis'] as const) input(id).addEventListener('change', () => void saveToggles());

document.getElementById('clearAnalysisCache')!.addEventListener('click', () => {
  void (async () => {
    const button = document.getElementById('clearAnalysisCache') as HTMLButtonElement;
    button.disabled = true;
    try {
      const stored = await chrome.storage.local.get(null);
      const keys = analysisCacheKeys(Object.keys(stored));
      await chrome.storage.local.set({ analysisCacheEpoch: Date.now() });
      if (keys.length) await chrome.storage.local.remove(keys);
      element('cacheStatus').textContent = `已清除 ${keys.length} 条广告判定缓存。再次打开视频或点“重新判断”即可检测。`;
    } catch (error) {
      element('cacheStatus').textContent = `清除失败：${error instanceof Error ? error.message : String(error)}`;
    } finally {
      button.disabled = false;
    }
  })();
});

document.getElementById('copyCc')!.addEventListener('click', () => {
  void (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('未找到当前视频标签页');
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CC_TEXT' }) as { text?: string; count?: number; error?: string };
    if (!result.text) throw new Error(result.error || '当前视频没有可用 CC 字幕');
    await copyTextToClipboard(result.text);
    element('copyStatus').textContent = `已复制 ${result.count ?? current?.ccCount ?? 0} 条 CC 字幕（含时间戳）。`;
  })().catch(error => { element('copyStatus').textContent = error instanceof Error ? error.message : String(error); });
});

document.getElementById('toggleCurrentUp')!.addEventListener('click', () => {
  if (!current?.video?.owner.mid) return;
  const owner = current.video.owner;
  void setWhitelist(current.listed ? whitelist.filter(up => up.mid !== owner.mid) : [...whitelist, owner]);
});

document.getElementById('addUp')!.addEventListener('click', () => {
  try {
    const mid = parseMid(input('upMid').value);
    const name = input('upName').value.trim() || `UP ${mid}`;
    void setWhitelist([...whitelist, { mid, name }]);
    input('upMid').value = ''; input('upName').value = '';
    showMessage('已加入白名单', true);
  } catch (error) { showMessage(error instanceof Error ? error.message : String(error)); }
});

document.getElementById('settings')!.addEventListener('submit', event => {
  event.preventDefault();
  void (async () => {
    const next = readSettings();
    await ensureApiPermissions(next);
    await chrome.storage.local.set({ settings: next });
    settings = next;
    showMessage('API 设置已保存到本机', true);
  })().catch(error => showMessage(error instanceof Error ? error.message : String(error)));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.upWhitelist) { whitelist = normalizeWhitelist(changes.upWhitelist.newValue); renderWhitelist(); void refreshState(); }
  if (changes.settings) {
    settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue ?? {}) };
    for (const id of ['autoSkip', 'cacheAnalysis'] as const) input(id).checked = settings[id];
  }
});
