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
  private containerToSession: Map<string, string>;
  // Map to keep dedicated pool containers per session
  // (reuses sessionContainers for POOL as well)

  constructor() {
    this.containerManager = new ContainerManager();
    this.sessionContainers = new Map();
    this.sessionConfigs = new Map();
    this.containerToSession = new Map();
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
    config: SessionConfig,
    codePath: string
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    let command: string[];
    let workingDir = '/workspace';

    if (options.runApp) {
      // Validate that the working directory is mounted
      const cwdMount = config.containerConfig.mounts?.find(
        mount => mount.type === 'directory' && mount.target === options.runApp!.cwd
      );

      if (!cwdMount) {
        throw new Error(`Working directory ${options.runApp.cwd} is not mounted in the container`);
      }

      workingDir = options.runApp.cwd;

      // For running entire applications, we don't need to write the code file
      // as it's already in the mounted directory
      switch (options.language) {
        case 'typescript':
          command = ['sh', '-c', `yarn install && npx ts-node ${options.runApp.entryFile}`];
          break;
        case 'javascript':
          command = ['sh', '-c', `yarn install && node ${options.runApp.entryFile}`];
          break;
        case 'python':
          command = ['sh', '-c', `if [ -f requirements.txt ]; then pip install -r requirements.txt 2>/dev/null; fi && python ${options.runApp.entryFile}`];
          break;
        case 'shell':
          command = ['sh', '-c', `chmod +x ${options.runApp.entryFile} && ./${options.runApp.entryFile}`];
          break;
        default:
          throw new Error(`Unsupported language: ${options.language}`);
      }
    } else {
      // Write code directly to workspace
      // Determine the correct filename based on language
      let workspaceFilename: string;
      switch (options.language) {
        case 'typescript':
          workspaceFilename = 'code.ts';
          break;
        case 'javascript':
          workspaceFilename = 'code.js';
          break;
        case 'python':
          workspaceFilename = 'code.py';
          break;
        case 'shell':
          workspaceFilename = 'code.sh';
          break;
        default:
          throw new Error(`Unsupported language: ${options.language}`);
      }

      const writeExec = await container.exec({
        Cmd: ['sh', '-c', `cat > /workspace/${workspaceFilename} << 'EOL'
${options.code.trim()}
EOL`],
        AttachStdout: true,
        AttachStderr: true
      });
      const writeStream = await writeExec.start({ hijack: true, stdin: false });

      // Wait for the write operation to complete
      await new Promise<void>((resolve, reject) => {
        writeStream.on('end', async () => {
          try {
            const info = await writeExec.inspect();
            if ((info.ExitCode ?? 1) !== 0) {
              reject(new Error('Failed to write code to workspace'));
            } else {
              resolve();
            }
          } catch (err) {
            reject(err);
          }
        });
      });

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
          // For shell scripts, install Alpine packages if dependencies are specified
          if (options.dependencies && options.dependencies.length > 0) {
            // First update the package repository
            const updateExec = await container.exec({
              Cmd: ['sh', '-c', 'apk update'],
              AttachStdout: true,
              AttachStderr: true
            });
            let updateOutput = '';
            const updateStream = await updateExec.start({ hijack: true, stdin: false });
            await new Promise((resolve) => {
              container.modem.demuxStream(updateStream as Duplex, {
                write: (chunk: Buffer) => {
                  const data = chunk.toString();
                  updateOutput += data;
                  if (options.streamOutput?.stdout) {
                    options.streamOutput.stdout(data);
                  }
                }
              }, {
                write: (chunk: Buffer) => {
                  const data = chunk.toString();
                  updateOutput += data;
                  if (options.streamOutput?.stderr) {
                    options.streamOutput.stderr(data);
                  }
                }
              });
              updateStream.on('end', resolve);
            });
            const updateInfo = await updateExec.inspect();
            if (updateInfo.ExitCode !== 0) {
              throw new Error(`Failed to update Alpine package repository: ${updateOutput}`);
            }

            // Then install the required packages
            const installCmd = `apk add --no-cache ${options.dependencies.join(' ')}`;
            const installExec = await container.exec({
              Cmd: ['sh', '-c', installCmd],
              AttachStdout: true,
              AttachStderr: true
            });
            let installOutput = '';
            const installStream = await installExec.start({ hijack: true, stdin: false });
            await new Promise((resolve) => {
              container.modem.demuxStream(installStream as Duplex, {
                write: (chunk: Buffer) => {
                  const data = chunk.toString();
                  installOutput += data;
                  if (options.streamOutput?.stdout) {
                    options.streamOutput.stdout(data);
                  }
                }
              }, {
                write: (chunk: Buffer) => {
                  const data = chunk.toString();
                  installOutput += data;
                  if (options.streamOutput?.stderr) {
                    options.streamOutput.stderr(data);
                  }
                }
              });
              installStream.on('end', resolve);
            });
            const installInfo = await installExec.inspect();
            if (installInfo.ExitCode !== 0) {
              throw new Error(`Failed to install Alpine packages: ${options.dependencies.join(', ')}\nOutput: ${installOutput}`);
            }
          }
          command = ['sh', '-c', './code.sh'];
          break;
        default:
          throw new Error(`Unsupported language: ${options.language}`);
      }
    }

    return new Promise((resolve, reject) => {
      container.exec({
        Cmd: command,
        AttachStdout: true,
        AttachStderr: true,
        WorkingDir: workingDir
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
              const data = chunk.toString();
              stdout += data;
              if (options.streamOutput?.stdout) {
                options.streamOutput.stdout(data);
              }
            }
          }, {
            write: (chunk: Buffer) => {
              const data = chunk.toString();
              stderr += data;
              if (options.streamOutput?.stderr) {
                options.streamOutput.stderr(data);
              }
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
            image: config.containerConfig.image ? config.containerConfig.image : this.getContainerImage(options.language),
            mounts: [
              ...(config.containerConfig.mounts || []),
              {
                type: 'directory',
                source: codePath,
                target: '/workspace'
              }
            ]
          });
          this.containerToSession.set(container.id, sessionId);
          break;

        case ContainerStrategy.POOL: {
          // Check if a container is already assigned to this session
          let sessionContainer = this.sessionContainers.get(sessionId);
          if (!sessionContainer) {
            const pooledContainer = await this.containerManager.getContainerFromPool();
            if (!pooledContainer) {
              // No available container, create a fresh one and push to pool later on cleanup
              sessionContainer = await this.containerManager.createContainer({
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
              sessionContainer = pooledContainer;
              // We need to mount the code directory into the container
              // For simplicity, rely on code being copied into /workspace below (prepared code file)
            }
            this.sessionContainers.set(sessionId, sessionContainer);
            this.containerToSession.set(sessionContainer.id, sessionId);
          }
          container = sessionContainer;
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

      const result = await this.executeInContainer(container, options, config, codePath);

      if (config.strategy === ContainerStrategy.POOL) {
        // Do nothing here; container remains assigned for session lifetime.
      } else if (config.strategy === ContainerStrategy.PER_EXECUTION) {
        await container.remove({ force: true });
        this.containerToSession.delete(container.id);
      }

      return result;
    } finally {
      // Cleanup temporary files
      fs.rmSync(codePath, { recursive: true, force: true });
    }
  }

  async cleanupSession(sessionId: string): Promise<void> {
    const container = this.sessionContainers.get(sessionId);
    const config = this.sessionConfigs.get(sessionId);

    if (container) {
      if (config?.strategy === ContainerStrategy.POOL) {
        // Return container to pool after cleaning up workspace via ContainerManager
        await this.containerManager.returnContainerToPool(container);
      } else {
        await container.remove({ force: true });
      }
      this.sessionContainers.delete(sessionId);
      this.containerToSession.delete(container.id);
    }
    this.sessionConfigs.delete(sessionId);
  }

  async cleanup(): Promise<void> {
    await this.containerManager.cleanup();
    this.sessionContainers.clear();
    this.sessionConfigs.clear();
    this.containerToSession.clear();
  }
} 