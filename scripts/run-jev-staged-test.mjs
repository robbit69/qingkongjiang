import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2).length ? process.argv.slice(2) : ['1', '2', '3'];
const requestPaths = args.map(arg => /^\d+$/.test(arg) ? `experiments/jev-stage-${arg}.json` : arg);
if (requestPaths.some(path => !/^experiments\/jev-[a-z0-9-]+\.json$/.test(path))) {
  console.error('用法：node scripts/run-jev-staged-test.mjs [1|2|3|experiments/jev-*.json]...');
  process.exit(1);
}

// 通过标准输入接收 Key，不写入文件、命令参数或输出。
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
console.log('READY_FOR_KEY');
const key = await new Promise(resolve => {
  let buffer = '';
  process.stdin.on('data', chunk => {
    buffer += chunk.toString();
    const newline = buffer.indexOf('\n');
    if (newline >= 0) {
      process.stdin.pause();
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      resolve(buffer.slice(0, newline).trim());
    }
  });
});
if (!key) throw new Error('没有收到 API Key');

for (const requestPath of requestPaths) {
  const stage = requestPath.replace(/^experiments\//, '').replace(/\.json$/, '');
  const body = await readFile(requestPath, 'utf8');
  const start = performance.now();
  let response;
  try {
    response = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(90000),
    });
  } catch (error) {
    console.error(JSON.stringify({ stage, elapsedMs: Math.round(performance.now() - start), error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
    break;
  }
  const elapsedMs = Math.round(performance.now() - start);
  if (!response.ok) {
    // HTTP 错误内容可能包含服务端诊断，不输出凭据附近的数据。
    console.error(JSON.stringify({ stage, httpStatus: response.status, elapsedMs, error: 'Jev 请求未成功' }));
    process.exitCode = 1;
    break;
  }
  const result = await response.json();
  await writeFile(requestPath.replace(/\.json$/, '-response.json'), `${JSON.stringify(result, null, 2)}\n`);
  const answers = Object.fromEntries(Object.entries(result.answers ?? {}).map(([name, answer]) => {
    if (answer && typeof answer === 'object' && 'probabilities' in answer) {
      const top = Object.entries(answer.probabilities ?? {}).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 8);
      return [name, { choice: answer.choice, confidence: answer.confidence, top }];
    }
    return [name, { probability: answer?.noul }];
  }));
  console.log(JSON.stringify({ stage, httpStatus: response.status, elapsedMs, model: result.model, usage: result.usage, estimatedCostUsd: Number(result.usage?.input_tokens) * 0.042 / 1_000_000, answers }, null, 2));
}
