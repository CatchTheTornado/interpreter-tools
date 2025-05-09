import * as fs from 'fs';
import * as path from 'path';
import { ExecutionOptions } from './types';
import Docker from 'dockerode';
import { Duplex } from 'stream';

export interface LanguageConfig {
  language: string;
  defaultImage: string;
  codeFilename: string;
  prepareFiles: (options: ExecutionOptions, tempDir: string) => void;
  buildInlineCommand: (depsInstalled: boolean) => string[];
  buildRunAppCommand: (entryFile: string, depsInstalled: boolean) => string[];
  installDependencies?: (container: Docker.Container, options: ExecutionOptions) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
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
    buildInlineCommand: (_depsInstalled: boolean) => [
      'sh', '-c', 'npx ts-node code.ts'
    ],
    buildRunAppCommand: (entry, _depsInstalled: boolean) => [
      'sh', '-c', `npx ts-node ${entry}`
    ],
    installDependencies: async (container, options) => {
      // Install NPM/Yarn dependencies inside container when package.json exists
      const cmd = 'if [ -f package.json ]; then yarn install --ignore-scripts --non-interactive || npm install --no-audit --no-fund; fi';
      const exec = await container.exec({ Cmd: ['sh', '-c', cmd], AttachStdout: true, AttachStderr: true });
      const stream = await exec.start({ hijack: true, stdin: false });
      let out = '';
      let err = '';
      await new Promise<void>(resolve => {
        container.modem.demuxStream(stream as Duplex,
          { write: (c: Buffer) => { out += c.toString(); } },
          { write: (c: Buffer) => { err += c.toString(); } }
        );
        stream.on('end', resolve);
      });
      const info = await exec.inspect();
      return { stdout: out, stderr: err, exitCode: typeof info.ExitCode === 'number' ? info.ExitCode : 1 };
    }
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
    buildInlineCommand: (_depsInstalled: boolean) => [
      'sh', '-c', 'py=$(command -v python3 || command -v python) && $py -u code.py'
    ],
    buildRunAppCommand: (entry, _depsInstalled: boolean) => [
      'sh', '-c', `py=$(command -v python3 || command -v python) && $py -u ${entry}`
    ],
    installDependencies: async (container, _options) => {
      const cmd = 'if [ -f requirements.txt ]; then pip install -r requirements.txt; fi';
      const exec = await container.exec({ Cmd: ['sh', '-c', cmd], AttachStdout: true, AttachStderr: true });
      const stream = await exec.start({ hijack: true, stdin: false });
      let out = '';
      let err = '';
      await new Promise<void>(resolve => {
        container.modem.demuxStream(stream as Duplex,
          { write: (c: Buffer) => { out += c.toString(); } },
          { write: (c: Buffer) => { err += c.toString(); } }
        );
        stream.on('end', resolve);
      });
      const info = await exec.inspect();
      return { stdout: out, stderr: err, exitCode: typeof info.ExitCode === 'number' ? info.ExitCode : 1 };
    }
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
    buildRunAppCommand: (entry) => ['sh', '-c', `chmod +x ${entry} && ./${entry}`],
    installDependencies: async (container, options) => {
      if (!options.dependencies || options.dependencies.length === 0) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }

      // Update Alpine package repository
      const updateExec = await container.exec({
        Cmd: ['sh', '-c', 'apk update'],
        AttachStdout: true,
        AttachStderr: true
      });
      let updateOutput = '';
      const updateStream = await updateExec.start({ hijack: true, stdin: false });
      await new Promise((resolve) => {
        container.modem.demuxStream(updateStream as Duplex,
          { write: (chunk: Buffer) => {
              updateOutput += chunk.toString();
              if (options.streamOutput?.stdout) {
                options.streamOutput.stdout(chunk.toString());
              }
            }
          },
          { write: (chunk: Buffer) => {
              updateOutput += chunk.toString();
              if (options.streamOutput?.stderr) {
                options.streamOutput.stderr(chunk.toString());
              }
            }
          });
        updateStream.on('end', resolve);
      });
      const updateInfo = await updateExec.inspect();
      if (updateInfo.ExitCode !== 0) {
        return { stdout: updateOutput, stderr: '', exitCode: typeof updateInfo.ExitCode === 'number' ? updateInfo.ExitCode : 1 };
      }

      // Install requested packages
      const installCmd = `apk add --no-cache ${options.dependencies.join(' ')}`;
      const installExec = await container.exec({
        Cmd: ['sh', '-c', installCmd],
        AttachStdout: true,
        AttachStderr: true
      });
      let installOutput = '';
      const installStream = await installExec.start({ hijack: true, stdin: false });
      await new Promise((resolve) => {
        container.modem.demuxStream(installStream as Duplex,
          { write: (chunk: Buffer) => {
              installOutput += chunk.toString();
              if (options.streamOutput?.stdout) {
                options.streamOutput.stdout(chunk.toString());
              }
            }
          },
          { write: (chunk: Buffer) => {
              installOutput += chunk.toString();
              if (options.streamOutput?.stderr) {
                options.streamOutput.stderr(chunk.toString());
              }
            }
          });
        installStream.on('end', resolve);
      });
      const installInfo = await installExec.inspect();
      return { stdout: installOutput, stderr: '', exitCode: typeof installInfo.ExitCode === 'number' ? installInfo.ExitCode : 1 };
    }
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

  static names(): string[] {
    return Array.from(this.configs.keys());
  }
} 