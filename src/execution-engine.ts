import { ContainerManager } from './container-manager';
import { ExecutionOptions, ExecutionResult, SessionConfig, ContainerStrategy } from './types';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import Docker from 'dockerode';
import { Duplex } from 'stream';
import { LanguageRegistry } from './languages';
import { tempPathForContainer } from './constants';

interface ContainerMeta {
  sessionId: string;
  depsInstalled: boolean;
  baselineFiles: Set<string>;
  workspaceDir: string;
}

export class ExecutionEngine {
  private containerManager: ContainerManager;
  private sessionContainers: Map<string, Docker.Container>;
  private sessionConfigs: Map<string, SessionConfig>;
  private containerMeta: Map<string, ContainerMeta>;
  private verbosity: 'info' | 'debug';

  constructor() {
    this.containerManager = new ContainerManager();
    this.sessionContainers = new Map();
    this.sessionConfigs = new Map();
    this.containerMeta = new Map();
    this.verbosity = 'info';
  }

  setVerbosity(level: 'info' | 'debug') {
    this.verbosity = level;
  }

  private logDebug(...args: any[]) {
    if (this.verbosity === 'debug') {
      console.log('[ExecutionEngine]', ...args);
    }
  }

  private async prepareCodeFile(options: ExecutionOptions, tempDir: string): Promise<void> {
    fs.mkdirSync(tempDir, { recursive: true });

    this.logDebug('Preparing code files in', tempDir);

    const langCfg = LanguageRegistry.get(options.language);
    if (!langCfg) {
      throw new Error(`Unsupported language: ${options.language}`);
    }

    this.logDebug('Source code:\n', options.code);

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
    const meta = this.containerMeta.get(container.id);
    const depsAlreadyInstalled = meta?.depsInstalled ?? false;

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

      this.logDebug('Installing dependencies', options.dependencies);
      // If the language defines a dependency installation step, run it first.
      if (langCfgInline.installDependencies) {
        await langCfgInline.installDependencies(container, options);
      }

      // Build command using LanguageRegistry (all languages)
      command = langCfgInline.buildInlineCommand(depsAlreadyInstalled);
    }

    this.logDebug('Executing command:', command.join(' '));

