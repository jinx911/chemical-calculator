import { parseBackup, serializeBackup } from './project-file.mjs';

const DATABASE = 'chemical-calculator';
const VERSION = 1;
const stores = ['projects', 'worksheets', 'revisions'];

function upgrade(db, oldVersion) {
  if (oldVersion < 1) {
    db.createObjectStore('projects', { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt');
    const worksheets = db.createObjectStore('worksheets', { keyPath: 'id' });
    worksheets.createIndex('projectId', 'projectId');
    worksheets.createIndex('projectUpdatedAt', ['projectId', 'updatedAt']);
    const revisions = db.createObjectStore('revisions', { keyPath: ['worksheetId', 'sequence'] });
    revisions.createIndex('worksheetId', 'worksheetId');
  }
}

function openDatabase(indexedDB) {
  return new Promise((resolve, reject) => {
    if (!indexedDB) {
      reject(new Error('当前浏览器无法使用本地项目存储。'));
      return;
    }
    const request = indexedDB.open(DATABASE, VERSION);
    let blocked = false;
    request.onupgradeneeded = (event) => upgrade(request.result, event.oldVersion);
    request.onblocked = () => {
      blocked = true;
      reject(new Error('项目存储正在升级，请关闭同一工作台的其他标签页后重试。'));
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) {
        db.close();
        return;
      }
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

function result(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction(db, names, mode, action) {
  const tx = db.transaction(names, mode);
  const settled = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error ?? new Error('本地存储事务已取消。'));
  });
  settled.catch(() => {});
  try {
    const selected = Object.fromEntries(names.map((name) => [name, tx.objectStore(name)]));
    const output = await action(selected);
    await settled;
    return output;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // A failed IndexedDB request can already have aborted the transaction.
    }
    await settled.catch(() => {});
    throw error;
  }
}

const getProject = async (projects, id) => {
  const project = await result(projects.get(id));
  if (!project) throw new Error('本机找不到这个项目。');
  return project;
};

async function checkDraft(worksheets, worksheet) {
  const current = await result(worksheets.get(worksheet.id));
  if (!current || current.projectId !== worksheet.projectId) {
    throw new Error('本机找不到这张计算单。');
  }
  if (current.revision !== worksheet.revision) {
    throw new Error('这张计算单已在其他标签页更新，请先导出当前草稿，再重新打开计算单。');
  }
  return current;
}

const now = () => new Date().toISOString();
const recentFirst = (a, b) => b.updatedAt.localeCompare(a.updatedAt);

function newWorksheet(worksheet, updatedAt) {
  return { ...worksheet, revision: 0, sequence: 0, updatedAt };
}

function projectOperations(db) {
  return {
    listProjects: () => transaction(db, ['projects'], 'readonly', async ({ projects }) => {
      const entries = await result(projects.getAll());
      return entries.sort(recentFirst);
    }),
    putProject: (project) => transaction(db, ['projects'], 'readwrite', async ({ projects }) => {
      const current = await result(projects.get(project.id));
      const updatedAt = now();
      const entry = { ...project, createdAt: current?.createdAt ?? project.createdAt ?? updatedAt, updatedAt };
      await result(projects.put(entry));
      return entry;
    }),
    createProjectWithWorksheet: (project, worksheet) =>
      transaction(db, ['projects', 'worksheets'], 'readwrite', async ({ projects, worksheets }) => {
        if (worksheet.projectId !== project.id) throw new Error('计算单与项目不匹配。');
        const updatedAt = now();
        const entry = { ...project, createdAt: project.createdAt ?? updatedAt, updatedAt };
        const sheet = newWorksheet(worksheet, updatedAt);
        await Promise.all([result(projects.add(entry)), result(worksheets.add(sheet))]);
        return { project: entry, worksheet: sheet };
      }),
  };
}

function worksheetOperations(db) {
  return {
    listWorksheets: (projectId) => transaction(db, ['worksheets'], 'readonly', async ({ worksheets }) => {
      const entries = await result(worksheets.index('projectId').getAll(projectId));
      return entries.sort(recentFirst);
    }),
    createWorksheet: (worksheet) =>
      transaction(db, ['projects', 'worksheets'], 'readwrite', async ({ projects, worksheets }) => {
        const project = await getProject(projects, worksheet.projectId);
        const updatedAt = now();
        const entry = newWorksheet(worksheet, updatedAt);
        await Promise.all([result(worksheets.add(entry)), result(projects.put({ ...project, updatedAt }))]);
        return entry;
      }),
    saveDraft: (worksheet) =>
      transaction(db, ['projects', 'worksheets'], 'readwrite', async ({ projects, worksheets }) => {
        const current = await checkDraft(worksheets, worksheet);
        const project = await getProject(projects, worksheet.projectId);
        const updatedAt = now();
        const entry = { ...current, draft: worksheet.draft, revision: current.revision + 1, updatedAt };
        await Promise.all([result(worksheets.put(entry)), result(projects.put({ ...project, updatedAt }))]);
        return entry;
      }),
    listRevisions: (worksheetId) => transaction(db, ['revisions'], 'readonly', async ({ revisions }) => {
      const entries = await result(revisions.index('worksheetId').getAll(worksheetId));
      return entries.sort((a, b) => b.sequence - a.sequence);
    }),
  };
}

function saveSnapshot(db, worksheet, calculation) {
  return transaction(db, stores, 'readwrite', async ({ projects, worksheets, revisions }) => {
    const current = await checkDraft(worksheets, worksheet);
    const project = await getProject(projects, worksheet.projectId);
    const createdAt = now();
    const sequence = current.sequence + 1;
    const snapshot = {
      schemaVersion: 1,
      worksheetId: current.id,
      sequence,
      createdAt,
      projectName: project.name,
      algorithm: calculation.algorithm,
      draft: structuredClone(worksheet.draft),
      calculation: structuredClone(calculation),
    };
    const entry = { ...current, draft: worksheet.draft, sequence, revision: current.revision + 1, updatedAt: createdAt };
    await Promise.all([
      result(revisions.add(snapshot)),
      result(worksheets.put(entry)),
      result(projects.put({ ...project, updatedAt: createdAt })),
    ]);
    return { worksheet: entry, snapshot };
  });
}

function readProjectFile(db, projectId) {
  return transaction(db, stores, 'readonly', async ({ projects, worksheets, revisions }) => {
    const [project, entries] = await Promise.all([
      getProject(projects, projectId),
      result(worksheets.index('projectId').getAll(projectId)),
    ]);
    const history = await Promise.all(entries.map(({ id }) => result(revisions.index('worksheetId').getAll(id))));
    return serializeBackup(project, entries, history.flat());
  });
}

function writeProjectFile(db, text) {
  const backup = parseBackup(text);
  return transaction(db, stores, 'readwrite', async ({ projects, worksheets, revisions }) => {
    await Promise.all([
      result(projects.add(backup.project)),
      ...backup.worksheets.map((worksheet) => result(worksheets.add(worksheet))),
      ...backup.revisions.map((snapshot) => result(revisions.add(snapshot))),
    ]);
    return backup.project;
  });
}

/** Opens this site's browser-local project store. */
export async function openStorage(indexedDB = globalThis.indexedDB) {
  const db = await openDatabase(indexedDB);
  return {
    ...projectOperations(db),
    ...worksheetOperations(db),
    saveRevision: (worksheet, calculation) => saveSnapshot(db, worksheet, calculation),
    exportProject: (projectId) => readProjectFile(db, projectId),
    importProject: async (text) => writeProjectFile(db, text),
  };
}
