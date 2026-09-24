import { analyzeStage, refineBoundaries, testConnections } from './analysis';
import { getVideoCaptions, getVideoInfo } from './bilibili';
import { DEFAULT_SETTINGS, type Settings, type Window } from './core';

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;
  const type = (message as { type?: string }).type;
  if (type === 'TEST_CONNECTIONS') {
    if (!sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`)) return false;
    const provided = (message as { settings?: Partial<Settings> }).settings;
    const settings: Settings = { ...DEFAULT_SETTINGS, ...(provided ?? {}) };
    void testConnections(settings).then(sendResponse).catch(error => sendResponse({ error: String(error) }));
    return true;
  }
  if (type !== 'ANALYZE_STAGE' && type !== 'REFINE_BOUNDARIES' && type !== 'GET_CAPTIONS' && type !== 'GET_VIDEO_CONTEXT') return false;
  const senderUrl = sender.url ? new URL(sender.url) : null;
  if (senderUrl?.hostname !== 'www.bilibili.com') {
    sendResponse({ error: '只接受 B 站页面的请求' });
    return false;
  }
  if (type === 'GET_CAPTIONS' || type === 'GET_VIDEO_CONTEXT') {
    const { bvid, page } = message as { bvid?: unknown; page?: unknown };
    if (typeof bvid !== 'string' || !/^BV[0-9A-Za-z]{10}$/i.test(bvid) || !Number.isInteger(page) || Number(page) < 1 || Number(page) > 1000) {
      sendResponse({ error: '视频编号或分 P 无效' });
      return false;
    }
    void (async () => {
      const info = await getVideoInfo(bvid, Number(page));
      try {
        const captions = await getVideoCaptions(bvid, Number(page), info);
        return type === 'GET_CAPTIONS' ? { captions } : { video: captions };
      } catch (error) {
        if (type === 'GET_CAPTIONS') throw error;
        return { video: info, error: error instanceof Error ? error.message : String(error) };
      }
    })()
      .then(sendResponse)
      .catch(error => sendResponse({ error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  const window = (message as { window?: Window }).window;
  if (!window || !Array.isArray(window.lines) || window.lines.length > 254 || window.lines.length === 0 ||
    !window.lines.every(line => typeof line.id === 'string' && /^L\d{5}$/.test(line.id) && typeof line.content === 'string' && line.content.length <= 1000 && Number.isFinite(line.from) && Number.isFinite(line.to) && line.to > line.from)) {
    sendResponse({ segments: [], warning: '字幕窗口无效' });
    return false;
  }
  void (async () => {
    const stored = await chrome.storage.local.get('settings');
    const settings: Settings = { ...DEFAULT_SETTINGS, ...(stored.settings ?? {}) };
    return type === 'ANALYZE_STAGE' ? analyzeStage(window, settings) : refineBoundaries(window, settings);
  })().then(sendResponse).catch(error => sendResponse({ segments: [], warning: String(error) }));
  return true;
});
