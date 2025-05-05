import { ExecutionEngine, ContainerStrategy } from './index';
import { z } from 'zod';

interface CodeExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  executionTime: number;
}

const codeExecutionSchema = z.object({
  code: z.string().describe('The code to execute.'),
  language: z.enum(['javascript', 'typescript', 'python', 'shell']).describe('The programming language of the code.'),
  dependencies: z.array(z.string()).optional().describe('Optional list of dependencies to install.'),
  strategy: z.enum(['per_execution', 'pool', 'per_session']).optional().describe('Container strategy to use.'),
  environment: z.record(z.string()).optional().describe('Environment variables to set in the container.'),
});

export const codeExecutionTool = {
  description: 'Executes code in an isolated Docker container with support for multiple languages.',
  parameters: codeExecutionSchema,
  execute: async ({ 
    code, 
    language, 
    dependencies = [], 
    strategy = 'per_execution',
    environment = {}
  }: z.infer<typeof codeExecutionSchema>): Promise<CodeExecutionResult> => {
    const engine = new ExecutionEngine();

    try {
      const sessionId = await engine.createSession({
        strategy: ContainerStrategy[strategy.toUpperCase() as keyof typeof ContainerStrategy],
        containerConfig: {
          image: getImageForLanguage(language),
          environment
        }
      });

      const result = await engine.executeCode(sessionId, {
        language,
        code,
        dependencies
      });

      return result;
    } finally {
      await engine.cleanup();
    }
  }
};

function getImageForLanguage(language: string): string {
  switch (language) {
    case 'typescript':
    case 'javascript':
      return 'node:18-alpine';
    case 'python':
      return 'python:3.9-slim';
    case 'shell':
      return 'alpine:latest';
    default:
      throw new Error(`Unsupported language: ${language}`);
  }
} 