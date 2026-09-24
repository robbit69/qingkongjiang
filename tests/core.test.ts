import { describe, expect, it } from 'vitest';
import { analysisCacheKeys, cacheKey, captionsAsText, formatElapsed, isAnalysisCacheReusable, isAutoSkippable, isSeekBackIntoSkipped, makeWindows, mergeSegments, moveSegmentBoundary, nearestCueIndex, normalizeCues, normalizeWhitelist, segmentFromIds, segmentKey, shouldDetectUp } from '../src/core';

describe('字幕与时间区间', () => {
  it('过滤坏字幕并保留时间顺序', () => {
    expect(normalizeCues([
      { from: 10, to: 12, content: '第二句' },
      { from: 2, to: 3, content: ' 第一句 ' },
      { from: 4, to: 4, content: '无效' },
    ])).toEqual([
      { from: 2, to: 3, content: '第一句' },
      { from: 10, to: 12, content: '第二句' },
    ]);
  });

  it('复制 CC 文本保留毫秒时间戳和字幕内容', () => {
    expect(captionsAsText([{ from: 62.125, to: 63.5, content: '第一句' }]))
      .toBe('[00:01:02.125–00:01:03.500] 第一句');
  });

  it('窗口重叠且字幕编号稳定，可准确映射边界', () => {
    const cues = Array.from({ length: 10 }, (_, i) => ({ from: i * 2, to: i * 2 + 1, content: `字幕${i}` }));
    const windows = makeWindows(cues, 4, 1);
    expect(windows.map(w => w.lines.map(l => l.id))).toEqual([
      ['L00000', 'L00001', 'L00002', 'L00003'],
      ['L00003', 'L00004', 'L00005', 'L00006'],
      ['L00006', 'L00007', 'L00008', 'L00009'],
    ]);
    expect(segmentFromIds(windows[1].lines, 'L00004', 'L00006', 'jev', 0.91)).toEqual({ start: 8, end: 13, source: 'jev', confidence: 0.91 });
    expect(segmentFromIds(windows[1].lines, 'L00006', 'L00004', 'jev')).toBeNull();
  });

  it('合并重叠的同来源区间，不覆盖不同来源', () => {
    expect(mergeSegments([
      { start: 10, end: 20, source: 'jev', confidence: 0.9 },
      { start: 18, end: 25, source: 'jev', confidence: 0.8 },
      { start: 30, end: 35, source: 'manual', confirmed: true },
    ])).toEqual([
      { start: 10, end: 25, source: 'jev', confidence: 0.8 },
      { start: 30, end: 35, source: 'manual', confirmed: true },
    ]);
  });

  it('字幕变化使缓存键变化', () => {
    const cues = [{ from: 1, to: 2, content: '原字幕' }];
    expect(cacheKey('BV123', 1, cues)).toMatch(/^analysis:v3:/);
    expect(cacheKey('BV123', 1, cues)).not.toBe(cacheKey('BV123', 1, [{ ...cues[0], content: '改字幕' }]));
  });

  it('清理时只选广告判定缓存，保留手动区间和检测记录', () => {
    expect(analysisCacheKeys(['analysis:v2:a', 'analysis:v3:b', 'manual:a', 'detectionHistory', 'settings']))
      .toEqual(['analysis:v2:a', 'analysis:v3:b']);
  });

  it('按字幕句调整边界并阻止起点超过终点', () => {
    const cues = [
      { from: 1, to: 2, content: '前句' },
      { from: 2, to: 3, content: '口播开始' },
      { from: 3, to: 4, content: '口播结束' },
      { from: 4, to: 5, content: '后句' },
    ];
    const segment = { start: 2.1, end: 4, source: 'jev' as const, confidence: 0.9 };
    expect(nearestCueIndex(cues, 2.1, 'start')).toBe(1);
    expect(moveSegmentBoundary(segment, cues, 'start', -1)).toEqual({ start: 1, end: 4, source: 'manual', confirmed: true });
    expect(moveSegmentBoundary(segment, cues, 'end', 1)).toEqual({ start: 2.1, end: 5, source: 'manual', confirmed: true });
    expect(moveSegmentBoundary({ ...segment, start: 3.5 }, cues, 'end', -1)).toBeNull();
  });

  it('UP 名单状态变化后旧分析缓存失效', () => {
    const now = 1000000;
    expect(isAnalysisCacheReusable(now - 1000, 0, now)).toBe(true);
    expect(isAnalysisCacheReusable(now - 1000, now - 500, now)).toBe(false);
    expect(isAnalysisCacheReusable(now - 400, now - 500, now)).toBe(true);
  });

  it('自动跳过只允许手动确认或高置信度 Jev 区间', () => {
    expect(isAutoSkippable({ start: 1, end: 2, source: 'jev', confidence: 0.9, boundaryConfidence: 0.7 }, 0.8)).toBe(true);
    expect(isAutoSkippable({ start: 1, end: 2, source: 'jev', confidence: 0.9, boundaryConfidence: 0.4 }, 0.8)).toBe(false);
    expect(isAutoSkippable({ start: 1, end: 2, source: 'jev', confidence: 0.7 }, 0.8)).toBe(false);
    expect(isAutoSkippable({ start: 1, end: 2, source: 'llm' }, 0.8)).toBe(false);
    expect(isAutoSkippable({ start: 1, end: 2, source: 'manual', confirmed: true }, 0.8)).toBe(true);
  });

  it('耗时自动换算单位', () => {
    expect(formatElapsed(824)).toBe('824 ms');
    expect(formatElapsed(2145)).toBe('2 秒 145 ms');
    expect(formatElapsed(65142)).toBe('1 分 5 秒 142 ms');
  });

  it('白名单内 UP 免检测且名单去重', () => {
    const list = normalizeWhitelist([{ mid: 12, name: '甲' }, { mid: 12, name: '重复' }, { mid: -1 }]);
    expect(list).toEqual([{ mid: 12, name: '甲' }]);
    expect(shouldDetectUp(12, list)).toBe(false);
    expect(shouldDetectUp(13, list)).toBe(true);
  });

  it('跳过后手动切回该区间会被识别', () => {
    const segment = { start: 20, end: 30, source: 'jev' as const };
    const skipped = new Set([segmentKey(segment)]);
    expect(isSeekBackIntoSkipped(segment, 25, skipped)).toBe(true);
    expect(isSeekBackIntoSkipped(segment, 30, skipped)).toBe(false);
    expect(isSeekBackIntoSkipped(segment, 25, new Set())).toBe(false);
  });
});
