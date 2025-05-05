# Interpreter Tools

A TypeScript library for executing code in isolated Docker containers. This tool provides a secure and isolated environment for running code in various programming languages, with support for dependencies and file system access.

## Features

- Execute code in isolated Docker containers
- Support for multiple languages:
  - JavaScript/TypeScript
  - Python
  - Shell scripts
- Dependency management
- File system access through mounts
- Multiple container strategies:
  - Per execution
  - Per session
  - Pooled containers
- Vercel AI integration for AI-powered code execution

## Prerequisites

- Node.js 18 or later
- Docker
- Yarn package manager

## Installation

1. Clone the repository:
```bash
git clone https://github.com/CatchTheTornado/interpreter-tools.git
cd interpreter-tools
```

2. Install dependencies:
```bash
yarn install
```

3. Build the project:
```bash
yarn build
```

## Usage

### Basic JavaScript Example

```typescript
import { ExecutionEngine, ContainerStrategy } from 'interpreter-tools';

async function main() {
  const engine = new ExecutionEngine();

  try {
    // Create a session with per-execution strategy
    const sessionId = await engine.createSession({
      strategy: ContainerStrategy.PER_EXECUTION,
      containerConfig: {
        image: 'node:18-alpine',
        environment: {
          NODE_ENV: 'development'
        }
      }
    });

    // Execute JavaScript code
    const result = await engine.executeCode(sessionId, {
      language: 'javascript',
      code: `
const numbers = [1, 2, 3, 4, 5];
const sum = numbers.reduce((a, b) => a + b, 0);
const average = sum / numbers.length;

console.log('Numbers:', numbers);
console.log('Sum:', sum);
console.log('Average:', average);
      `,
      dependencies: []
    });

    console.log('Execution Result:');
    console.log('STDOUT:', result.stdout);
    console.log('STDERR:', result.stderr);
    console.log('Exit Code:', result.exitCode);
    console.log('Execution Time:', result.executionTime, 'ms');

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await engine.cleanup();
  }
}

main();
```

### Using with Vercel AI

The library includes a Vercel AI compatible tool for executing code. Here's how to use it:

```typescript
import { generateText } from '@vercel/ai';
import { codeExecutionTool } from './src/ai-tool';

async function main() {
  try {
    // Use the code execution tool with Vercel AI
    const result = await generateText({
      model: 'gpt-4',
      messages: [
        {
          role: 'user',
          content: 'Write a Python function to calculate the Fibonacci sequence up to n numbers.'
        }
      ],
      tools: [codeExecutionTool],
      tool_choice: 'auto'
    });

    console.log('AI Response:', result);

    // You can also use the tool directly
    const executionResult = await codeExecutionTool.execute({
      language: 'python',
      code: `
def fibonacci(n):
    a, b = 0, 1
    sequence = []
    for _ in range(n):
        sequence.append(a)
        a, b = b, a + b
    return sequence

# Test the function
result = fibonacci(10)
print('Fibonacci sequence:', result)
      `,
      dependencies: []
    });

    console.log('Execution Result:', executionResult);
  } catch (error) {
    console.error('Error:', error);
  }
}

main();
```

The AI tool supports the following parameters:
- `code`: The code to execute
- `language`: The programming language ('javascript', 'typescript', 'python', or 'shell')
- `dependencies`: Optional list of dependencies to install
- `strategy`: Container strategy to use ('per_execution', 'pool', or 'per_session')
- `environment`: Environment variables to set in the container

## Container Strategies

### PER_EXECUTION
Creates a new container for each code execution. Best for one-off executions or when you need complete isolation.

### PER_SESSION
Reuses the same container for all executions within a session. Good for running multiple related code snippets.

### POOL
Maintains a pool of containers that are reused across executions. Ideal for high-throughput scenarios.

## Dependencies

### Runtime Dependencies
- `dockerode`: ^4.0.0 - Docker API client for Node.js
- `uuid`: ^9.0.0 - UUID generation
- `adm-zip`: ^0.5.10 - ZIP file handling
- `@vercel/ai`: ^3.0.0 - Vercel AI SDK
- `zod`: ^3.22.4 - Schema validation

### Development Dependencies
- `typescript`: ^5.3.3
- `ts-node`: ^10.9.2
- `@types/node`: ^20.11.0
- `@types/dockerode`: ^3.3.23
- `@types/uuid`: ^9.0.7
- `@types/adm-zip`: ^0.5.5

## Security Considerations

- Containers run with limited privileges
- Network access is restricted by default
- Resource limits are enforced (CPU, memory)
- File system access is controlled through mounts

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details. 