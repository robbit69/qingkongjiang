import { afterEach, describe, expect, it, vi } from 'vitest';
import { getVideoCaptions } from '../src/bilibili';

afterEach(() => vi.unstubAllGlobals());

describe('B 站 CC 字幕获取', () => {
  it('选择正确分 P 和中文字幕轨，并读取时间戳', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { title: '测试视频', duration: 600, owner: { mid: 123, name: '测试 UP' }, pages: [{ page: 1, cid: 11 }, { page: 2, cid: 22, duration: 350 }] } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { subtitle: { subtitles: [
        { lan: 'en', subtitle_url: '//aisubtitle.hdslb.com/en.json' },
        { lan: 'zh-CN', subtitle_url: '//aisubtitle.hdslb.com/zh.json' },
      ] } } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ body: [{ from: 12.5, to: 14.3, content: '广告来了' }] })));
    vi.stubGlobal('fetch', fetchMock);
    expect(await getVideoCaptions('BV1wD4y1R7tX', 2)).toEqual({
      bvid: 'BV1wD4y1R7tX', cid: 22, title: '测试视频', duration: 350, owner: { mid: 123, name: '测试 UP' }, track: 'zh-CN',
      cues: [{ from: 12.5, to: 14.3, content: '广告来了' }],
    });
    expect(fetchMock.mock.calls[1][0]).toContain('cid=22');
    expect(fetchMock.mock.calls[2][0]).toBe('https://aisubtitle.hdslb.com/zh.json');
  });

  it('拒绝站外字幕 URL', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { title: '视频', pages: [{ page: 1, cid: 11 }] } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { subtitle: { subtitles: [{ subtitle_url: 'https://evil.example/track.json' }] } } }))));
    await expect(getVideoCaptions('BV1wD4y1R7tX', 1)).rejects.toThrow('字幕地址不在 B 站域名下');
  });
});
