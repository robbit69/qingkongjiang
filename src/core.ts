export type Cue = { from: number; to: number; content: string };
export type Line = Cue & { id: string };
export type Window = { lines: Line[]; index: number };
export type Segment = {
  start: number;
  end: number;
  source: 'jev' | 'llm' | 'manual';
  confidence?: number;
  boundaryConfidence?: number;
  confirmed?: boolean;
};
export type Settings = {
  cacheAnalysis: boolean;
  jevHost: string;
  jevKey: string;
  jevModel: string;
  jevThreshold: number;
  llmEnabled: boolean;
  llmUrl: string;
  llmKey: string;
  llmModel: string;
  llmInputUsdPerMillion: number;
  llmOutputUsdPerMillion: number;
  autoSkip: boolean;
};
export const DEFAULT_SETTINGS: Settings = {
  cacheAnalysis: true,
  jevHost: 'https://api.typesafe.ai',
  jevKey: '',
  jevModel: 'jev-latest',
  jevThreshold: 0.8,
  llmEnabled: false,
  llmUrl: 'https://api.openai.com/v1/chat/completions',
  llmKey: '',
  llmModel: '',
  llmInputUsdPerMillion: 0,
  llmOutputUsdPerMillion: 0,
  autoSkip: false,
};

export type ApiCall = {
  provider: 'jev' | 'llm';
  model: string;
  elapsedMs: number;
  attempts: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  failed: boolean;
};

export type DetectionRecord = {
  id: string;
  at: number;
  bvid: string;
  title: string;
  cueCount: number;
  windowCount: number;
  elapsedMs: number;
  segmentCount: number;
  status: 'success' | 'partial' | 'interrupted';
  calls: ApiCall[];
};

export type CallSummary = { inputTokens: number; outputTokens: number; costUsd: number; missingUsage: boolean; missingCost: boolean; attempts: number };

export function summarizeCalls(calls: ApiCall[]): CallSummary {
  return calls.reduce<CallSummary>((sum, call) => ({
    inputTokens: sum.inputTokens + (call.inputTokens ?? 0),
    outputTokens: sum.outputTokens + (call.outputTokens ?? 0),
    costUsd: sum.costUsd + (call.costUsd ?? 0),
    missingUsage: sum.missingUsage || (call.attempts > 0 && (call.inputTokens === null || call.outputTokens === null)),
    missingCost: sum.missingCost || (call.attempts > 0 && call.costUsd === null),
    attempts: sum.attempts + call.attempts,
  }), { inputTokens: 0, outputTokens: 0, costUsd: 0, missingUsage: false, missingCost: false, attempts: 0 });
}

export function formatUsd(amount: number): string {
  if (amount === 0) return '$0';
  return `$${amount.toFixed(amount < 0.01 ? 6 : 4)}`;
}

export type Up = { mid: number; name: string };

export function normalizeWhitelist(input: unknown): Up[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<number>();
  return input.flatMap((entry): Up[] => {
    if (!entry || typeof entry !== 'object') return [];
    const value = entry as Record<string, unknown>;
    const mid = Number(value.mid);
    if (!Number.isSafeInteger(mid) || mid <= 0 || seen.has(mid)) return [];
    seen.add(mid);
    return [{ mid, name: typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 80) : `UP ${mid}` }];
  });
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  if (total < 1000) return `${total} ms`;
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const remainder = total % 1000;
  return `${minutes ? `${minutes} 分 ` : ''}${seconds} 秒 ${remainder} ms`;
}

