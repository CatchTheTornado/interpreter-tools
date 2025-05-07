import { ExecutionEngine, ContainerStrategy, Language } from '../src';
import * as path from 'path';

async function main() {
  const engine = new ExecutionEngine();

  let sessionId: string | undefined = ''
  try {
    // Create a session with per-session strategy
    sessionId = await engine.createSession({
      strategy: ContainerStrategy.PER_SESSION,
      containerConfig: {
        image: 'python:3.9-slim',
        mounts: [
          {
            type: 'directory',
            source: path.join(__dirname, 'data'),
            target: '/app/data'
          }
        ],
        environment: {
          PYTHONUNBUFFERED: '1'
        }
      }
    });

    // Execute Python code that reads from mounted directory
    const result = await engine.executeCode(sessionId, {
      language: 'python',
      code: `import os
import json
from pathlib import Path

# Read data from mounted directory
data_dir = Path('/app/data')
for file in data_dir.glob('*.json'):
    with open(file) as f:
        data = json.load(f)
        print(f'Processing {file.name}:')
        print(json.dumps(data, indent=2))`,
      dependencies: []
    });

    console.log('Execution Result:');
    console.log('STDOUT:', result.stdout);
    console.log('STDERR:', result.stderr);
    console.log('Exit Code:', result.exitCode);
    console.log('Execution Time:', result.executionTime, 'ms');
    console.log('Container Workspace folder:', result.workspaceDir);

  } catch (error) {
    console.error('Error:', error);
  } finally {
    if (sessionId) {
      await engine.cleanupSession(sessionId);
    }
  }
}

main(); 