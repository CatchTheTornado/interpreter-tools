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

Simply install the package:

```bash
yarn add interpreter-tools
```

## Local development setup

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

```bash
mkdir basic
cd basic
npm install interpreter-tools
# or yarn add interpreter-tools
nano basic-usage.js
```

Paste the code:

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

Then run it:

```bash
node basic-usage.js
```

### Using with Vercel AI

The library includes a Vercel AI compatible tool for executing code. Here's how to use it:

```bash
mkdir ai-tool-example
cd ai-tool-example
npm install interpreter-tools
# or yarn add interpreter-tools
nano ai-tool-example.js
```

```typescript
import { generateText } from 'ai';
import { openai } from "@ai-sdk/openai";
import { codeExecutionTool } from '../src/ai-tool';

async function main() {
  try {
    // Use generateText with codeExecutionTool to generate and execute Fibonacci code
    const result = await generateText({
      model: openai('gpt-4o'),
      maxSteps: 10,
      messages: [
        {
          role: 'user',
          content: 'Write a Python function to calculate the Fibonacci sequence up to n numbers and print the result. Make sure to include a test case that prints the first 10 numbers. Print the code and call the tool to execute it and print the result.'
        }
      ],
      tools: { codeExecutionTool },
      toolChoice: 'auto'
    });

    console.log('AI Response:', result.text);
    console.log('AI Tool Results:', result.toolResults);

  } catch (error) {
    console.error('Error:', error);
  }
}

main(); 
```

Then run it:

```bash
node ai-tool-example.js
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


## Security Considerations

- Containers run with limited privileges
- Network access is in the `bridge` mode by default
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