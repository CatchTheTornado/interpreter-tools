import * as fs from 'fs';
import * as path from 'path';
import { ExecutionOptions } from './types';

export interface LanguageConfig {
  language: string;
  defaultImage: string;
  codeFilename: string;
  prepareFiles: (options: ExecutionOptions, tempDir: string) => void;
  buildInlineCommand: (depsInstalled: boolean) => string[];
  buildRunAppCommand: (entryFile: string, depsInstalled: boolean) => string[];
}

const jsTsPrepare = (options: ExecutionOptions, tempDir: string, filename: string) => {
  fs.writeFileSync(path.join(tempDir, filename), options.code);
  const packageJson = {
    name: 'code-execution',
    version: '1.0.0',
    private: true,
    license: 'UNLICENSED',
    dependencies: {},
    devDependencies: {
      '@types/node': 'latest'
    }
  } as any;
  if (options.language === 'typescript') {
    packageJson.devDependencies.typescript = 'latest';
    fs.writeFileSync(path.join(tempDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2020',
        module: 'commonjs',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true
      }
    }, null, 2));
  }
  if (options.dependencies?.length) {
    for (const dep of options.dependencies) {
      const [name, version] = dep.split('@');
      packageJson.dependencies[name] = version || 'latest';
    }
  }
  fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));
};

export const defaultLanguageConfigs: LanguageConfig[] = [
  {
    language: 'javascript',
    defaultImage: 'node:18-alpine',
    codeFilename: 'code.js',
    prepareFiles: (options, dir) => jsTsPrepare(options, dir, 'code.js'),
    buildInlineCommand: (depsInstalled) => [
      'sh', '-c', `${depsInstalled ? '' : 'yarn install && '}node code.js`
    ],
    buildRunAppCommand: (entry, depsInstalled) => [
      'sh', '-c', `${depsInstalled ? '' : 'yarn install && '}node ${entry}`
    ]
  },
  {
    language: 'typescript',
    defaultImage: 'node:18-alpine',
    codeFilename: 'code.ts',
    prepareFiles: (options, dir) => jsTsPrepare(options, dir, 'code.ts'),
    buildInlineCommand: (depsInstalled) => [
      'sh', '-c', `${depsInstalled ? '' : 'yarn install && '}npx ts-node code.ts`
    ],
    buildRunAppCommand: (entry, depsInstalled) => [
      'sh', '-c', `${depsInstalled ? '' : 'yarn install && '}npx ts-node ${entry}`
    ]
  },
  {
    language: 'python',
    defaultImage: 'python:3.9-slim',
    codeFilename: 'code.py',
    prepareFiles: (options, dir) => {
      fs.writeFileSync(path.join(dir, 'code.py'), options.code);
      if (options.dependencies?.length) {
        fs.writeFileSync(path.join(dir, 'requirements.txt'), options.dependencies.join('\n'));
      }
    },
    buildInlineCommand: (depsInstalled) => [
      'sh', '-c', `${depsInstalled ? '' : 'if [ -f requirements.txt ]; then pip install -r requirements.txt 2>/dev/null; fi && '}py=$(command -v python3 || command -v python) && $py -u code.py`
    ],
    buildRunAppCommand: (entry, depsInstalled) => [
      'sh', '-c', `${depsInstalled ? '' : 'if [ -f requirements.txt ]; then pip install -r requirements.txt 2>/dev/null; fi && '}py=$(command -v python3 || command -v python) && $py -u ${entry}`
    ]
  },
  {
    language: 'shell',
    defaultImage: 'alpine:latest',
    codeFilename: 'code.sh',
    prepareFiles: (options, dir) => {
      const filepath = path.join(dir, 'code.sh');
      fs.writeFileSync(filepath, options.code);
      fs.chmodSync(filepath, '755');
    },
    buildInlineCommand: () => ['sh', '-c', './code.sh'],
    buildRunAppCommand: (entry) => ['sh', '-c', `chmod +x ${entry} && ./${entry}`]
  }
];

export class LanguageRegistry {
  private static configs = new Map<string, LanguageConfig>(
    defaultLanguageConfigs.map(cfg => [cfg.language, cfg])
  );

  static get(language: string): LanguageConfig | undefined {
    return this.configs.get(language);
  }

  static register(config: LanguageConfig): void {
    this.configs.set(config.language, config);
  }

  static list(): LanguageConfig[] {
    return Array.from(this.configs.values());
  }
} 