import { ExecutionEngine, ContainerStrategy } from '../src';

async function main() {
  const engine = new ExecutionEngine();
  const rounds = 20;
  const executionTimes: number[] = [];

  try {
    // Create a session that uses the container pool
    const sessionId = await engine.createSession({
      strategy: ContainerStrategy.POOL,
      containerConfig: {
        image: 'node:18-alpine',
        environment: {
          NODE_ENV: 'production'
        }
      }
    });

    console.log(`Running benchmark with ${rounds} rounds...`);

    for (let i = 1; i <= rounds; i++) {
      const result = await engine.executeCode(sessionId, {
        language: 'javascript',
        code: `
const numbers = [1, 2, 3, 4, 5];
const sum = numbers.reduce((a, b) => a + b, 0);
const average = sum / numbers.length;
console.log('Round ${i}:', { sum, average });
        `,
        streamOutput: {
          stdout: (data) => process.stdout.write(data),
          stderr: (data) => process.stderr.write(data)
        }
      });

      console.log(`Round ${i} execution time: ${result.executionTime} ms`);
      executionTimes.push(result.executionTime);
    }

    const totalTime = executionTimes.reduce((a, b) => a + b, 0);
    const averageTime = totalTime / rounds;

    console.log('====================================');
    console.log('Benchmark results:');
    console.log(`Total time for ${rounds} rounds: ${totalTime} ms`);
    console.log(`Average time per round: ${averageTime.toFixed(2)} ms`);
  } catch (error) {
    console.error('Error during benchmark:', error);
  } finally {
    await engine.cleanup();
  }
}

main(); 