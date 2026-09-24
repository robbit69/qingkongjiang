import type { AnalysisResult, StageDecision, StageResult } from './analysis';
import { makeWindows, mergeSegments, segmentFromIds, type ApiCall, type Cue, type Line, type Segment, type Window } from './core';

type Pending = { startId: string; probability: number; startScore: number; needsRefine: boolean; seam: boolean };
type Candidate = Pending & { endId: string; endScore: number };
export type StageSummary = { segments: Segment[]; warnings: string[]; calls: ApiCall[]; stageCount: number };

function lineNumber(id: string): number { return Number(id.slice(1)); }

function boundaryContext(lines: Line[], startId: string, endId: string): Window {
  const start = lineNumber(startId);
  const end = lineNumber(endId);
  const left = Math.max(0, start - 18);
  const right = Math.min(lines.length, end + 21);
  const selected = right - left <= 110
    ? lines.slice(left, right)
    : [...lines.slice(left, Math.min(lines.length, start + 22)), ...lines.slice(Math.max(0, end - 18), right)];
  return { lines: [...new Map(selected.map(line => [line.id, line])).values()], index: 0 };
}

export async function resolveStages(
  cues: Cue[],
  analyze: (window: Window) => Promise<StageResult>,
  refine: (window: Window) => Promise<AnalysisResult>,
  isCurrent: () => boolean = () => true,
  onProgress: (done: number, total: number) => void = () => {},
): Promise<StageSummary> {
  const lines: Line[] = cues.map((cue, index) => ({ ...cue, id: `L${String(index).padStart(5, '0')}` }));
  const initial = makeWindows(cues, 254, 0);
  const resolved: { window: Window; decision?: StageDecision; segments: Segment[]; warning?: string }[] = [];
  const calls: ApiCall[] = [];
  const warnings: string[] = [];
  let stageCount = 0;
  let total = initial.length;

  const inspect = async (window: Window, depth: number): Promise<void> => {
    if (!isCurrent()) throw new Error('分析已中断');
    const reply = await analyze(window);
    stageCount++;
    calls.push(...(reply.calls ?? []));
    onProgress(stageCount, total);
    if (!isCurrent()) throw new Error('分析已中断');
    if (reply.decision?.multipleProbability !== undefined && reply.decision.multipleProbability >= 0.65) {
      if (window.lines.length > 24 && depth < 5 && stageCount < 10) {
        const middle = Math.floor(window.lines.length / 2);
        total += 2;
        await inspect({ lines: window.lines.slice(0, middle), index: window.index }, depth + 1);
        await inspect({ lines: window.lines.slice(middle), index: window.index }, depth + 1);
        return;
      }
      warnings.push('同一小段内可能有多段独立口播，无法可靠确定全部边界；请手动核对');
      resolved.push({ window, segments: [] });
      return;
    }
    resolved.push({ window, decision: reply.decision, segments: reply.segments ?? [], warning: reply.warning });
    if (reply.warning) warnings.push(reply.warning);
  };
  for (const window of initial) await inspect(window, 0);

  let pending: Pending | null = null;
  const candidates: Candidate[] = [];
  const found: Segment[] = [];
  for (const item of resolved) {
    found.push(...item.segments);
    const decision = item.decision;
    if (!decision) {
      if (pending) warnings.push('跨阶段口播遇到无法判断的阶段，边界需要手动核对');
      pending = null;
      continue;
    }
    const first = item.window.lines[0].id;
    const last = item.window.lines.at(-1)!.id;
    const beginsWithAd = decision.firstLineProbability >= 0.7;
    const endsWithAd = decision.lastLineProbability >= 0.7;
    const edgeUnclear = (decision.firstLineProbability > 0.3 && !beginsWithAd) ||
      (decision.lastLineProbability > 0.3 && !endsWithAd);
    if (pending && !beginsWithAd) {
      warnings.push('相邻阶段的口播状态冲突，跨阶段区间需要手动核对');
      pending = null;
    }
    if (!pending) {
      const startId = beginsWithAd ? first : decision.start.id;
      if (startId === 'NO_START' || !item.window.lines.some(line => line.id === startId)) {
        warnings.push('Jev 未给出有效的口播起点');
        continue;
      }
      pending = {
        startId,
        probability: decision.probability,
        startScore: beginsWithAd ? decision.firstLineProbability : decision.start.probability,
        needsRefine: edgeUnclear || (!beginsWithAd && (decision.start.probability < 0.6 || decision.start.margin < 0.15)),
        seam: false,
      };
    } else {
      pending.probability = Math.min(pending.probability, decision.probability);
      pending.seam = true;
      pending.needsRefine ||= edgeUnclear;
    }
    if (endsWithAd) continue;
    const endId = decision.end.id;
    if (endId === 'NO_END' || !item.window.lines.some(line => line.id === endId)) {
      warnings.push('Jev 未给出有效的口播终点');
      pending = null;
      continue;
    }
    candidates.push({ ...pending, endId, endScore: decision.end.probability,
      needsRefine: pending.needsRefine || decision.end.probability < 0.6 || decision.end.margin < 0.15 });
    pending = null;
  }
  if (pending) {
    candidates.push({ ...pending, endId: lines.at(-1)!.id, endScore: 0, needsRefine: true });
  }

  for (const candidate of candidates) {
    if (!isCurrent()) throw new Error('分析已中断');
    const original = segmentFromIds(lines, candidate.startId, candidate.endId, 'jev', candidate.probability);
    if (!original) { warnings.push('Jev 给出的口播起止顺序无效'); continue; }
    original.boundaryConfidence = Math.min(candidate.startScore, candidate.endScore);
    if (candidate.needsRefine || candidate.seam) {
      const reply = await refine(boundaryContext(lines, candidate.startId, candidate.endId));
      calls.push(...(reply.calls ?? []));
      const refined = reply.segments[0];
      const refinedStart = refined ? lines.findIndex(line => line.from === refined.start) : -1;
      const refinedEnd = refined ? lines.findIndex(line => line.to === refined.end) : -1;
      const nearExpected = refinedStart >= 0 && refinedEnd >= 0 &&
        Math.abs(refinedStart - lineNumber(candidate.startId)) <= 20 &&
        Math.abs(refinedEnd - lineNumber(candidate.endId)) <= 20;
      if (refined && nearExpected && refined.source === 'jev' && (refined.boundaryConfidence ?? 0) >= 0.6) {
        found.push({ ...refined, confidence: candidate.probability });
        continue;
      }
      original.boundaryConfidence = 0;
      warnings.push(reply.warning ? `边界补问失败：${reply.warning}` : '边界补问仍不确定，需手动核对');
    }
    found.push(original);
  }
  return { segments: mergeSegments(found), warnings, calls, stageCount };
}
