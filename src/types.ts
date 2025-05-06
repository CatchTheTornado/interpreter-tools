export type Language = 'typescript' | 'javascript' | 'python' | 'shell';

export interface ExecutionOptions {
  language: Language;
  code: string;
  dependencies?: string[];
  timeout?: number;
  memoryLimit?: string;
  cpuLimit?: string;
  verbose?: boolean;
  runApp?: {
    cwd: string;
    entryFile: string;  // Path to the entry file relative to the mounted directory
  };
  streamOutput?: {
    stdout?: (data: string) => void;
    stderr?: (data: string) => void;
  };
}

export interface MountOptions {
  type: 'file' | 'directory' | 'zip';
  source: string;
  target: string;
}

export interface ContainerConfig {
  image: string;
  mounts?: MountOptions[];
  environment?: Record<string, string>;
}

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  executionTime: number;
}

export interface ContainerPoolConfig {
  maxSize: number;
  minSize: number;
  idleTimeout: number;
}

export enum ContainerStrategy {
  PER_EXECUTION = 'per_execution',
  POOL = 'pool',
  PER_SESSION = 'per_session'
}

export interface SessionConfig {
  strategy: ContainerStrategy;
  poolConfig?: ContainerPoolConfig;
  containerConfig: ContainerConfig;
}

export interface ContainerMount {
  type: 'directory';
  source: string;
  target: string;
} 