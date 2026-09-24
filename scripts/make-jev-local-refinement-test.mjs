import { readFile, writeFile } from 'node:fs/promises';

const full = JSON.parse(await readFile('experiments/jev-full-transcript.json', 'utf8'));
const lines = full.state.split('\n').slice(55, 91);
const questions = {};
for (const line of lines) {
  const id = line.split(' ')[0];
  questions[`ad_${id}`] = {
    type: 'noul',
    instructions: `字幕 ${id} 这一句本身是否属于明确的口播商业推广？只判断这一句；相邻句是广告不代表这一句也是。普通剧情、转场和非商业品牌提及不算。`,
  };
}
const outputPath = 'experiments/jev-local-refinement.json';
await writeFile(outputPath, `${JSON.stringify({ model: 'jev-latest', state: lines.join('\n'), questions }, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, lines: lines.length, questions: Object.keys(questions).length }));
