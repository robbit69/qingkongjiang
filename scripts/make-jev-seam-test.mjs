import { readFile, writeFile } from 'node:fs/promises';

const full = JSON.parse(await readFile('experiments/jev-full-transcript.json', 'utf8'));
const template = JSON.parse(await readFile('experiments/jev-stage-1.json', 'utf8'));
const lines = full.state.split('\n');
const slices = [[0, 70], [70, 324]];
for (const [index, [from, to]] of slices.entries()) {
  const part = lines.slice(from, to);
  const first = part[0].split(' ')[0];
  const last = part.at(-1).split(' ')[0];
  const questions = structuredClone(template.questions);
  for (const question of Object.values(questions)) {
    question.instructions = question.instructions.replaceAll('L00000', first).replaceAll('L00253', last);
  }
  questions.start.criteria = { NO_START: questions.start.criteria.NO_START, ...Object.fromEntries(part.map(line => [line.split(' ')[0], null])) };
  questions.end.criteria = { NO_END: questions.end.criteria.NO_END, ...Object.fromEntries(part.map(line => [line.split(' ')[0], null])) };
  const path = `experiments/jev-seam-${index + 1}.json`;
  await writeFile(path, `${JSON.stringify({ model: 'jev-latest', state: part.join('\n'), questions }, null, 2)}\n`);
  console.log(JSON.stringify({ path, first, last, count: part.length, options: Object.keys(questions.start.criteria).length }));
}
