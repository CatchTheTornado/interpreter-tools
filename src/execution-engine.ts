import { ContainerManager } from './container-manager';
import { ExecutionOptions, ExecutionResult, SessionConfig, ContainerStrategy } from './types';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import Docker from 'dockerode';
import { Duplex } from 'stream';
import { LanguageRegistry } from './languages';
import { BASE_TMP_DIR, tempPathForContainer } from './constants';

export class ExecutionEngine {
  private containerManager: ContainerManager;
  private sessionContainers: Map<string, Docker.Container>;
  private sessionConfigs: Map<string, SessionConfig>;
  private containerToSession: Map<string, string>;
  private depsInstalledContainers: Set<string>;

  constructor() {
    this.containerManager = new ContainerManager();
    this.sessionContainers = new Map();
    this.sessionConfigs = new Map();
    this.containerToSession = new Map();
    this.depsInstalledContainers = new Set();
  }

  private async prepareCodeFile(options: ExecutionOptions, tempDir: string): Promise<void> {
    fs.mkdirSync(tempDir, { recursive: true });

    const langCfg = LanguageRegistry.get(options.language);
    if (!langCfg) {
      throw new Error(`Unsupported language: ${options.language}`);
    }

    langCfg.prepareFiles(options, tempDir);
  }

  private getContainerImage(language: string): string {
    const cfg = LanguageRegistry.get(language);
    if (!cfg) throw new Error(`Unsupported language: ${language}`);
    return cfg.defaultImage;
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

    // Apply per-execution resource limits if specified
    if (options.cpuLimit || options.memoryLimit) {
      const updateCfg: any = {};

      // Parse memory strings like '512m', '1g', or number of bytes
      const parseMem = (val: string): number => {
        const lower = val.toLowerCase();
        if (lower.endsWith('g')) return parseInt(lower) * 1024 * 1024 * 1024;
        if (lower.endsWith('m')) return parseInt(lower) * 1024 * 1024;
        if (lower.endsWith('k')) return parseInt(lower) * 1024;
        return parseInt(lower);
      };

      if (options.memoryLimit) {
        updateCfg.Memory = parseMem(options.memoryLimit);
        updateCfg.MemorySwap = -1; // disable swap limit
      }

      if (options.cpuLimit) {
        const cpu = parseFloat(options.cpuLimit);
        if (!isNaN(cpu) && cpu > 0) {
          updateCfg.CpuPeriod = 100000;
          updateCfg.CpuQuota = Math.floor(cpu * 100000); // e.g., 0.5 -> 50000
        }
      }

      try {
        await container.update(updateCfg);
      } catch (err) {
        console.warn('Failed to update container resource limits:', err);
      }
    }

    // Determine if dependencies are already installed for this container (JS/TS)
    const depsAlreadyInstalled = this.depsInstalledContainers.has(container.id);

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
      // as it's already in the mounted directory. Build the command via the LanguageRegistry.
      const langCfgRunApp = LanguageRegistry.get(options.language);
      if (!langCfgRunApp) {
        throw new Error(`Unsupported language: ${options.language}`);
      }

      command = langCfgRunApp.buildRunAppCommand(options.runApp.entryFile, depsAlreadyInstalled);
    } else {
      // Write code directly to workspace
      // Determine the correct filename based on language
      const langCfgInline = LanguageRegistry.get(options.language)!;
      const workspaceFilename = langCfgInline.codeFilename;

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

      // If the language defines a dependency installation step, run it first.
      if (langCfgInline.installDependencies) {
        await langCfgInline.installDependencies(container, options);
      }

      // Build command using LanguageRegistry (all languages)
      command = langCfgInline.buildInlineCommand(depsAlreadyInstalled);
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
              // Mark container as having dependencies installed for future runs
              if (!depsAlreadyInstalled && (options.language === 'javascript' || options.language === 'typescript' || options.language === 'python')) {
                this.depsInstalledContainers.add(container.id);
              }
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
      const containerName = `it_${uuidv4()}`;
      const codeDir = tempPathForContainer(containerName);
      fs.mkdirSync(codeDir, { recursive: true });

      const container = await this.containerManager.createContainer({
        ...config.containerConfig,
        name: containerName,
        mounts: [
          ...(config.containerConfig.mounts || []),
          {
            type: 'directory',
            source: codeDir,
            target: '/workspace'
          }
        ]
      });
      this.sessionContainers.set(sessionId, container);
    }

    return sessionId;
  }

  async executeCode(sessionId: string, options: ExecutionOptions): Promise<ExecutionResult> {
    const config = this.sessionConfigs.get(sessionId);
    if (!config) {
      throw new Error('Invalid session ID');
    }

    let codePath: string = '';
    let container: Docker.Container;

    try {
      switch (config.strategy) {
        case ContainerStrategy.PER_EXECUTION: {
          const containerName = `it_${uuidv4()}`;
          codePath = tempPathForContainer(containerName);
          await this.prepareCodeFile(options, codePath);

          container = await this.containerManager.createContainer({
            ...config.containerConfig,
            name: containerName,
            image: config.containerConfig.image ? config.containerConfig.image : this.getContainerImage(options.language),
            mounts: [
              ...(config.containerConfig.mounts || []),
              {
                type: 'directory',
                source: codePath!,
                target: '/workspace'
              }
            ]
          });
          this.containerToSession.set(container.id, sessionId);
          break;
        }

        case ContainerStrategy.POOL: {
          // Check if a container is already assigned to this session
          let sessionContainer = this.sessionContainers.get(sessionId);
          if (!sessionContainer) {
            const expectedImage = config.containerConfig.image ? config.containerConfig.image : this.getContainerImage(options.language);
            const pooledContainer = await this.containerManager.getContainerFromPool(expectedImage);
            if (!pooledContainer) {
              // No available container, create a fresh one
              const newName = `it_${uuidv4()}`;
              codePath = tempPathForContainer(newName);
              await this.prepareCodeFile(options, codePath);

              sessionContainer = await this.containerManager.createContainer({
                ...config.containerConfig,
                name: newName,
                image: expectedImage,
                mounts: [
                  ...(config.containerConfig.mounts || []),
                  {
                    type: 'directory',
                    source: codePath!,
                    target: '/workspace'
                  }
                ]
              });
            } else {
              sessionContainer = pooledContainer;
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
      if (codePath && codePath.length) {
        fs.rmSync(codePath, { recursive: true, force: true });
      }
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