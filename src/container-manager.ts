import Docker from 'dockerode';
import { v4 as uuidv4 } from 'uuid';
import { ContainerConfig, ContainerPoolConfig, ContainerStrategy, MountOptions } from './types';
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';

export class ContainerManager {
  private docker: Docker;
  private containers: Map<string, Docker.Container>;
  private pool: Docker.Container[];
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
    const container = await this.docker.createContainer({
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
    return container;
  }

  async getContainerFromPool(): Promise<Docker.Container | null> {
    if (this.pool.length > 0) {
      const container = this.pool.pop() || null;
      if (container) {
        try {
          await container.start();
          // Clean workspace
          const exec = await container.exec({
            Cmd: ['sh', '-c', 'rm -rf /workspace/*'],
            AttachStdout: true,
            AttachStderr: true
          });
          await exec.start({ hijack: true, stdin: false });
        } catch (error) {
          console.error('Error starting pooled container:', error);
          return null;
        }
      }
      return container;
    }
    return null;
  }

  async returnContainerToPool(container: Docker.Container): Promise<void> {
    // Clean up the workspace
    try {
      const exec = await container.exec({
        Cmd: ['sh', '-c', 'rm -rf /workspace/*'],
        AttachStdout: true,
        AttachStderr: true
      });
      await exec.start({ hijack: true, stdin: false });
    } catch (error) {
      console.error('Error cleaning workspace:', error);
    }
    if (this.pool.length < this.poolConfig.maxSize) {
      this.pool.push(container);
    } else {
      await container.remove({ force: true });
    }
  }

  async cleanup(): Promise<void> {
    for (const container of this.containers.values()) {
      try {
        await container.remove({ force: true });
      } catch (error) {
        console.error('Error removing container:', error);
      }
    }
    this.containers.clear();

    for (const container of this.pool) {
      try {
        await container.remove({ force: true });
      } catch (error) {
        console.error('Error removing pool container:', error);
      }
    }
    this.pool = [];
  }
} 