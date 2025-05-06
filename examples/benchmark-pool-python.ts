import { ExecutionEngine, ContainerStrategy } from '../src';

async function main() {
  const engine = new ExecutionEngine();
  const rounds = 20;
  const executionTimes: number[] = [];

  try {
    const sessionId = await engine.createSession({
      strategy: ContainerStrategy.POOL,
      containerConfig: {
        image: 'python:3.9-slim'
      }
    });

    console.log(`Running Python benchmark with ${rounds} rounds...`);

    for (let i = 1; i <= rounds; i++) {
      const result = await engine.executeCode(sessionId, {
        language: 'python',
        code: `
nums = list(range(1, 6))
sum_val = sum(nums)
avg_val = sum_val / len(nums)
print('Round', ${i}, ':', {'sum': sum_val, 'avg': avg_val})
        `,
        streamOutput: {
          stdout: (d) => process.stdout.write(d),
          stderr: (d) => process.stderr.write(d)
        }
      });

      console.log(`Round ${i} execution time: ${result.executionTime} ms`);
      executionTimes.push(result.executionTime);
    }

    const total = executionTimes.reduce((a, b) => a + b, 0);
    console.log('Average per round:', (total / rounds).toFixed(2), 'ms');
  } catch (e) {
    console.error('Benchmark error:', e);
  } finally {
    await engine.cleanup();
  }
}

main(); 