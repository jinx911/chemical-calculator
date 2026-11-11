import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const prefix = '/chemical-calculator/';
const types = { html: 'text/html', mjs: 'text/javascript', css: 'text/css', json: 'application/json' };

async function preview() {
  const root = resolve('dist');
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    const relative = pathname.slice(prefix.length) || 'index.html';
    const file = resolve(root, relative);
    try {
      if (!pathname.startsWith(prefix) || !file.startsWith(root + sep)) throw new Error();
      const content = await readFile(file);
      response.writeHead(200, { 'content-type': (types[file.split('.').at(-1)] ?? 'text/plain') + '; charset=utf-8' });
      response.end(content);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((ready, reject) => server.once('error', reject).listen(0, '127.0.0.1', ready));
  return { server, url: 'http://127.0.0.1:' + server.address().port + prefix };
}

async function expectRows(page, expected) {
  const rows = page.locator('#results tbody tr');
  await rows.nth(expected.length - 1).waitFor();
  assert.equal(await rows.count(), expected.length);
  const column = await page.getByRole('columnheader', { name: '阻力压降（kPa）', exact: true })
    .evaluate(cell => cell.cellIndex);
  for (const [scenario, candidate, pressure, status] of expected) {
    const row = rows.filter({ hasText: scenario }).filter({ hasText: candidate });
    assert.equal(await row.count(), 1);
    assert(Math.abs(Number(await row.locator('td').nth(column).innerText()) - pressure) < 0.006);
    assert.match(await row.innerText(), status);
  }
}

async function checkVersions(page) {
  const initial = [
    ['正常工况', '102.3 mm', 14.34, /满足/], ['正常工况', '128.2 mm', 5, /满足/],
    ['最大工况', '102.3 mm', 31.05, /满足/], ['最大工况', '128.2 mm', 10.79, /满足/],
  ];
  await page.locator('#open-example').click();
  await expectRows(page, initial);
  const limit = page.getByLabel('阻力压降上限（kPa）', { exact: true });
  assert.equal(await limit.inputValue(), '35');
  await limit.fill('28');
  assert.match(await page.locator('.summary-card.fail').innerText(), /最大工况 压降超限/);
  await page.getByRole('button', { name: '恢复项目上限' }).click();
  assert.equal(await limit.inputValue(), '35');
  await expectRows(page, initial);
  await page.locator('#results tbody tr').first().getByRole('button', { name: '查看计算依据' }).click();
  assert.match(await page.locator('#formula-detail').innerText(), /摩阻因子.*|沿程损失/);

  const flows = page.locator('input[data-path^="scenarios."][data-path$=".flow"]');
  const normal = flows.first();
  const unit = page.locator('select[data-path^="scenarios."][data-path$=".flowUnit"]').first();
  await unit.selectOption('L/s');
  assert(Math.abs(Number(await normal.inputValue()) - 8.3333333333) < 1e-8);
  await expectRows(page, initial);
  await unit.selectOption('m³/h');
  await normal.fill('30');
  await normal.blur();
  await page.locator('#save-version').click();
  await page.locator('#version-to option[value="1"]').waitFor({ state: 'attached' });

  const max = flows.nth(1);
  await max.fill('55');
  await max.blur();
  await expectRows(page, [
    ...initial.slice(0, 2), ['最大工况', '102.3 mm', 45.64, /超限/], ['最大工况', '128.2 mm', 15.82, /满足/],
  ]);
  assert.match(await page.locator('.summary-card.fail').innerText(), /最大工况 压降超限/);
  await page.locator('#save-version').click();
  await page.locator('#version-to option[value="2"]').waitFor({ state: 'attached' });
  const changes = page.locator('#version-diff tbody tr');
  assert.match(await changes.filter({ hasText: '流量数值' }).innerText(), /45\s+55/);
  assert.match(await changes.filter({ hasText: '内径 102.3 mm · 组合校核' }).innerText(), /满足\s+超限/);
  await page.reload();
  await page.locator('#version-to option[value="2"]').waitFor({ state: 'attached' });
  assert.equal(await flows.nth(1).inputValue(), '55');
  assert.match(await page.locator('#results').innerText(), /45\.64/);
}

async function checkReport(page, directory, version) {
  await page.locator('#version-to').selectOption(String(version));
  await page.evaluate(() => { window.printRequested = false; });
  await page.locator('#print-version').click();
  await page.waitForFunction(() => window.printRequested === true);
  const report = await page.locator('#report').textContent();
  assert.match(report, /管径比选与压降计算书/);
  assert.match(report, new RegExp('版本\\s*' + version));
  assert.match(report, version === 1 ? /31\.05/ : /45\.64/);
  assert.match(report, /公式与代入/);
  assert.equal(report.includes('超限'), version === 2);
  await page.emulateMedia({ media: 'print' });
  assert(await page.locator('#report').isVisible(), 'print styles must display the report');
  const pdf = await page.pdf({
    preferCSSPageSize: true,
    path: directory ? resolve(directory, 'cooling-water-v' + version + '.pdf') : undefined,
  });
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert(pdf.length > 8000, 'the PDF should include the full calculation');
  await page.emulateMedia({ media: 'screen' });
}

async function checkBackup(browser, page, url) {
  const downloadReady = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载项目文件' }).click();
  const downloaded = await downloadReady;
  const file = await readFile(await downloaded.path());
  const data = JSON.parse(file);
  assert.equal(data.revisions.length, 2);
  const other = await browser.newPage({ viewport: { width: 390, height: 844 } });
  other.setDefaultTimeout(10000);
  await other.goto(url);
  const openFile = other.getByRole('button', { name: '打开项目文件' });
  await openFile.waitFor();
  assert.doesNotMatch(await other.locator('body').innerText(), /JSON/i);
  await other.locator('#import-project').setInputFiles({
    name: '循环冷却水改造.json', mimeType: 'application/json', buffer: file,
  });
  await other.locator('#results').waitFor();
  const results = await other.locator('#results').innerText();
  assert.match(results, /45\.64/);
  assert.equal(await other.locator('#results tbody tr').count(), 4);
  const fitsMobile = await other.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  assert(fitsMobile, 'the page must not scroll horizontally on a phone');
  await other.locator('#import-project').setInputFiles({
    name: '循环冷却水改造.json', mimeType: 'application/json', buffer: Buffer.from('{'),
  });
  await other.locator('#notice').filter({ hasText: '打不开这个项目文件' }).waitFor();
  assert.match(await other.locator('#results').innerText(), /45\.64/);
  await other.close();
}

function worksheetField(page, group, key, index = 0) {
  return page.locator(`input[data-path^="${group}."][data-path$=".${key}"]:visible`).nth(index);
}

async function fillWorksheet(page, group, index, values) {
  for (const [key, value] of Object.entries(values)) {
    await worksheetField(page, group, key, index).fill(value);
  }
}

async function checkStart(page, directory) {
  await page.getByRole('button', { name: '开始管径比选' }).click();
  await page.getByLabel('项目名称').fill('冷却水泵房改造');
  await page.getByLabel('管线编号或名称（可选）').fill('循环水至冷却器供水支线');
  await page.getByRole('button', { name: '填写计算条件' }).click();
  const flow = page.getByLabel('体积流量', { exact: true });
  await flow.waitFor();
  assert(await flow.evaluate(input => input === document.activeElement));
  assert.match(await page.locator('#results').innerText(), /这里会显示比选结果/);
  assert(await page.locator('#save-version').isDisabled());
  await fillWorksheet(page, 'scenarios', 0, { name: '正常工况', flow: '30', density: '997', viscosity: '0.89', source: '循环水设计条件表' });
  await page.getByRole('button', { name: '＋ 添加工况' }).click();
  for (const [field, value] of Object.entries({ density: '997', viscosity: '0.89', source: '循环水设计条件表', flow: '' })) {
    assert.equal(await worksheetField(page, 'scenarios', field, 1).inputValue(), value);
  }
  await fillWorksheet(page, 'scenarios', 1, { name: '最大工况', flow: '55' });
  await fillWorksheet(page, 'options', 0, {
    diameter: '102.3', length: '120', roughness: '0.045', elevation: '4', k: '4.8', kSource: '冷却器供水支线管件表',
  });
  await page.getByRole('button', { name: '＋ 添加候选管径' }).click();
  for (const [field, value] of Object.entries({ length: '120', roughness: '0.045', elevation: '4', diameter: '', k: '' })) {
    assert.equal(await worksheetField(page, 'options', field, 1).inputValue(), value);
  }
  await fillWorksheet(page, 'options', 1, { diameter: '128.2', k: '5.4', kSource: '扩径方案管件表' });
  await page.getByLabel('流速上限（m/s）', { exact: true }).fill('2');
  await page.getByLabel('阻力压降上限（kPa）', { exact: true }).fill('35');
  await expectRows(page, [
    ['正常工况', '102.3 mm', 14.34, /满足/], ['正常工况', '128.2 mm', 5, /满足/],
    ['最大工况', '102.3 mm', 45.64, /压降超限/], ['最大工况', '128.2 mm', 15.82, /满足/],
  ]);
  await page.getByLabel('液体介质').fill('循环冷却水');
  await page.getByLabel('入口位置').fill('循环水泵房供水总管');
  await page.getByLabel('出口位置').fill('冷却器入口');
  await page.getByRole('button', { name: '选用 内径 128.2 mm', exact: true }).click();
  const reason = page.getByLabel('选型理由');
  assert(await reason.evaluate(input => input === document.activeElement));
  await reason.fill('最大工况下流速和阻力压降均满足项目限值');
  const print = page.getByRole('button', { name: '保存并打印计算书' });
  await print.click();
  await page.waitForFunction(() => window.printRequested === true);
  const report = await page.locator('#report').textContent();
  assert.match(report, /循环水至冷却器供水支线/);
  assert.match(report, /循环水泵房供水总管 → 冷却器入口/);
  assert.match(report, /扩径方案管件表/);
  assert.match(report, /选定方案：内径 128\.2 mm/);
  assert.match(report, /最大工况下流速和阻力压降均满足项目限值/);
  await page.emulateMedia({ media: 'print' });
  const pdf = await page.pdf({ preferCSSPageSize: true, path: directory ? resolve(directory, 'engineer-handoff.pdf') : undefined });
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  await page.emulateMedia({ media: 'screen' });
  await page.evaluate(() => { window.printRequested = false; });
  await print.click();
  await page.waitForFunction(() => window.printRequested === true);
  assert.equal(await page.locator('#version-to option').count(), 1);
  await page.getByRole('button', { name: '化工工艺工作台首页' }).click();
}

async function checkFormulaMenu(page, directory) {
  const flow = page.getByLabel('体积流量', { exact: true }).last();
  await flow.fill('56');
  await page.getByRole('link', { name: '公式计算', exact: true }).click();
  const picker = page.getByLabel('你要算什么？');
  await picker.waitFor();
  assert.equal(await picker.locator('option').count(), 9);
  await page.getByRole('button', { name: '计算', exact: true }).click();
  assert.equal(await page.locator('#formula-fields [aria-invalid="true"]').count(), 2);
  await picker.selectOption('pump-power');
  await page.getByRole('button', { name: '载入算例' }).click();
  assert.match(await page.locator('#formula-result').innerText(), /泵轴功率\s+5\.33\d*\s*kW/);
  assert.match(await page.locator('#formula-substitution').innerText(), /m³\/s/);
  await page.getByLabel('泵效率 η').fill('101');
  await page.getByRole('button', { name: '计算', exact: true }).click();
  assert.match(await page.locator('#formula-field-eff-error').innerText(), /100/);
  await picker.selectOption('lmtd');
  await page.getByRole('button', { name: '载入算例' }).click();
  assert.match(await page.locator('#formula-result').innerText(), /对数平均温差\s+37\.44/);
  await page.reload();
  assert.equal(await picker.inputValue(), 'lmtd');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '载入算例' }).click();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  if (directory) await page.screenshot({ path: resolve(directory, 'formulas-mobile.png'), fullPage: true });
  await page.getByRole('link', { name: '管径比选', exact: true }).click();
  await flow.waitFor();
  assert.equal(await flow.inputValue(), '56');
}

const external = process.env.PAGES_TEST_URL;
const local = external ? null : await preview();
const url = external || local.url;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined });
try {
  const directory = process.env.QA_OUTPUT_DIRECTORY;
  if (directory) await mkdir(directory, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  const requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push([request.method(), request.url()]));
  await page.addInitScript(() => { window.print = () => { window.printRequested = true; }; });
  await page.goto(url);
  await checkStart(page, directory);
  await checkVersions(page);
  await checkReport(page, directory, 1);
  await checkReport(page, directory, 2);
  await checkBackup(browser, page, url);
  if (directory) await page.screenshot({ path: resolve(directory, 'workbench.png'), fullPage: true });
  await checkFormulaMenu(page, directory);
  assert.deepEqual(errors, []);
  assert(requests.every(([method, address]) => method === 'GET' && address.startsWith(url)),
    'the application should only fetch its own static assets');
  console.log('Browser verified: pipe workflow, reports, backup, formula menu and mobile layout.');
} finally {
  await browser.close();
  if (local) await new Promise(done => local.server.close(done));
}
