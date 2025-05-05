import { ContainerManager } from './container-manager';
import { ExecutionOptions, ExecutionResult, SessionConfig, ContainerStrategy } from './types';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import Docker from 'dockerode';
import { Duplex } from 'stream';

interface PackageJson {
  name: string;
  version: string;
  private: boolean;
  license: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

export class ExecutionEngine {
  private containerManager: ContainerManager;
  private sessionContainers: Map<string, Docker.Container>;
  private sessionConfigs: Map<string, SessionConfig>;

  constructor() {
    this.containerManager = new ContainerManager();
    this.sessionContainers = new Map();
    this.sessionConfigs = new Map();
  }

  private async prepareCodeFile(options: ExecutionOptions): Promise<string> {
    const tempDir = path.join('/tmp', uuidv4());
    fs.mkdirSync(tempDir, { recursive: true });

    let filename: string;
    let packageFile: string | null = null;

    switch (options.language) {
      case 'typescript':
        filename = 'code.ts';
        packageFile = 'package.json';
        // Create tsconfig.json
        fs.writeFileSync(
          path.join(tempDir, 'tsconfig.json'),
          JSON.stringify({
            compilerOptions: {
              target: 'ES2020',
              module: 'commonjs',
              strict: true,
              esModuleInterop: true,
              skipLibCheck: true,
              forceConsistentCasingInFileNames: true,
              lib: ['ES2020', 'DOM']
            }
          }, null, 2)
        );
        break;
      case 'javascript':
        filename = 'code.js';
        packageFile = 'package.json';
        break;
      case 'python':
        filename = 'code.py';
        packageFile = 'requirements.txt';
        break;
      case 'shell':
        filename = 'code.sh';
        break;
      default:
        throw new Error(`Unsupported language: ${options.language}`);
    }

    const filePath = path.join(tempDir, filename);
    fs.writeFileSync(filePath, options.code);
    if (options.language === 'shell') {
      fs.chmodSync(filePath, '755');
    }

    if (options.dependencies && options.dependencies.length > 0) {
      if (packageFile === 'package.json') {
        const packageJson: PackageJson = {
          name: 'code-execution',
          version: '1.0.0',
          private: true,
          license: 'UNLICENSED',
          dependencies: options.dependencies.reduce((acc, dep) => {
            const [name, version] = dep.split('@');
            acc[name] = version || 'latest';
            return acc;
          }, {} as Record<string, string>),
          devDependencies: {
            '@types/node': 'latest',
            'typescript': 'latest',
            'ts-node': 'latest'
          }
        };
        if (options.language === 'typescript') {
          packageJson.devDependencies['@types/lodash'] = 'latest';
        }
        fs.writeFileSync(
          path.join(tempDir, packageFile),
          JSON.stringify(packageJson, null, 2)
        );
      } else if (packageFile === 'requirements.txt') {
        fs.writeFileSync(
          path.join(tempDir, packageFile),
          options.dependencies.join('\n')
        );
      }
    }

    return tempDir;
  }

  private getContainerImage(language: string): string {
    switch (language) {
      case 'typescript':
      case 'javascript':
        return 'node:18-alpine';
      case 'python':
        return 'python:3.9-slim';
      case 'shell':
        return 'alpine:latest';
      default:
        throw new Error(`Unsupported language: ${language}`);
    }
  }

