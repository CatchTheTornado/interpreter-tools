# Interpreter Tools

<img src=".readme-assets/hero.png" />

Run AI-generated code on your own machine—**locally, securely, at lightning speed**.  

Interpreter Tools is a drop-in **"code-interpreter"** backend for AI agents: it spins up **lightweight Docker containers**, executes untrusted snippets in < 100 ms (with pooling), streams the output, and can be **extended to any language** by registering a new config object.

Supports pooling, per-session containers, dependency caching, and real-time stdout/stderr—perfect for chat-based tools like GPT function calling, Jupyter-style notebooks, or autonomous agents that need to evaluate code on the fly.

## Why Interpreter Tools?

⚡ **Sub-100 ms average execution** (with container pool & dep-cache). Run untrusted code fast without leaving Node!

🔌 **Plug-in language architecture** – add a new language by registering one object (see `LanguageRegistry`). No engine edits required.

📦 **Zero-install repeat runs** – dependencies are installed once per container and skipped thereafter, saving seconds on every call.

🔒 **Docker-level isolation** – each snippet executes in its own constrained container (CPU, memory, no-new-privileges).

🖥️ **Real-time streaming** – stdout/stderr stream back instantly; ideal for REPL-like experiences.

---

## Getting Started

### Installation

Install the package and its dependencies in your Node.js project:

```bash
# Using yarn
yarn add interpreter-tools ai @ai-sdk/openai

# Or using npm
npm install interpreter-tools ai @ai-sdk/openai
```

### Quick Start

1. Create a new file `example.js` in your project:

```javascript
const { generateText } = require('ai');
const { openai } = require('@ai-sdk/openai');
const { createCodeExecutionTool } = require('interpreter-tools');

async function main() {
  try {
    // Create a code execution tool instance
    const codeExecutionTool = createCodeExecutionTool();

    // Use generateText with codeExecutionTool to generate and execute code
    const result = await generateText({
      model: openai('gpt-4'),
      maxSteps: 10,
      messages: [
        {
          role: 'user',
          content: 'Write a JavaScript function that calculates the sum of numbers from 1 to n and print the result for n=10. Make sure to include a test case.'
        }
      ],
      tools: { codeExecutionTool },
      toolChoice: 'auto'
    });

    console.log('AI Response:', result.text);
    console.log('Execution Results:', result.toolResults);

  } catch (error) {
    console.error('Error:', error);
  }
}

main();
```

2. Set up your OpenAI API key:

```bash
# Using yarn
yarn add dotenv

# Or using npm
npm install dotenv
```

Create a `.env` file in your project root:
```env
OPENAI_API_KEY=your_api_key_here
```

3. Update your code to use the environment variable:

```javascript
require('dotenv').config();
// ... rest of the code remains the same
```

4. Run the example:

```bash
node example.js
```

### Direct ExecutionEngine Usage

If you prefer to use the ExecutionEngine directly without the AI integration, here's how to do it:

1. Create a new file `direct-example.js`:

```javascript
const { ExecutionEngine, ContainerStrategy } = require('interpreter-tools');

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
      streamOutput: {
        stdout: (data) => console.log('Container output:', data),
        stderr: (data) => console.error('Container error:', data)
      }
    });

    console.log('Execution Result:');
    console.log('STDOUT:', result.stdout);
    console.log('STDERR:', result.stderr);
    console.log('Exit Code:', result.exitCode);
    console.log('Execution Time:', result.executionTime, 'ms');

  } catch (error) {
    console.error('Error:', error);
  } finally {
    // Clean up resources
    await engine.cleanup();
  }
}

main();
```

2. Run the example:

```bash
node direct-example.js
```

This example demonstrates:
- Creating a session with a specific container strategy
- Configuring the container environment
- Executing code directly in the container
- Handling real-time output streaming
- Proper resource cleanup

### TypeScript Support

If you're using TypeScript, you can import the packages with type definitions:

```typescript
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { createCodeExecutionTool } from 'interpreter-tools';
import 'dotenv/config';

// Rest of the code remains the same
```

## Local Development

To set up the project for local development:

```bash
# Clone the repository
git clone https://github.com/yourusername/interpreter-tools.git
cd interpreter-tools

# Install dependencies
yarn install
```

## Examples

The `/examples` directory contains several example scripts demonstrating different use cases of the interpreter tools:

### AI Tool Example
[`examples/ai-example.ts`](./examples/ai-example.ts)
Demonstrates how to:
- Use the code execution tool with Vercel AI
- Generate and execute Python code using AI
- Handle AI-generated code execution results
- Process Fibonacci sequence calculation

Run it with:
```bash
yarn ts-node examples/ai-example.ts
```

### Basic Usage Example
[`examples/basic-usage.ts`](./examples/basic-usage.ts)
Shows how to:
- Set up a basic execution environment
- Execute JavaScript code in a container
- Handle execution results and errors
- Use the per-execution container strategy

Run it with:
```bash
yarn ts-node examples/basic-usage.ts
```

### Python Example
[`examples/python-example.ts`](./examples/python-example.ts)
Demonstrates how to:
- Execute Python code in a container
- Handle Python dependencies
- Process Python script output
- Use Python-specific container configuration

Run it with:
```bash
yarn ts-node examples/python-example.ts
```

### Shell JSON Processing Example
[`examples/shell-json-example.ts`](./examples/shell-json-example.ts)
Demonstrates how to:
- Generate and execute a shell script using AI
- Create directories and JSON files
- Process JSON files using `jq`
- Handle Alpine Linux package dependencies

Run it with:
```bash
yarn ts-node examples/shell-json-example.ts
```

### Node.js Project Example
[`examples/nodejs-project-example.ts`](./examples/nodejs-project-example.ts)
Shows how to:
- Generate a complete Node.js project structure using AI
- Create an Express server
- Handle project dependencies
- Execute the generated project in a container

Run it with:
```bash
yarn ts-node examples/nodejs-project-example.ts
```

### Shell Example
[`examples/shell-example.ts`](./examples/shell-example.ts)
A simple example that:
- Creates a shell script
- Executes it in an Alpine Linux container
- Demonstrates basic container configuration
- Shows real-time output streaming

Run it with:
```bash
yarn ts-node examples/shell-example.ts
```

### Benchmark Examples
[`examples/benchmark-pool.ts`](./examples/benchmark-pool.ts) – JavaScript/TypeScript pool benchmark (20 rounds)

```bash
yarn ts-node examples/benchmark-pool.ts
```

[`examples/benchmark-pool-python.ts`](./examples/benchmark-pool-python.ts) – Python pool benchmark

```bash
yarn ts-node examples/benchmark-pool-python.ts
```

Average times on a MacBook M2 Pro: **JS 40 ms / round**, **Python 60 ms / round** after first run (deps cached).

## Usage

The main components of this project are:

1. `ExecutionEngine`: Manages code execution in containers
2. `ContainerManager`: Handles Docker container lifecycle
3. `CodeExecutionTool`: Provides a high-level interface for executing code

### Basic Usage

```typescript
import { createCodeExecutionTool } from 'interpreter-tools';

const codeExecutionTool = createCodeExecutionTool();

const result = await codeExecutionTool.execute({
  language: 'javascript',
  code: 'console.log("Hello, World!");',
  streamOutput: {
    stdout: (data) => console.log(data),
    stderr: (data) => console.error(data)
  }
});
```

## License

MIT 