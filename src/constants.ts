import * as fs from 'fs';
import * as path from 'path';

export const BASE_TMP_DIR = '/tmp/interpreter-tools';

// Ensure base directory exists at module load
fs.mkdirSync(BASE_TMP_DIR, { recursive: true });

export function tempPathForContainer(containerName: string): string {
  return path.join(BASE_TMP_DIR, containerName);
} 