import { describe, expect, it, vi } from 'vitest';
import { resolveStages } from '../src/stages';
import { isAutoSkippable, type Cue, type Window } from '../src/core';
import type { StageDecision, StageResult } from '../src/analysis';

const cues: Cue[] = Array.from({ length: 588 }, (_, i) => ({ from: i * 2, to: i * 2 + 1.5, content: `字幕 ${i}` }));
const id = (n: number) => `L${String(n).padStart(5, '0')}`;
const choice = (n: number, probability = 0.9, margin = 0.5) => ({ id: id(n), probability, margin });
function decision(start: number, end: number, changes: Partial<StageDecision> = {}): StageDecision {
  return { probability: 0.98, firstLineProbability: 0.02, lastLineProbability: 0.03,
    multipleProbability: 0.01, start: choice(start), end: choice(end), ...changes };
}
const reply = (value?: StageDecision): StageResult => ({ decision: value, segments: [], calls: [] });

describe('字幕阶段拼接', () => {
  it('588 条字幕只分 3 阶段；负例的强制选项不会产生广告', async () => {
    const analyze = vi.fn(async (window: Window) => reply(window.index === 0 ? decision(61, 80) : undefined));
    const refine = vi.fn(async () => ({ segments: [], calls: [] }));
    const result = await resolveStages(cues, analyze, refine);
    expect(analyze).toHaveBeenCalledTimes(3);
    expect(refine).not.toHaveBeenCalled();
    expect(result.segments).toEqual([{ start: 122, end: 161.5, source: 'jev', confidence: 0.98, boundaryConfidence: 0.9 }]);
    expect(isAutoSkippable(result.segments[0], 0.8)).toBe(true);
  });

  it('阶段交界处的连续口播合并，并只补问一对边界', async () => {
    const analyze = vi.fn(async (window: Window) => {
      if (window.index === 0) return reply(decision(250, 253, { lastLineProbability: 0.94, start: choice(250, 0.68), end: { id: 'NO_END', probability: 0.92, margin: 0.8 } }));
      if (window.index === 1) return reply(decision(254, 260, { firstLineProbability: 0.95, start: { id: 'NO_START', probability: 0.9, margin: 0.8 }, end: choice(260, 0.88) }));
      return reply();
    });
    const refine = vi.fn(async () => ({ segments: [{ start: 500, end: 521.5, source: 'jev' as const, boundaryConfidence: 0.72 }], calls: [] }));
    const result = await resolveStages(cues, analyze, refine);
    expect(refine).toHaveBeenCalledTimes(1);
    expect(result.segments).toEqual([{ start: 500, end: 521.5, source: 'jev', confidence: 0.98, boundaryConfidence: 0.72 }]);
  });

  it('跨阶段拼接的起止与边缘都很稳时不额外补问', async () => {
    const analyze = vi.fn(async (window: Window) => {
      if (window.index === 0) return reply(decision(250, 253, { lastLineProbability: 0.95, start: choice(250, 0.95), end: { id: 'NO_END', probability: 0.95, margin: 0.8 } }));
      if (window.index === 1) return reply(decision(254, 260, { firstLineProbability: 0.95, start: { id: 'NO_START', probability: 0.95, margin: 0.8 }, end: choice(260, 0.95) }));
      return reply();
    });
    const refine = vi.fn(async () => ({ segments: [], calls: [] }));
    const result = await resolveStages(cues, analyze, refine);
    expect(analyze).toHaveBeenCalledTimes(3);
    expect(refine).not.toHaveBeenCalled();
    expect(result.segments).toEqual([{ start: 500, end: 521.5, source: 'jev', confidence: 0.98, boundaryConfidence: 0.95 }]);
  });

  it('边界概率较低时补问；补问失败则保留待核对区间', async () => {
    const analyze = async () => reply(decision(61, 80, { end: choice(80, 0.56, 0.21) }));
    const refine = vi.fn(async () => ({ segments: [], warning: '接口失败', calls: [] }));
    const result = await resolveStages(cues.slice(0, 100), analyze, refine);
    expect(refine).toHaveBeenCalledTimes(1);
    expect(result.segments[0].boundaryConfidence).toBe(0);
    expect(isAutoSkippable(result.segments[0], 0.8)).toBe(false);
    expect(result.warnings.join(' ')).toContain('边界补问失败');
  });

  it('同阶段有多个独立口播时继续按段拆分，不逐句请求', async () => {
    const short = cues.slice(0, 80);
    const analyze = vi.fn(async (window: Window) => {
      if (window.lines.length === 80) return reply(decision(5, 60, { multipleProbability: 0.95 }));
      if (window.lines[0].id === id(0)) return reply(decision(5, 10));
      return reply(decision(50, 55));
    });
    const result = await resolveStages(short, analyze, async () => ({ segments: [] }));
    expect(analyze).toHaveBeenCalledTimes(3);
    expect(result.segments).toHaveLength(2);
    expect(result.stageCount).toBe(3);
  });
});