    // Save baseline for generated file tracking (only workspace files)
    if (meta) {
      meta.baselineFiles = new Set(this.listAllFiles(codePath).filter(p => p.startsWith(codePath)));
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
              if (!depsAlreadyInstalled && meta) {
                meta.depsInstalled = true;
              }
              const sid = meta?.sessionId;
              let generatedFiles: string[] = [];
              if (sid) {
                // listWorkspaceFiles updates baseline internally, so call first
                generatedFiles = await this.listWorkspaceFiles(sid, true);
              }

              const result: ExecutionResult = {
                stdout,
                stderr,
                exitCode: info.ExitCode || 1,
                executionTime: Date.now() - startTime,
                workspaceDir: codePath,
                generatedFiles
              };

              // Save baseline for generated file tracking (only workspace files)
              if (meta) {
                meta.baselineFiles = new Set(this.listAllFiles(codePath).filter(p => p.startsWith(codePath)));
              }
              this.logDebug(result);
              resolve(result);
            } catch (error) {
              reject(error);
            }
          });
        });
      });
    });
  }

  async createSession(config: SessionConfig): Promise<string> {
    const sessionId = config.sessionId ?? uuidv4();

    if (this.sessionConfigs.has(sessionId)) {
      if (config.enforceNewSession) {
        throw new Error(`Session ID ${sessionId} already exists`);
      }
      this.logDebug('Reusing existing session', sessionId);
      return sessionId; // reuse existing session
    }

    this.logDebug('Creating session', sessionId, 'strategy', config.strategy);

    this.sessionConfigs.set(sessionId, config);

    if (config.strategy === ContainerStrategy.PER_SESSION) {
      const containerName = `it_${uuidv4()}`;
      this.logDebug('Creating container', containerName);
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
      this.containerMeta.set(container.id, {
        sessionId,
        depsInstalled: false,
        baselineFiles: new Set<string>(),
        workspaceDir: codeDir
      });
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
          this.logDebug('Creating container', containerName);
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
          this.sessionContainers.set(sessionId, container);
          this.containerMeta.set(container.id, {
            sessionId,
            depsInstalled: false,
            baselineFiles: new Set<string>(),
            workspaceDir: codePath
          });
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
              this.logDebug('Creating container', newName);
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
            const existingMeta = this.containerMeta.get(sessionContainer.id);
            if (existingMeta) {
              existingMeta.sessionId = sessionId;
              if (codePath.length) existingMeta.workspaceDir = codePath;
            } else {
              this.containerMeta.set(sessionContainer.id, {
                sessionId,
                depsInstalled: false,
                baselineFiles: new Set<string>(),
                workspaceDir: codePath.length ? codePath : this.getWorkspaceDir(sessionContainer)
              });
            }
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

      // If codePath still empty (reused container), infer from container name
      if (!codePath) {
        const info = await container.inspect();
        codePath = tempPathForContainer(info.Name.replace('/', ''));
      }

      // For PER_SESSION strategy prepare workspace only on first execution
      if (config.strategy === ContainerStrategy.PER_SESSION) {
        const metaPrepare = this.containerMeta.get(container.id);
        if (metaPrepare && metaPrepare.baselineFiles.size === 0) {
          await this.prepareCodeFile(options, codePath);
          metaPrepare.baselineFiles = new Set(this.listAllFiles(codePath).filter(p => p.startsWith(codePath)));
        }
      }

      const result = await this.executeInContainer(container, options, config, codePath);

      if (config.strategy === ContainerStrategy.POOL) {
        // Do nothing here; container remains assigned for session lifetime.
      } else if (config.strategy === ContainerStrategy.PER_EXECUTION) {
        await this.containerManager.removeContainerAndDir(container);
        this.containerMeta.delete(container.id);
        this.sessionContainers.delete(sessionId);
      }

      return result;
    } finally {
      /* workspace retained for inspection; cleaned during container removal */
    }
  }

  async cleanupSession(sessionId: string): Promise<void> {
    this.logDebug('Cleaning up session', sessionId);
    const container = this.sessionContainers.get(sessionId);
    const config = this.sessionConfigs.get(sessionId);

    if (container) {
      if (config?.strategy === ContainerStrategy.POOL) {
        // Return container to pool after cleaning up workspace via ContainerManager
        await this.containerManager.returnContainerToPool(container);
      } else {
        await this.containerManager.removeContainerAndDir(container);
      }
      this.sessionContainers.delete(sessionId);
      this.containerMeta.delete(container.id);
    }
    this.sessionConfigs.delete(sessionId);
  }

  async cleanup(): Promise<void> {
    await this.containerManager.cleanup();
    this.sessionContainers.clear();
    this.sessionConfigs.clear();
    this.containerMeta.clear();
  }

  private  getWorkspaceDir(container: Docker.Container): string {
    const meta = this.containerMeta.get(container.id);
    if (meta) return meta.workspaceDir;
    const cnameRaw = (container as any).name ?? '';
    const cname = cnameRaw.startsWith('/') ? cnameRaw.slice(1) : cnameRaw;
    return tempPathForContainer(cname);
  }

  private listAllFiles(dir: string): string[] {
    const results: string[] = [];
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        results.push(...this.listAllFiles(fullPath));
      } else {
        results.push(fullPath);
      }
    }
    return results;
  }

  // Public helpers
  async listWorkspaceFiles(sessionId: string, onlyGenerated = false): Promise<string[]> {
    const container = this.sessionContainers.get(sessionId);
    if (!container) throw new Error('Session not found');
    const workspaceDir = this.getWorkspaceDir(container);
    const currentFiles = this.listAllFiles(workspaceDir);

    if (!onlyGenerated) return currentFiles;

    const baseline = this.containerMeta.get(container.id)?.baselineFiles ?? new Set<string>();
    return currentFiles.filter(p => p.startsWith(workspaceDir) && !baseline.has(p));
  }

  async addFileFromBase64(sessionId: string, relativePath: string, dataBase64: string): Promise<void> {
    const container = this.sessionContainers.get(sessionId);
    if (!container) throw new Error('Session not found');
    const workspaceDir = this.getWorkspaceDir(container);
    const fullPath = path.join(workspaceDir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    const buffer = Buffer.from(dataBase64, 'base64');
    fs.writeFileSync(fullPath, buffer);
  }

  async copyFileIntoWorkspace(sessionId: string, localPath: string, destRelativePath: string): Promise<void> {
    const container = this.sessionContainers.get(sessionId);
    if (!container) throw new Error('Session not found');
    const workspaceDir = this.getWorkspaceDir(container);
    const dest = path.join(workspaceDir, destRelativePath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(localPath, dest);
  }

  async readFileBase64(sessionId: string, relativePath: string): Promise<string> {
    const container = this.sessionContainers.get(sessionId);
    if (!container) throw new Error('Session not found');
    const workspaceDir = this.getWorkspaceDir(container);
    const fullPath = path.join(workspaceDir, relativePath);
    return fs.readFileSync(fullPath).toString('base64');
  }

  async readFileBinary(sessionId: string, relativePath: string): Promise<Buffer> {
    const container = this.sessionContainers.get(sessionId);
    if (!container) throw new Error('Session not found');
    const workspaceDir = this.getWorkspaceDir(container);
    return fs.readFileSync(path.join(workspaceDir, relativePath));
  }
} 