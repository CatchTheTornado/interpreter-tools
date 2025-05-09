import { ContainerManager } from './container-manager';
import { ExecutionOptions, ExecutionResult, SessionConfig, ContainerStrategy } from './types';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import Docker from 'dockerode';
import { Duplex } from 'stream';
import { LanguageRegistry, LanguageConfig } from './languages';
import { tempPathForContainer } from './constants';
import * as crypto from 'crypto';

interface ContainerMeta {
  sessionId: string;
  depsInstalled: boolean;
  depsChecksum: string | null;
  baselineFiles: Set<string>;
  workspaceDir: string;
  generatedFiles: Set<string>;
  sessionGeneratedFiles: Set<string>;
  isRunning: boolean;
  createdAt: Date;
  lastExecutedAt: Date | null;
  containerId: string;
  imageName: string;
  containerName: string;
}

interface SessionInfo {
  sessionId: string;
  config: SessionConfig;
  currentContainer: {
    container: Docker.Container | undefined;
    meta: ContainerMeta | undefined;
  };
  containerHistory: ContainerMeta[];
  createdAt: Date;
  lastExecutedAt: Date | null;
  isActive: boolean;
}

class SessionManager {
  private sessionConfigs: Map<string, SessionConfig>;
  private sessionContainers: Map<string, Docker.Container | undefined>;
  private containerMeta: Map<string, ContainerMeta>;
  private sessionContainerHistory: Map<string, ContainerMeta[]>;
  private idleContainers: Map<string, Docker.Container[]>;

  constructor() {
    this.sessionConfigs = new Map();
    this.sessionContainers = new Map();
    this.containerMeta = new Map();
    this.sessionContainerHistory = new Map();
    this.idleContainers = new Map();
  }

  getSessionConfig(sessionId: string): SessionConfig | undefined {
    return this.sessionConfigs.get(sessionId);
  }

  getContainer(sessionId: string): Docker.Container | undefined {
    return this.sessionContainers.get(sessionId);
  }

  getContainerMeta(containerId: string): ContainerMeta | undefined {
    return this.containerMeta.get(containerId);
  }

  setSessionConfig(sessionId: string, config: SessionConfig): void {
    this.sessionConfigs.set(sessionId, config);
  }

  setContainer(sessionId: string, container: Docker.Container | undefined): void {
    if (container) {
      this.sessionContainers.set(sessionId, container);
    } else {
      this.sessionContainers.delete(sessionId);
    }
  }

  setContainerMeta(containerId: string, meta: ContainerMeta): void {
    this.containerMeta.set(containerId, meta);
    
    const history = this.sessionContainerHistory.get(meta.sessionId) || [];
    // Only add to history if this is a new container
    if (!history.some(h => h.containerId === meta.containerId)) {
      history.push(meta);
      this.sessionContainerHistory.set(meta.sessionId, history);
    }
  }

  hasSession(sessionId: string): boolean {
    return this.sessionConfigs.has(sessionId);
  }

  deleteSession(sessionId: string): void {
    const container = this.sessionContainers.get(sessionId);
    if (container) {
      this.containerMeta.delete(container.id);
      this.sessionContainers.delete(sessionId);
    }
    this.sessionConfigs.delete(sessionId);
    this.sessionContainerHistory.delete(sessionId);
  }

  clear(): void {
    this.sessionConfigs.clear();
    this.sessionContainers.clear();
    this.containerMeta.clear();
    this.sessionContainerHistory.clear();
  }

  getSessionIds(): string[] {
    return Array.from(this.sessionConfigs.keys());
  }

  getSessionContainerHistory(sessionId: string): ContainerMeta[] {
    return this.sessionContainerHistory.get(sessionId) || [];
  }

  async updateContainerState(containerId: string, isRunning: boolean): Promise<void> {
    const meta = this.containerMeta.get(containerId);
    if (meta) {
      meta.isRunning = isRunning;
      if (isRunning) {
        meta.lastExecutedAt = new Date();
      }
    }
  }

  addIdleContainer(sessionId: string, container: Docker.Container): void {
    const idleContainers = this.idleContainers.get(sessionId) || [];
    idleContainers.push(container);
    this.idleContainers.set(sessionId, idleContainers);
  }

