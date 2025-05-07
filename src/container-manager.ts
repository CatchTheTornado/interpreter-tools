import Docker from 'dockerode';
import { v4 as uuidv4 } from 'uuid';
import { ContainerConfig, ContainerPoolConfig, ContainerStrategy, MountOptions } from './types';
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { BASE_TMP_DIR, tempPathForContainer } from './constants';

interface PooledContainer {
  container: Docker.Container;
  inUse: boolean;
  lastUsed: number;
}

export class ContainerManager {
  private docker: Docker;
  private containers: Map<string, Docker.Container>;
  private pool: PooledContainer[];
  private poolConfig: ContainerPoolConfig;

  constructor() {
    this.docker = new Docker();
    this.containers = new Map();
    this.pool = [];
    this.poolConfig = {
      maxSize: 5,
      minSize: 2,
      idleTimeout: 300000 // 5 minutes
    };
  }

  private async setupMounts(mounts: MountOptions[]): Promise<Docker.MountSettings[]> {
    const dockerMounts: Docker.MountSettings[] = [];

    for (const mount of mounts) {
      switch (mount.type) {
        case 'file':
          if (fs.existsSync(mount.source)) {
            dockerMounts.push({
              Target: mount.target,
              Source: mount.source,
              Type: 'bind',
              ReadOnly: true
            });
          }
          break;

        case 'directory':
          if (fs.existsSync(mount.source)) {
            dockerMounts.push({
              Target: mount.target,
              Source: mount.source,
              Type: 'bind',
              ReadOnly: false
            });
          }
          break;

        case 'zip':
          const tempDir = path.join('/tmp', uuidv4());
          fs.mkdirSync(tempDir, { recursive: true });
          
          const zip = new AdmZip(mount.source);
          zip.extractAllTo(tempDir, true);
          
          dockerMounts.push({
            Target: mount.target,
            Source: tempDir,
            Type: 'bind',
            ReadOnly: false
          });
          break;
      }
    }

    return dockerMounts;
  }

  async createContainer(config: ContainerConfig): Promise<Docker.Container> {
    // Pull the image if it doesn't exist
    try {
      await new Promise<void>((resolve, reject) => {
        this.docker.pull(config.image, (err: Error | null, stream: NodeJS.ReadableStream) => {
          if (err) {
            reject(err);
            return;
          }

          this.docker.modem.followProgress(stream, (err: Error | null) => {
            if (err) {
              reject(err);
              return;
            }
            resolve();
          });
        });
      });
    } catch (error) {
      console.error(`Error pulling image ${config.image}:`, error);
      throw error;
    }

    const containerName = config.name ?? `it_${uuidv4()}`;

    // Create workspace directory for this container
    fs.mkdirSync(tempPathForContainer(containerName), { recursive: true });

    const container = await this.docker.createContainer({
      name: containerName,
      Image: config.image,
      Tty: true,
      HostConfig: {
        SecurityOpt: ['no-new-privileges'],
        Memory: 512 * 1024 * 1024, // 512MB
        CpuPeriod: 100000,
        CpuQuota: 50000,
        NetworkMode: 'bridge',
        Mounts: config.mounts?.map(mount => ({
          Target: mount.target,
          Source: mount.source,
          Type: 'bind',
          ReadOnly: false
        })) || []
      },
      WorkingDir: '/workspace',
      Cmd: ['sh', '-c', 'mkdir -p /workspace && tail -f /dev/null']
    });

    await container.start();

    // Track created container
    this.containers.set(container.id, container);
    return container;
  }


