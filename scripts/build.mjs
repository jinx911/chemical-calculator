import { copyFile, mkdir, rm } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const target = new URL('dist/', root);
const publishedFiles = [
  'index.html', 'formulas.html', 'styles.css', 'print.css',
  'src/app.mjs', 'src/model.mjs', 'src/hydraulics.mjs', 'src/presentation.mjs',
  'src/formulas.mjs', 'src/formula-page.mjs', 'src/formula-dock.mjs', 'src/storage.mjs', 'src/project-file.mjs', 'src/report.mjs',
];

await rm(target, { recursive: true, force: true });
await mkdir(new URL('src/', target), { recursive: true });
for (const file of publishedFiles) {
  await copyFile(new URL(file, root), new URL(file, target));
}
console.log('GitHub Pages: 已生成 ' + publishedFiles.length + ' 个静态文件。');