  getIdleContainer(sessionId: string, image: string): Docker.Container | undefined {
    const idleContainers = this.idleContainers.get(sessionId) || [];
    for (const cont of idleContainers) {
      const meta = this.containerMeta.get(cont.id);
      if (meta && meta.imageName === image) {
        return cont;
      }
    }
    return undefined;
  }

  removeIdleContainer(sessionId: string, container: Docker.Container): void {
    const idleContainers = this.idleContainers.get(sessionId) || [];
    const filtered = idleContainers.filter(c => c.id !== container.id);
    this.idleContainers.set(sessionId, filtered);
  }

  getIdleContainers(sessionId: string): Docker.Container[] {
    return this.idleContainers.get(sessionId) || [];
  }

  clearIdleContainers(sessionId: string): void {
    this.idleContainers.delete(sessionId);
  }
}

export class ExecutionEngine {
  private containerManager: ContainerManager;
  private sessionManager: SessionManager;
  private verbosity: 'info' | 'debug';

  constructor() {
    this.containerManager = new ContainerManager();
    this.sessionManager = new SessionManager();
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

  private calculateDepsChecksum(dependencies: string[] | undefined): string {
    if (!dependencies || dependencies.length === 0) {
      return '';
    }
    const sortedDeps = [...dependencies].sort();
    return crypto.createHash('sha256').update(sortedDeps.join('|')).digest('hex');
  }

  /**
   * Centralised dependency-installation logic used by both inline and runApp paths.
   * Returns whether dependencies were installed successfully (or were already installed),
   * along with captured stdout / stderr so the caller can forward them.
   */
  private async installDependencies(
    container: Docker.Container,
    langCfg: LanguageConfig,
    options: ExecutionOptions,
    depsAlreadyInstalled: boolean,
    codePath: string,
    meta: ContainerMeta | undefined
  ): Promise<{ depsInstallationSucceeded: boolean; stdout: string; stderr: string }> {
    // Fast-path when nothing to do
    if (depsAlreadyInstalled) {
      return { depsInstallationSucceeded: true, stdout: '', stderr: '' };
    }

    this.logDebug('Installing dependencies', options.dependencies);

    let depOut = '';
    let depErr = '';
    let installSucceeded = false;

    if (langCfg.installDependencies) {
      const { stdout, stderr, exitCode } = await langCfg.installDependencies(container, options);
      depOut = stdout;
      depErr = stderr;

      this.logDebug('Dependency installation stdout:', depOut);
      this.logDebug('Dependency installation stderr:', depErr);

      if (exitCode !== 0) {
        // Surface streams if caller requested them
        if (options.streamOutput?.dependencyStdout && depOut) options.streamOutput.dependencyStdout(depOut);
        if (options.streamOutput?.dependencyStderr && depErr) options.streamOutput.dependencyStderr(depErr);
      } else {
        installSucceeded = true;
      }
    } else {
      // No explicit installer – treat as success
      installSucceeded = true;
    }

    // When installation succeeded we refresh the baseline so dependency-created files
    // are not reported as generated during this execution.
    if (installSucceeded && meta) {
      meta.baselineFiles = new Set(this.listAllFiles(codePath).filter(p => p.startsWith(codePath)));
    }

    return { depsInstallationSucceeded: installSucceeded, stdout: depOut, stderr: depErr };
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

    // Collect dependency installation output if we need to surface it later
    let dependencyStdout = '';
    let dependencyStderr = '';

    await this.sessionManager.updateContainerState(container.id, true);

    try {
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

      // Get container metadata and calculate new dependency checksum
      const meta = this.sessionManager.getContainerMeta(container.id);
      const newDepsChecksum = this.calculateDepsChecksum(options.dependencies);
      const depsAlreadyInstalled = Boolean(meta?.depsInstalled && meta?.depsChecksum === newDepsChecksum);

      // Track if dependencies installed successfully (starts with previous status)
      let depsInstallationSucceededGlobal = depsAlreadyInstalled;

      // Save current baseline before execution (this must happen *before* we start executing)
      if (meta) {
        meta.workspaceDir = codePath; // keep metadata consistent in case the container was reused
        meta.baselineFiles = new Set(this.listAllFiles(codePath).filter(p => p.startsWith(codePath)));
      }

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

        // ----- Dependency installation phase (centralised) -----
        const depResRunApp = await this.installDependencies(
          container,
          langCfgRunApp,
          options,
          depsAlreadyInstalled,
          codePath,
          meta
        );
        dependencyStdout = depResRunApp.stdout;
        dependencyStderr = depResRunApp.stderr;
        depsInstallationSucceededGlobal = depResRunApp.depsInstallationSucceeded;

        // Build command using LanguageRegistry (all languages)
        command = langCfgRunApp.buildRunAppCommand(options.runApp.entryFile, depsInstallationSucceededGlobal);
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
        if (this.verbosity === 'debug') {
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
                this.logDebug('Workspace contents:', output);
              }
            }, process.stderr);
            lsStream.on('end', resolve);
          });
        }

        // ----- Dependency installation phase (centralised) -----
        const depResInline = await this.installDependencies(
          container,
          langCfgInline,
          options,
          depsAlreadyInstalled,
          codePath,
          meta
        );
        dependencyStdout = depResInline.stdout;
        dependencyStderr = depResInline.stderr;
        depsInstallationSucceededGlobal = depResInline.depsInstallationSucceeded;

        // Build command using LanguageRegistry (all languages)
        command = langCfgInline.buildInlineCommand(depsInstallationSucceededGlobal);
      }

      this.logDebug('Executing command:', command.join(' '));

      return new Promise((resolve, reject) => {
        container.exec({
          Cmd: command,
          AttachStdout: true,
          AttachStderr: true,
          WorkingDir: workingDir
        }, (err, exec) => {
          if (err || !exec) {
            this.sessionManager.updateContainerState(container.id, false);
            reject(err || new Error('Failed to create exec instance'));
            return;
          }

          exec.start({
            hijack: true,
            stdin: false
          }, (err, stream) => {
            if (err || !stream) {
              this.sessionManager.updateContainerState(container.id, false);
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
                // Update dependency installation status and checksum when they were successfully installed during this run
                if (!depsAlreadyInstalled && depsInstallationSucceededGlobal && meta) {
                  meta.depsInstalled = true;
                  meta.depsChecksum = newDepsChecksum;
                }
                const sid = meta?.sessionId;
                let generatedFiles: string[] = [];
                if (sid) {
                  // Get newly generated files since last run
                  generatedFiles = await this.listWorkspaceFiles(sid, true);
                }

                if (meta) {
                  // Update current run's generated files
                  meta.generatedFiles = new Set<string>(generatedFiles);
                  // Add to accumulated generated files
                  if (!meta.sessionGeneratedFiles) {
                    meta.sessionGeneratedFiles = new Set<string>();
                  }
                  generatedFiles.forEach(file => meta.sessionGeneratedFiles.add(file));
                }

                const result: ExecutionResult = {
                  stdout: stdout,
                  stderr: stderr,
                  dependencyStdout: dependencyStdout,
                  dependencyStderr: dependencyStderr,
                  exitCode: info.ExitCode || 1,
                  executionTime: Date.now() - startTime,
                  workspaceDir: codePath,
                  generatedFiles,
                  sessionGeneratedFiles: meta ? Array.from(meta.sessionGeneratedFiles) : []
                };

                this.logDebug(result);
                this.sessionManager.updateContainerState(container.id, false);
                resolve(result);
              } catch (error) {
                this.sessionManager.updateContainerState(container.id, false);
                reject(error);
              }
            });
          });
        });
      });
    } catch (error) {
      this.sessionManager.updateContainerState(container.id, false);
      throw error;
    }
  }

  private async createNewContainer(
    config: SessionConfig,
    expectedImage: string,
    codePath: string
  ): Promise<{ container: Docker.Container; meta: ContainerMeta }> {
    const containerName = `it_${uuidv4()}`;
    this.logDebug('Creating container', containerName);
    
    const container = await this.containerManager.createContainer({
      ...config.containerConfig,
      name: containerName,
      image: expectedImage,
      mounts: [
        ...(config.containerConfig.mounts || []),
        {
          type: 'directory',
          source: codePath,
          target: '/workspace'
        }
      ]
    });

    const meta: ContainerMeta = {
      sessionId: config.sessionId!,
      depsInstalled: false,
      depsChecksum: null,
      baselineFiles: new Set<string>(),
      workspaceDir: codePath,
      generatedFiles: new Set<string>(),
      sessionGeneratedFiles: new Set<string>(),
      isRunning: false,
      createdAt: new Date(),
      lastExecutedAt: null,
      containerId: container.id,
      imageName: config.containerConfig.image,
      containerName
    };

    return { container, meta };
  }

  private async handleContainerImageMismatch(
    container: Docker.Container,
    expectedImage: string,
    sessionId: string,
    useSharedWorkspace: boolean
  ): Promise<boolean> {
    const containerInfo = await container.inspect();
    if (containerInfo.Config.Image !== expectedImage) {
      this.logDebug('Container image mismatch, removing container');
      // First remove the container but keep workspace if shared
      await this.containerManager.removeContainerAndDir(container, !useSharedWorkspace);
      // Then clear the session container reference
      this.sessionManager.setContainer(sessionId, undefined);
      // Don't delete the session itself as we'll create a new container
      return true;
    }
    return false;
  }

  private async prepareWorkspace(
    container: Docker.Container,
    codePath: string,
    options: ExecutionOptions,
    config: SessionConfig
  ): Promise<void> {
    const meta = this.sessionManager.getContainerMeta(container.id);
    if (meta) {
      await this.prepareCodeFile(options, codePath);
      meta.workspaceDir = codePath;
      meta.baselineFiles = new Set(this.listAllFiles(codePath).filter(p => p.startsWith(codePath)));
    }
  }

  async executeCode(sessionId: string, options: ExecutionOptions): Promise<ExecutionResult> {
    this.logDebug('Executing code', sessionId, options);
    const config = this.sessionManager.getSessionConfig(sessionId);
    if (!config) {
      throw new Error('Invalid session ID');
    }

    // Guard: POOL strategy does not support shared workspaces
    if (options.workspaceSharing === 'shared') {
      const unsupportedStrategies = new Set([ContainerStrategy.POOL, ContainerStrategy.PER_EXECUTION]);
      if (unsupportedStrategies.has(config.strategy)) {
        throw new Error(`workspaceSharing "shared" is not supported with ContainerStrategy.${config.strategy}. ` +
          `Use PER_SESSION for a persistent workspace.`);
      }
    }

    let codePath: string = '';
    let container: Docker.Container;

    try {
      // Get the expected image for this execution
      const expectedImage = this.getContainerImage(options.language) || config.containerConfig.image;

      // Determine if we should use a shared workspace
      const useSharedWorkspace = options.workspaceSharing === 'shared';
      let sharedWorkspacePath: string | undefined;

      if (useSharedWorkspace) {
        // Get or create shared workspace path for this session
        const sessionMeta = this.sessionManager.getSessionConfig(sessionId);
        if (sessionMeta) {
          const existingContainer = this.sessionManager.getContainer(sessionId);
          if (existingContainer) {
            const existingMeta = this.sessionManager.getContainerMeta(existingContainer.id);
            if (existingMeta) {
              sharedWorkspacePath = existingMeta.workspaceDir;
            }
          }
        }
        if (!sharedWorkspacePath) {
          // Create new shared workspace if none exists
          const containerName = `it_${uuidv4()}`;
          sharedWorkspacePath = tempPathForContainer(containerName);
          fs.mkdirSync(sharedWorkspacePath, { recursive: true });
        }
      }

      switch (config.strategy) {
        case ContainerStrategy.PER_EXECUTION: {
          const containerName = `it_${uuidv4()}`;
          codePath = tempPathForContainer(containerName);
          await this.prepareCodeFile(options, codePath);

          const { container: newContainer, meta } = await this.createNewContainer(config, expectedImage, codePath);
          container = newContainer;
          this.sessionManager.setContainer(sessionId, container);
          this.sessionManager.setContainerMeta(container.id, meta);
          break;
        }

        case ContainerStrategy.POOL: {
          let sessionContainer = this.sessionManager.getContainer(sessionId);
          
          if (sessionContainer) {
            if (await this.handleContainerImageMismatch(sessionContainer, expectedImage, sessionId, false)) {
              sessionContainer = undefined;
            }
          }

          if (!sessionContainer) {
            const pooledContainer = await this.containerManager.getContainerFromPool(expectedImage);
            if (!pooledContainer) {
              const containerName = `it_${uuidv4()}`;
              codePath =  tempPathForContainer(containerName);
              //await this.prepareCodeFile(options, codePath);
              const { container: newContainer, meta } = await this.createNewContainer(config, expectedImage, codePath);
              sessionContainer = newContainer;
              this.sessionManager.setContainerMeta(sessionContainer.id, meta);
            } else {
              sessionContainer = pooledContainer;
              const existingMeta = this.sessionManager.getContainerMeta(sessionContainer.id);
              if (existingMeta) {
                existingMeta.sessionId = sessionId;
              } else {
                this.sessionManager.setContainerMeta(sessionContainer.id, {
                  sessionId,
                  depsInstalled: false,
                  depsChecksum: null,
                  baselineFiles: new Set<string>(),
                  workspaceDir: useSharedWorkspace ? sharedWorkspacePath! : this.getWorkspaceDir(sessionContainer),
                  generatedFiles: new Set<string>(),
                  sessionGeneratedFiles: new Set<string>(),
                  isRunning: false,
                  createdAt: new Date(),
                  lastExecutedAt: null,
                  containerId: sessionContainer.id,
                  imageName: expectedImage,
                  containerName: sessionContainer.id
                });
              }
            }
            this.sessionManager.setContainer(sessionId, sessionContainer);
          }
          container = sessionContainer;
          break;
        }

        case ContainerStrategy.PER_SESSION: {
          let sessionContainer = this.sessionManager.getContainer(sessionId);
          
          if (useSharedWorkspace) {
            // Shared workspace: keep mismatched containers for potential reuse later
            if (sessionContainer) {
              const info = await sessionContainer.inspect();
              if (info.Config.Image !== expectedImage) {
                // Stop and store current container for future reuse
                try { await sessionContainer.stop(); } catch {}
                this.sessionManager.addIdleContainer(sessionId, sessionContainer);
                sessionContainer = undefined;
              }
            }

            // Try to find an idle container with the expected image
            if (!sessionContainer) {
              const idle = this.sessionManager.getIdleContainer(sessionId, expectedImage);
              if (idle) {
                sessionContainer = idle;
                await this.ensureContainerRunning(sessionContainer);
                // remove from idle list
                this.sessionManager.removeIdleContainer(sessionId, idle);
                this.sessionManager.setContainer(sessionId, sessionContainer);
              }
            }
          } else {
            // Non-shared workspace: old mismatch logic
            if (sessionContainer) {
              if (await this.handleContainerImageMismatch(sessionContainer, expectedImage, sessionId, false)) {
                sessionContainer = undefined;
              }
            }
          }

          if (!sessionContainer) {
            this.logDebug('Creating new container for per session strategy', sessionId, expectedImage);
            const containerName = `it_${uuidv4()}`;
            const codeDir = useSharedWorkspace ? sharedWorkspacePath! : tempPathForContainer(containerName);
            if (!useSharedWorkspace) {
              fs.mkdirSync(codeDir, { recursive: true });
            }
            const { container: newContainer, meta } = await this.createNewContainer(config, expectedImage, codeDir);
            sessionContainer = newContainer;
            this.sessionManager.setContainer(sessionId, sessionContainer);
            this.sessionManager.setContainerMeta(sessionContainer.id, {
              sessionId,
              depsInstalled: false,
              depsChecksum: null,
              baselineFiles: new Set<string>(),
              workspaceDir: codeDir,
              generatedFiles: new Set<string>(),
              sessionGeneratedFiles: new Set<string>(),
              isRunning: false,
              createdAt: new Date(),
              lastExecutedAt: null,
              containerId: sessionContainer.id,
              imageName: expectedImage,
              containerName: containerName
            });
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
        codePath = useSharedWorkspace ? sharedWorkspacePath! : tempPathForContainer(info.Name.replace('/', ''));
      }

      // For PER_SESSION strategy prepare workspace only on first execution
      if (config.strategy === ContainerStrategy.PER_SESSION || config.strategy === ContainerStrategy.POOL) {
        await this.prepareWorkspace(container, codePath, options, config);
      }

      const result = await this.executeInContainer(container, options, config, codePath);

      if (config.strategy === ContainerStrategy.PER_EXECUTION) {
        await this.containerManager.removeContainerAndDir(container);
        this.sessionManager.deleteSession(sessionId);
      }

      return result;
    } finally {
      /* workspace retained for inspection; cleaned during container removal */
    }
  }

  async cleanupSession(sessionId: string, keepGeneratedFiles: boolean = false): Promise<void> {
    this.logDebug('Cleaning up session', sessionId);
    const container = this.sessionManager.getContainer(sessionId);
    const config = this.sessionManager.getSessionConfig(sessionId);
    this.logDebug('Keep generated files?', keepGeneratedFiles);
    if (container) {
      if (config?.strategy === ContainerStrategy.POOL) {
        // Return container to pool after cleaning up workspace via ContainerManager
        await this.containerManager.returnContainerToPool(container);
      } else {
        let deleteDir = true;
        if (keepGeneratedFiles) {
          try {
            const metaForCleanup = this.sessionManager.getContainerMeta(container.id);
            const generatedArr = metaForCleanup ? Array.from(metaForCleanup.sessionGeneratedFiles) : [];
            this.logDebug('Keeping generated files', generatedArr);
            if (generatedArr.length > 0) {
              // Keep directory, just remove non-generated files
              const keepSet = new Set<string>(generatedArr);
              this.cleanWorkspaceKeepGenerated(container, keepSet);
              deleteDir = false;
            }
          } catch {}
        }
        await this.containerManager.removeContainerAndDir(container, deleteDir);
      }
      this.sessionManager.deleteSession(sessionId);
    }

    // Remove any idle containers kept for this session
    const idleList = this.sessionManager.getIdleContainers(sessionId);
    for (const idle of idleList) {
      await this.containerManager.removeContainerAndDir(idle, !keepGeneratedFiles);
    }
    this.sessionManager.clearIdleContainers(sessionId);
  }

  async cleanup(keepGeneratedFiles: boolean = false): Promise<void> {
    // Clean each session respecting generated files flag
    for (const sid of this.sessionManager.getSessionIds()) {
      await this.cleanupSession(sid, keepGeneratedFiles);
    }
    // Finally, let container manager perform global cleanup (this only affects containers
    // not tracked in sessionContainers; it will still delete their workspaces.)
    if (!keepGeneratedFiles) {
      await this.containerManager.cleanup();
    }
    this.sessionManager.clear();
  }

  private getWorkspaceDir(container: Docker.Container): string {
    const meta = this.sessionManager.getContainerMeta(container.id);
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

  private cleanWorkspaceKeepGenerated(container: Docker.Container, generatedFiles: Set<string>): void {
    const workspaceDir = this.getWorkspaceDir(container);
    const all = this.listAllFiles(workspaceDir);
    for (const file of all) {
      if (!generatedFiles.has(file)) {
        try {
          fs.rmSync(file, { force: true });
        } catch {}
      }
    }
    // Remove empty dirs (bottom-up)
    const dirs = all.map(p => path.dirname(p)).sort((a, b) => b.length - a.length);
    for (const dir of dirs) {
      if (dir === workspaceDir) continue;
      try {
        if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
          fs.rmdirSync(dir, { recursive: false });
        }
      } catch {}
    }
  }

  // Public helpers
  async listWorkspaceFiles(sessionId: string, onlyGenerated = false): Promise<string[]> {
    const container = this.sessionManager.getContainer(sessionId);
    if (!container) throw new Error('Session not found');
    const workspaceDir = this.getWorkspaceDir(container);
    const currentFiles = this.listAllFiles(workspaceDir);

    if (!onlyGenerated) return currentFiles;

    const baseline = this.sessionManager.getContainerMeta(container.id)?.baselineFiles ?? new Set<string>();
    return currentFiles.filter(p => p.startsWith(workspaceDir) && !baseline.has(p));
  }

  async addFileFromBase64(sessionId: string, relativePath: string, dataBase64: string): Promise<void> {
    const container = this.sessionManager.getContainer(sessionId);
    if (!container) throw new Error('Session not found');
    const workspaceDir = this.getWorkspaceDir(container);
    const fullPath = path.join(workspaceDir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    const buffer = Buffer.from(dataBase64, 'base64');
    fs.writeFileSync(fullPath, buffer);
  }

  async copyFileIntoWorkspace(sessionId: string, localPath: string, destRelativePath: string): Promise<void> {
    const container = this.sessionManager.getContainer(sessionId);
    if (!container) throw new Error('Session not found');
    const workspaceDir = this.getWorkspaceDir(container);
    const dest = path.join(workspaceDir, destRelativePath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(localPath, dest);
  }

  async readFileBase64(sessionId: string, relativePath: string): Promise<string> {
    const container = this.sessionManager.getContainer(sessionId);
    if (!container) throw new Error('Session not found');
    const workspaceDir = this.getWorkspaceDir(container);
    const fullPath = path.join(workspaceDir, relativePath);
    return fs.readFileSync(fullPath).toString('base64');
  }

  async readFileBinary(sessionId: string, relativePath: string): Promise<Buffer> {
    const container = this.sessionManager.getContainer(sessionId);
    if (!container) throw new Error('Session not found');
    const workspaceDir = this.getWorkspaceDir(container);
    return fs.readFileSync(path.join(workspaceDir, relativePath));
  }

  async getSessionInfo(sessionId: string): Promise<SessionInfo> {
    const config = this.sessionManager.getSessionConfig(sessionId);
    if (!config) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const container = this.sessionManager.getContainer(sessionId);
    const containerMeta = container ? this.sessionManager.getContainerMeta(container.id) : undefined;
    const containerHistory = this.sessionManager.getSessionContainerHistory(sessionId);

    // Calculate session-level timestamps
    const createdAt = containerHistory.length > 0 
      ? containerHistory[0].createdAt 
      : new Date();
    
    const lastExecutedAt = containerHistory.length > 0
      ? containerHistory.reduce((latest, meta) => {
          if (!meta.lastExecutedAt) return latest;
          return !latest || meta.lastExecutedAt > latest 
            ? meta.lastExecutedAt 
            : latest;
        }, null as Date | null)
      : null;

    return {
      sessionId,
      config,
      currentContainer: {
        container,
        meta: containerMeta
      },
      containerHistory,
      createdAt,
      lastExecutedAt,
      isActive: Boolean(container && containerMeta?.isRunning)
    };
  }

  async createSession(config: SessionConfig): Promise<string> {
    const sessionId = config.sessionId ?? uuidv4();

    if (this.sessionManager.hasSession(sessionId)) {
      if (config.enforceNewSession) {
        throw new Error(`Session ID ${sessionId} already exists`);
      }
      this.logDebug('Reusing existing session', sessionId);
      return sessionId; // reuse existing session
    }

    this.logDebug('Creating session', sessionId, 'strategy', config.strategy);

    this.sessionManager.setSessionConfig(sessionId, config);

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
      this.sessionManager.setContainer(sessionId, container);
      this.sessionManager.setContainerMeta(container.id, {
        sessionId,
        depsInstalled: false,
        depsChecksum: null,
        baselineFiles: new Set<string>(),
        workspaceDir: codeDir,
        generatedFiles: new Set<string>(),
        sessionGeneratedFiles: new Set<string>(),
        isRunning: false,
        createdAt: new Date(),
        lastExecutedAt: null,
        containerId: container.id,
        imageName: config.containerConfig.image,
        containerName: containerName
      });
    }

    return sessionId;
  }

  private async ensureContainerRunning(container: Docker.Container): Promise<void> {
    try {
      const info = await container.inspect();
      if (!info.State.Running) {
        await container.start();
      }
    } catch {}
  }
} 