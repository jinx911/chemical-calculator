# 化工工艺计算工作台

用于比较单段液体管线的候选内径、校核流速和阻力压降，并保存可复核的计算书。首次打开可载入冷却水算例。

[打开工艺计算工作台](https://jinx911.github.io/chemical-calculator/)

- **比选**：一个管线计算单可记录多个工况和候选方案。表中分别显示阻力压降、高差项与带符号的静压差。
- **校核**：以项目或计算单填写的流速和阻力压降上限为依据。详情可展开计算公式、换算后的输入和取值依据。
- **交付**：保存版本并比较变化。通过「打印计算书」在浏览器中另存 PDF。项目 JSON 包含草稿和历史版本，可导入后继续计算。
- **存储**：项目保存在当前浏览器。清除网站数据或换电脑前，请先导出项目备份。

计算范围为稳态、不可压、单相牛顿液体在等内径满流圆管内的正向流动。采用 Darcy–Weisbach 方法，过渡区的阻力压降标为未判定。计算方法参见 [EPA EPANET 2.2](https://usepa.github.io/EPANET2.2/12_analysis_algorithms.html)。

## 本地运行

在项目根目录运行以下命令，并打开浏览器访问 [本地工作台](http://localhost:8000/)。

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

```sh
npm ci
npm test
npm run build
npx playwright install chromium
npm run test:browser
```

GitHub Pages 的发布源使用 GitHub Actions。默认分支的工作流在计算和浏览器验证通过后，发布白名单内的静态资源。
