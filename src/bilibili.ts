import { normalizeCues, type Cue } from './core';

type ApiEnvelope<T> = { code: number; message?: string; data?: T };

async function api<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) throw new Error(`B 站接口 HTTP ${response.status}`);
  const json = await response.json() as ApiEnvelope<T>;
  if (json.code !== 0 || !json.data) throw new Error(`B 站接口：${json.message || json.code}`);
  return json.data;
}

function subtitleUrl(raw: string): string {
  const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
  if (url.protocol !== 'https:' || !(url.hostname === 'hdslb.com' || url.hostname.endsWith('.hdslb.com') || url.hostname === 'bilibili.com' || url.hostname.endsWith('.bilibili.com'))) {
    throw new Error('字幕地址不在 B 站域名下');
  }
  return url.href;
}

export type VideoInfo = { bvid: string; cid: number; title: string; duration: number; owner: { mid: number; name: string } };
export type VideoCaptions = VideoInfo & { cues: Cue[]; track: string };

export async function getVideoInfo(bvid: string, page: number): Promise<VideoInfo> {
  const view = await api<{ title: string; duration?: number; owner?: { mid?: number; name?: string }; pages: { cid: number; page: number; duration?: number }[] }>(
    `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
  );
  const chosen = view.pages.find(p => p.page === page) ?? view.pages[0];
  if (!chosen) throw new Error('没有找到视频分 P 信息');
  return {
    bvid, cid: chosen.cid, title: view.title,
    duration: chosen.duration ?? view.duration ?? 0,
    owner: { mid: Number(view.owner?.mid) || 0, name: view.owner?.name || '未知 UP' },
  };
}

export async function getVideoCaptions(bvid: string, page: number, info?: VideoInfo): Promise<VideoCaptions> {
  const video = info ?? await getVideoInfo(bvid, page);
  const player = await api<{ subtitle?: { subtitles?: { lan?: string; lan_doc?: string; subtitle_url?: string }[] } }>(
    `https://api.bilibili.com/x/player/wbi/v2?bvid=${encodeURIComponent(bvid)}&cid=${video.cid}`,
  );
  const tracks = player.subtitle?.subtitles ?? [];
  if (!tracks.length) throw new Error('此视频没有可用的 CC 字幕；登录 B 站后可再试一次');
  const track = tracks.find(t => /zh|中文/i.test(`${t.lan ?? ''} ${t.lan_doc ?? ''}`)) ?? tracks[0];
  if (!track.subtitle_url) throw new Error('字幕轨缺少下载地址');
  const response = await fetch(subtitleUrl(track.subtitle_url), { credentials: 'include' });
  if (!response.ok) throw new Error(`获取字幕失败：HTTP ${response.status}`);
  const data = await response.json() as { body?: unknown };
  const cues = normalizeCues(data.body);
  if (!cues.length) throw new Error('字幕轨为空');
  return { ...video, cues, track: track.lan_doc ?? track.lan ?? 'CC' };
}