  private async executeInContainer(
    container: Docker.Container,
    options: ExecutionOptions,
    codePath: string
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    let command: string[];

    // Write code directly to workspace
    const writeExec = await container.exec({
      Cmd: ['sh', '-c', `cat > /workspace/code.py << 'EOL'
${options.code.trim()}
EOL`],
      AttachStdout: true,
      AttachStderr: true
    });
    await writeExec.start({ hijack: true, stdin: false });

    // List workspace contents only in verbose mode
    if (options.verbose) {
      const lsExec = await container.exec({
        Cmd: ['ls', '-la', '/workspace'],
        AttachStdout: true,
        AttachStderr: true
      });
      const lsStream = await lsExec.start({ hijack: true, stdin: false });
      await new Promise((resolve) => {
        let output = '';
        container.modem.demuxStream(lsStream as Duplex, {
          write: (chunk: Buffer) => {
            output += chunk.toString();
            console.log('Workspace contents:', output);
          }
        }, process.stderr);
        lsStream.on('end', resolve);
      });
    }

    switch (options.language) {
      case 'typescript':
        command = ['sh', '-c', 'yarn install && npx ts-node code.ts'];
        break;
      case 'javascript':
        command = ['sh', '-c', 'yarn install && node code.js'];
        break;
      case 'python':
        command = ['sh', '-c', 'if [ -f requirements.txt ]; then pip install -r requirements.txt 2>/dev/null; fi && python code.py'];
        break;
      case 'shell':
        command = ['sh', '-c', './code.sh'];
        break;
      default:
        throw new Error(`Unsupported language: ${options.language}`);
    }

    return new Promise((resolve, reject) => {
      container.exec({
        Cmd: command,
        AttachStdout: true,
        AttachStderr: true,
        WorkingDir: '/workspace'
      }, (err, exec) => {
        if (err || !exec) {
          reject(err || new Error('Failed to create exec instance'));
          return;
        }

        exec.start({
          hijack: true,
          stdin: false
        }, (err, stream) => {
          if (err || !stream) {
            reject(err || new Error('Failed to start exec instance'));
            return;
          }

          let stdout = '';
          let stderr = '';

          container.modem.demuxStream(stream as Duplex, {
            write: (chunk: Buffer) => {
              stdout += chunk.toString();
            }
          }, {
            write: (chunk: Buffer) => {
              stderr += chunk.toString();
            }
          });

          stream.on('end', async () => {
            try {
              const info = await exec.inspect();
              resolve({
                stdout,
                stderr,
                exitCode: info.ExitCode || 1,
                executionTime: Date.now() - startTime
              });
            } catch (error) {
              reject(error);
            }
          });
        });
      });
    });
  }

  async createSession(config: SessionConfig): Promise<string> {
    const sessionId = uuidv4();
    this.sessionConfigs.set(sessionId, config);

    if (config.strategy === ContainerStrategy.PER_SESSION) {
      const container = await this.containerManager.createContainer(config.containerConfig);
      this.sessionContainers.set(sessionId, container);
    }

    return sessionId;
  }

  async executeCode(sessionId: string, options: ExecutionOptions): Promise<ExecutionResult> {
    const config = this.sessionConfigs.get(sessionId);
    if (!config) {
      throw new Error('Invalid session ID');
    }

    const codePath = await this.prepareCodeFile(options);
    let container: Docker.Container;

    try {
      switch (config.strategy) {
        case ContainerStrategy.PER_EXECUTION:
          container = await this.containerManager.createContainer({
            ...config.containerConfig,
            image: this.getContainerImage(options.language),
            mounts: [
              ...(config.containerConfig.mounts || []),
              {
                type: 'directory',
                source: codePath,
                target: '/workspace'
              }
            ]
          });
          break;

        case ContainerStrategy.POOL: {
          const pooledContainer = await this.containerManager.getContainerFromPool();
          if (!pooledContainer) {
            container = await this.containerManager.createContainer({
              ...config.containerConfig,
              image: this.getContainerImage(options.language),
              mounts: [
                ...(config.containerConfig.mounts || []),
                {
                  type: 'directory',
                  source: codePath,
                  target: '/workspace'
                }
              ]
            });
          } else {
            container = pooledContainer;
          }
          break;
        }

        case ContainerStrategy.PER_SESSION: {
          const sessionContainer = this.sessionContainers.get(sessionId);
          if (!sessionContainer) {
            throw new Error('Session container not found');
          }
          container = sessionContainer;
          break;
        }

        default:
          throw new Error(`Unsupported container strategy: ${config.strategy}`);
      }

      const result = await this.executeInContainer(container, options, codePath);

      if (config.strategy === ContainerStrategy.POOL) {
        await this.containerManager.returnContainerToPool(container);
      } else if (config.strategy === ContainerStrategy.PER_EXECUTION) {
        await container.remove({ force: true });
      }

      return result;
    } finally {
      // Cleanup temporary files
      fs.rmSync(codePath, { recursive: true, force: true });
    }
  }

  async cleanupSession(sessionId: string): Promise<void> {
    const container = this.sessionContainers.get(sessionId);
    if (container) {
      await container.remove({ force: true });
      this.sessionContainers.delete(sessionId);
    }
    this.sessionConfigs.delete(sessionId);
  }

  async cleanup(): Promise<void> {
    await this.containerManager.cleanup();
    this.sessionContainers.clear();
    this.sessionConfigs.clear();
  }
} 