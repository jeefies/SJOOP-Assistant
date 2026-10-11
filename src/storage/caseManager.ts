import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { TestCase, ProjectConfig, MultiProject, ProjectsStore } from '../types';

export class CaseManager {
  private static globalStorageDir: string | null = null;

  public static init(storageDir: string): void {
    CaseManager.globalStorageDir = storageDir;
    if (!fs.existsSync(storageDir)) {
      try {
        fs.mkdirSync(storageDir, { recursive: true });
      } catch {}
    }
  }

  public static getStorageDir(): string {
    if (this.globalStorageDir) {
      if (!fs.existsSync(this.globalStorageDir)) {
        try {
          fs.mkdirSync(this.globalStorageDir, { recursive: true });
        } catch {}
      }
      return this.globalStorageDir;
    }
    const fallback = path.join(os.homedir(), '.sjoop_data');
    if (!fs.existsSync(fallback)) {
      try {
        fs.mkdirSync(fallback, { recursive: true });
      } catch {}
    }
    return fallback;
  }

  public static getBuildDir(): string {
    const buildDir = path.join(os.tmpdir(), 'sjoop_build');
    if (!fs.existsSync(buildDir)) {
      try {
        fs.mkdirSync(buildDir, { recursive: true });
      } catch {}
    }
    return buildDir;
  }

  public static getDefaultTestCase(): TestCase {
    return {
      id: 'case_1',
      name: '测试点 #1',
      input: '',
      expectedOutput: '',
      enabled: true,
    };
  }

  // ---------------------------------------------------------------------------
  // Multi-file Projects Management (Global Storage, Zero Workspace Pollution)
  // ---------------------------------------------------------------------------

  private static getProjectsFilePath(): string {
    return path.join(this.getStorageDir(), 'projects.json');
  }

  public static getProjectsStore(): ProjectsStore {
    const pPath = this.getProjectsFilePath();
    if (fs.existsSync(pPath)) {
      try {
        const raw = fs.readFileSync(pPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.projects) && parsed.projects.length > 0) {
          if (!parsed.activeProjectId || !parsed.projects.some((p: MultiProject) => p.id === parsed.activeProjectId)) {
            parsed.activeProjectId = parsed.projects[0].id;
          }
          return parsed;
        }
      } catch {}
    }

