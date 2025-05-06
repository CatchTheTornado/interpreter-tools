import { ExecutionEngine, ContainerStrategy } from '../src';

async function main() {
  const engine = new ExecutionEngine();

  try {
    // Create a session with per-execution strategy
    const sessionId = await engine.createSession({
      strategy: ContainerStrategy.PER_EXECUTION,
      containerConfig: {
        image: 'alpine:3.14',
        environment: {
          TERM: 'xterm-256color'
        }
      }
    });

    // Execute shell script that uses curl
    const result = await engine.executeCode(sessionId, {
      language: 'shell',
      code: `#!/bin/sh
echo "Fetching example.com..."
curl -s https://example.com
echo "\\nDone!"`,
      dependencies: ['curl'],
      streamOutput: {
        stdout: (data) => {
          console.log('Container stdout:', data);
        },
        stderr: (data) => {
          console.error('Container stderr:', data);
        }
      }
    });

    console.log('Execution Result:');
    console.log('Exit Code:', result.exitCode);
    console.log('Execution Time:', result.executionTime, 'ms');

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await engine.cleanup();
  }
}

main(); 