  private imageMatches(expected: string, actual: string): boolean {
    // Simple check: ignore registry prefix and compare repository name and tag
    const strip = (img: string) => img.replace(/^.*\//, '');
    return strip(actual) === strip(expected);
  }
  
  async getContainerFromPool(expectedImage?: string): Promise<Docker.Container | null> {
    // First, try to find an available container that's not in use
    let availableContainer: PooledContainer | undefined;

    if (expectedImage) {
      // Find container that matches expected image
      for (const c of this.pool) {
        if (c.inUse) continue;
        try {
          const inspectInfo = await c.container.inspect();
          if (this.imageMatches(expectedImage, inspectInfo.Config.Image)) {
            availableContainer = c;
            break;
          }
        } catch (err) {
          console.error('Error inspecting pooled container:', err);
        }
      }
    } else {
      availableContainer = this.pool.find(c => !c.inUse);
    }
    if (availableContainer) {
      availableContainer.inUse = true;
      availableContainer.lastUsed = Date.now();
      
      try {
        // Start the container only if it is not already running
        const inspectInfo = await availableContainer.container.inspect();
        if (!inspectInfo.State.Running) {
          await availableContainer.container.start();
        }
        // Clean workspace
        const exec = await availableContainer.container.exec({
          Cmd: ['sh', '-c', 'rm -rf /workspace/*'],
          AttachStdout: true,
          AttachStderr: true
        });
        const stream = await exec.start({ hijack: true, stdin: false });

        // Wait for cleanup to complete before reusing container
        const cleanupSucceeded: boolean = await new Promise<boolean>((resolve) => {
          stream.on('end', async () => {
            try {
              const info = await exec.inspect();
              resolve((info.ExitCode ?? 1) === 0);
            } catch {
              resolve(false);
            }
          });
        });

        if (cleanupSucceeded) {
          return availableContainer.container;
        } else {
          console.warn('Workspace cleanup failed, removing container from pool');
          // Remove failed container
          await this.removeContainerAndDir(availableContainer.container);
          this.pool = this.pool.filter(c => c.container !== availableContainer.container);
          return null;
        }
      } catch (error) {
        console.error('Error starting pooled container:', error);
        // Remove failed container from pool
        this.pool = this.pool.filter(c => c.container !== availableContainer.container);
        return null;
      }
    }

    // If no available container and pool is not full, create a new one
    if (this.pool.length < this.poolConfig.maxSize) {
      try {
        const container = await this.createContainer({
          image: expectedImage ?? 'node:18-alpine', // Default image, will be changed by execution engine
          mounts: []
        });
        
        this.pool.push({
          container,
          inUse: true,
          lastUsed: Date.now()
        });
        
        return container;
      } catch (error) {
        console.error('Error creating new container for pool:', error);
        return null;
      }
    }

    return null;
  }

  async returnContainerToPool(container: Docker.Container): Promise<void> {
    const pooledContainer = this.pool.find(c => c.container === container);
    if (!pooledContainer) {
      await container.remove({ force: true });
      return;
    }

    // Clean up the workspace
    try {
      const exec = await container.exec({
        Cmd: ['sh', '-c', 'rm -rf /workspace/*'],
        AttachStdout: true,
        AttachStderr: true
      });
      const stream = await exec.start({ hijack: true, stdin: false });

      // Wait for cleanup to finish
      const cleanupOk: boolean = await new Promise<boolean>((resolve) => {
        stream.on('end', async () => {
          try {
            const info = await exec.inspect();
            resolve((info.ExitCode ?? 1) === 0);
          } catch {
            resolve(false);
          }
        });
      });

      if (cleanupOk) {
        // Mark container as available
        pooledContainer.inUse = false;
        pooledContainer.lastUsed = Date.now();
      } else {
        console.warn('Workspace cleanup failed in returnContainerToPool, removing container');
        await this.removeContainerAndDir(container);
        this.pool = this.pool.filter(c => c.container !== container);
        return; // exit early
      }

      // Check pool maintenance using the image of this container for new instances
      try {
        const inspectInfo = await container.inspect();
        await this.cleanupPool(inspectInfo.Config.Image);
      } catch (err) {
        console.error('Failed to inspect container for pool refill:', err);
        await this.cleanupPool();
      }
    } catch (error) {
      console.error('Error cleaning workspace:', error);
      // Remove failed container from pool
      this.pool = this.pool.filter(c => c.container !== container);
      await this.removeContainerAndDir(container);
    }
  }

  private async cleanupPool(baseImage?: string): Promise<void> {
    const now = Date.now();
    
    // Remove containers that exceed idle timeout
    const containersToRemove = this.pool.filter(c => 
      !c.inUse && (now - c.lastUsed) > this.poolConfig.idleTimeout
    );
    
    for (const { container } of containersToRemove) {
      try {
        await this.removeContainerAndDir(container);
        this.pool = this.pool.filter(c => c.container !== container);
      } catch (error) {
        console.error('Error removing idle container:', error);
      }
    }
    
    // Ensure minimum pool size
    while (this.pool.length < this.poolConfig.minSize) {
      try {
        const container = await this.createContainer({
          image: baseImage ?? 'node:18-alpine', // Default image, will be changed by execution engine
          mounts: []
        });
        
        this.pool.push({
          container,
          inUse: false,
          lastUsed: now
        });
      } catch (error) {
        console.error('Error creating container for minimum pool size:', error);
        break;
      }
    }
  }

  async cleanup(): Promise<void> {
    for (const container of this.containers.values()) {
      await this.removeContainerAndDir(container);
    }
    this.containers.clear();

    for (const { container } of this.pool) {
      await this.removeContainerAndDir(container);
    }
    this.pool = [];

    // Final sweep: remove any stopped containers left with the it_ prefix
    try {
      const all = await this.docker.listContainers({ all: true });
      for (const info of all) {
        const hasPrefix = info.Names?.some(n => /\/it_/i.test(n));
        const isRunning = info.State === 'running' || info.State === 'restarting';
        if (hasPrefix && !isRunning) {
          try {
            const leftoverContainer = this.docker.getContainer(info.Id);
            await leftoverContainer.remove({ force: true });
            const cname = (info.Names && info.Names[0]) ? info.Names[0].replace('/', '') : undefined;
            if (cname) {
              fs.rmSync(tempPathForContainer(cname), { recursive: true, force: true });
            }
          } catch (err) {
            console.error('Error removing leftover it_ container:', err);
          }
        }
      }
    } catch (err) {
      console.error('Error during final it_ container sweep:', err);
    }
  }

  async removeContainerAndDir(container: Docker.Container): Promise<void> {
    try {
      const info = await container.inspect();
      await container.remove({ force: true });
      const cname = info.Name.replace('/', '');
      fs.rmSync(tempPathForContainer(cname), { recursive: true, force: true });

      // Remove from tracking structures if present
      this.containers.delete(container.id);
      this.pool = this.pool.filter(c => c.container !== container);
    } catch (err) {
      console.error('Error removing container and dir:', err);
    }
  }
} 