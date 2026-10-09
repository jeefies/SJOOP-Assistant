import * as fs from 'fs';
import * as path from 'path';
import { TestCase, ProjectConfig } from '../types';

export class CaseManager {
  private static getSjoopDir(workspaceRoot: string): string {
    const sjoopDir = path.join(workspaceRoot, '.sjoop');
    if (!fs.existsSync(sjoopDir)) {
      fs.mkdirSync(sjoopDir, { recursive: true });
    }
    return sjoopDir;
  }

  private static getTestsDir(workspaceRoot: string): string {
    const testsDir = path.join(this.getSjoopDir(workspaceRoot), 'tests');
    if (!fs.existsSync(testsDir)) {
      fs.mkdirSync(testsDir, { recursive: true });
    }
    return testsDir;
  }

  private static getProjectsDir(workspaceRoot: string): string {
    const projectsDir = path.join(this.getSjoopDir(workspaceRoot), 'projects');
    if (!fs.existsSync(projectsDir)) {
      fs.mkdirSync(projectsDir, { recursive: true });
    }
    return projectsDir;
  }

  public static loadTestCases(workspaceRoot: string, fileBaseName: string): TestCase[] {
    const testsDir = this.getTestsDir(workspaceRoot);
    const filePath = path.join(testsDir, `${fileBaseName}.json`);

    if (!fs.existsSync(filePath)) {
      // Return a default sample test case
      return [
        {
          id: 'case_1',
          name: '测试点 #1',
          input: '',
          expectedOutput: '',
          enabled: true,
        },
      ];
    }

    try {
      const data = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    } catch {
      // ignore error, return fallback
    }

    return [
      {
        id: 'case_1',
        name: '测试点 #1',
        input: '',
        expectedOutput: '',
        enabled: true,
      },
    ];
  }

  public static saveTestCases(workspaceRoot: string, fileBaseName: string, cases: TestCase[]): void {
    const testsDir = this.getTestsDir(workspaceRoot);
    const filePath = path.join(testsDir, `${fileBaseName}.json`);
    fs.writeFileSync(filePath, JSON.stringify(cases, null, 2), 'utf-8');
  }

  public static loadProjectConfig(workspaceRoot: string, fileBaseName: string, mainFilePath: string): ProjectConfig {
    const projDir = this.getProjectsDir(workspaceRoot);
    const filePath = path.join(projDir, `${fileBaseName}.json`);

    if (fs.existsSync(filePath)) {
      try {
        const data = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(data);
      } catch {
        // fallback
      }
    }

    return {
      mode: 'single',
      mainFile: mainFilePath,
      additionalFiles: [],
    };
  }

  public static saveProjectConfig(workspaceRoot: string, fileBaseName: string, config: ProjectConfig): void {
    const projDir = this.getProjectsDir(workspaceRoot);
    const filePath = path.join(projDir, `${fileBaseName}.json`);
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');
  }
}