export function captionsAsText(cues: Cue[]): string {
  const timestamp = (seconds: number): string => {
    const millis = Math.round(seconds * 1000);
    const hours = Math.floor(millis / 3600000);
    const minutes = Math.floor(millis % 3600000 / 60000);
    const remaining = Math.floor(millis % 60000 / 1000);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}.${String(millis % 1000).padStart(3, '0')}`;
  };
  return cues.map(cue => `[${timestamp(cue.from)}–${timestamp(cue.to)}] ${cue.content}`).join('\n');
}

export function segmentKey(segment: Segment): string {
  return `${segment.start.toFixed(2)}:${segment.end.toFixed(2)}`;
}

export function isSeekBackIntoSkipped(segment: Segment, targetTime: number, skipped: ReadonlySet<string>): boolean {
  return skipped.has(segmentKey(segment)) && targetTime >= segment.start && targetTime < segment.end;
}

export function shouldDetectUp(mid: number, whitelist: Up[]): boolean {
  return !whitelist.some(up => up.mid === mid);
}

export function isAnalysisCacheReusable(savedAt: number, invalidatedAt: number, now: number): boolean {
  return Number.isFinite(savedAt) && savedAt > invalidatedAt && now >= savedAt && now - savedAt < 30 * 86400000;
}

export function normalizeCues(input: unknown): Cue[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((raw): Cue[] => {
    if (!raw || typeof raw !== 'object') return [];
    const value = raw as Record<string, unknown>;
    const from = Number(value.from);
    const to = Number(value.to);
    const content = typeof value.content === 'string' ? value.content.trim() : '';
    return Number.isFinite(from) && Number.isFinite(to) && from >= 0 && to > from && content
      ? [{ from, to, content }]
      : [];
  }).sort((a, b) => a.from - b.from);
}

export function makeWindows(cues: Cue[], size = 64, overlap = 12): Window[] {
  if (!Number.isInteger(size) || !Number.isInteger(overlap) || size < 2 || overlap < 0 || overlap >= size) {
    throw new Error('字幕窗口参数无效');
  }
  const lines: Line[] = cues.map((cue, i) => ({ ...cue, id: `L${String(i).padStart(5, '0')}` }));
  const windows: Window[] = [];
  for (let start = 0; start < lines.length; start += size - overlap) {
    windows.push({ lines: lines.slice(start, start + size), index: windows.length });
    if (start + size >= lines.length) break;
  }
  return windows;
}

export function linesAsText(lines: Line[]): string {
  return lines.map(line => `${line.id} [${line.from.toFixed(2)}-${line.to.toFixed(2)}] ${line.content}`).join('\n');
}

export function segmentFromIds(lines: Line[], first: string, last: string, source: Segment['source'], confidence?: number): Segment | null {
  const startLine = lines.find(line => line.id === first);
  const endLine = lines.find(line => line.id === last);
  if (!startLine || !endLine || endLine.to <= startLine.from) return null;
  return { start: startLine.from, end: endLine.to, source, confidence };
}

export function mergeSegments(segments: Segment[]): Segment[] {
  const sorted = segments.filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.start >= 0 && s.end > s.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Segment[] = [];
  for (const segment of sorted) {
    const previous = merged.at(-1);
    if (previous && segment.start <= previous.end + 1.5 && previous.source === segment.source && previous.confirmed === segment.confirmed) {
      previous.end = Math.max(previous.end, segment.end);
      previous.confidence = Math.min(previous.confidence ?? 1, segment.confidence ?? 1);
      if (previous.boundaryConfidence !== undefined || segment.boundaryConfidence !== undefined) {
        previous.boundaryConfidence = Math.min(previous.boundaryConfidence ?? 1, segment.boundaryConfidence ?? 1);
      }
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

export function cacheKey(bvid: string, cid: number, cues: Cue[]): string {
  // FNV-1a over cue text and times detects changed or regenerated CC tracks.
  let hash = 2166136261;
  for (const cue of cues) {
    const text = `${cue.from}/${cue.to}/${cue.content}|`;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  }
  return `analysis:v3:${bvid}:${cid}:${(hash >>> 0).toString(16)}`;
}

export function formatTime(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

export function isAutoSkippable(segment: Segment, threshold: number): boolean {
  return Boolean(segment.confirmed || (segment.source === 'jev' && (segment.confidence ?? 0) >= threshold && (segment.boundaryConfidence ?? 0) >= 0.6));
}