    const defaultStore: ProjectsStore = {
      activeProjectId: 'default',
      projects: [
        {
          id: 'default',
          name: '默认项目',
          createdAt: Date.now(),
          files: [],
          testCases: [this.getDefaultTestCase()],
        },
      ],
    };
    this.saveProjectsStore(defaultStore);
    return defaultStore;
  }

  public static saveProjectsStore(store: ProjectsStore): void {
    const pPath = this.getProjectsFilePath();
    try {
      fs.writeFileSync(pPath, JSON.stringify(store, null, 2), 'utf-8');
    } catch (e) {
      console.error('Failed to save projects store:', e);
    }
  }

  public static getActiveProject(): MultiProject {
    const store = this.getProjectsStore();
    const found = store.projects.find((p) => p.id === store.activeProjectId);
    if (found) return found;

    store.activeProjectId = store.projects[0].id;
    this.saveProjectsStore(store);
    return store.projects[0];
  }

  public static setActiveProject(id: string): MultiProject {
    const store = this.getProjectsStore();
    const found = store.projects.find((p) => p.id === id);
    if (found) {
      store.activeProjectId = id;
      this.saveProjectsStore(store);
      return found;
    }
    return this.getActiveProject();
  }

  public static createProject(name: string, initialFiles: string[] = []): MultiProject {
    const store = this.getProjectsStore();
    const newProject: MultiProject = {
      id: 'proj_' + Date.now(),
      name: name.trim() || '未命名项目',
      createdAt: Date.now(),
      files: initialFiles,
      testCases: [this.getDefaultTestCase()],
    };
    store.projects.push(newProject);
    store.activeProjectId = newProject.id;
    this.saveProjectsStore(store);
    return newProject;
  }

  public static renameProject(id: string, newName: string): boolean {
    const trimmed = newName.trim();
    if (!trimmed) return false;
    const store = this.getProjectsStore();
    const target = store.projects.find((p) => p.id === id);
    if (!target) return false;
    target.name = trimmed;
    this.saveProjectsStore(store);
    return true;
  }

  public static deleteProject(id: string): boolean {
    const store = this.getProjectsStore();
    if (store.projects.length <= 1) {
      // Don't leave store empty: reset the last one to empty project
      store.projects[0].name = '默认项目';
      store.projects[0].files = [];
      store.projects[0].testCases = [this.getDefaultTestCase()];
      store.activeProjectId = store.projects[0].id;
      this.saveProjectsStore(store);
      return true;
    }

    store.projects = store.projects.filter((p) => p.id !== id);
    if (store.activeProjectId === id) {
      store.activeProjectId = store.projects[0].id;
    }
    this.saveProjectsStore(store);
    return true;
  }

  public static updateProject(project: MultiProject): void {
    const store = this.getProjectsStore();
    const idx = store.projects.findIndex((p) => p.id === project.id);
    if (idx >= 0) {
      store.projects[idx] = project;
      this.saveProjectsStore(store);
    }
  }

  public static getProject(id: string): MultiProject | undefined {
    const store = this.getProjectsStore();
    return store.projects.find((p) => p.id === id);
  }

  // ---------------------------------------------------------------------------
  // Single-file Test Cases Management (Global Storage, Zero Workspace Pollution)
  // ---------------------------------------------------------------------------

  private static getSingleCasesDir(): string {
    const dir = path.join(this.getStorageDir(), 'single_cases');
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {}
    }
    return dir;
  }

  public static getSingleFileKey(filePath: string): string {
    const normalized = path.resolve(filePath).toLowerCase();
    const hash = crypto.createHash('md5').update(normalized).digest('hex').slice(0, 10);
    const base = path.basename(filePath, path.extname(filePath));
    return `${base}_${hash}`;
  }

  public static loadSingleFileTestCases(filePath: string): TestCase[] {
    if (!filePath) return [this.getDefaultTestCase()];

    const key = this.getSingleFileKey(filePath);
    const targetFile = path.join(this.getSingleCasesDir(), `${key}.json`);

    if (fs.existsSync(targetFile)) {
      try {
        const raw = fs.readFileSync(targetFile, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      } catch {}
    }

    // Silent migration check from legacy .sjoop if present in the file's directory
    try {
      const fileDir = path.dirname(filePath);
      const baseName = path.basename(filePath, path.extname(filePath));
      const legacyFile = path.join(fileDir, '.sjoop', 'tests', `${baseName}.json`);
      if (fs.existsSync(legacyFile)) {
        const legacyData = JSON.parse(fs.readFileSync(legacyFile, 'utf-8'));
        if (Array.isArray(legacyData) && legacyData.length > 0) {
          this.saveSingleFileTestCases(filePath, legacyData);
          return legacyData;
        }
      }
    } catch {}

    return [this.getDefaultTestCase()];
  }

  public static saveSingleFileTestCases(filePath: string, cases: TestCase[]): void {
    if (!filePath) return;
    const key = this.getSingleFileKey(filePath);
    const targetFile = path.join(this.getSingleCasesDir(), `${key}.json`);
    try {
      fs.writeFileSync(targetFile, JSON.stringify(cases, null, 2), 'utf-8');
    } catch (e) {
      console.error('Failed to save single file test cases:', e);
    }
  }

  // ---------------------------------------------------------------------------
  // Backwards Compatibility Shims for Existing Tests
  // ---------------------------------------------------------------------------

  public static loadTestCases(workspaceRoot: string, fileBaseName: string): TestCase[] {
    const key = `${fileBaseName}_legacy`;
    const targetFile = path.join(this.getSingleCasesDir(), `${key}.json`);
    if (fs.existsSync(targetFile)) {
      try {
        const raw = fs.readFileSync(targetFile, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      } catch {}
    }
    return [this.getDefaultTestCase()];
  }

  public static saveTestCases(workspaceRoot: string, fileBaseName: string, cases: TestCase[]): void {
    const key = `${fileBaseName}_legacy`;
    const targetFile = path.join(this.getSingleCasesDir(), `${key}.json`);
    try {
      fs.writeFileSync(targetFile, JSON.stringify(cases, null, 2), 'utf-8');
    } catch {}
  }

  private static lastMode: 'single' | 'multi' = 'single';

  public static loadProjectConfig(workspaceRoot: string, fileBaseName: string, mainFilePath: string): ProjectConfig {
    const active = this.getActiveProject();
    return {
      mode: this.lastMode,
      mainFile: mainFilePath,
      additionalFiles: active.files,
      activeProjectId: active.id,
      projects: this.getProjectsStore().projects.map((p) => ({ id: p.id, name: p.name })),
    };
  }

  public static saveProjectConfig(workspaceRoot: string, fileBaseName: string, config: ProjectConfig): void {
    this.lastMode = config.mode;
    if (config.mode === 'multi') {
      const active = this.getActiveProject();
      if (config.additionalFiles) {
        active.files = config.additionalFiles;
      }
      this.updateProject(active);
    }
  }
}
