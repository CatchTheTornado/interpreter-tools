import { z } from 'zod';
import { ExecutionEngine } from './execution-engine';
import { ExecutionOptions, ExecutionResult, ContainerStrategy } from './types';

const executionOptionsSchema = z.object({
  language: z.enum(['typescript', 'javascript', 'python', 'shell']),
  code: z.string(),
  dependencies: z.array(z.string()).optional(),
  timeout: z.number().optional(),
  memoryLimit: z.string().optional(),
  cpuLimit: z.string().optional(),
  verbose: z.boolean().optional(),
  runApp: z.object({
    cwd: z.string(),
    entryFile: z.string()
  }).optional(),
  streamOutput: z.object({
    stdout: z.function().args(z.string()).optional(),
    stderr: z.function().args(z.string()).optional()
  }).optional(),
  workspaceSharing: z.enum(['isolated', 'shared']).optional()
});

export type CodeExecutionToolOptions = z.infer<typeof executionOptionsSchema>;

export function createCodeExecutionTool() {
  const engine = new ExecutionEngine();

  const codeExecutionTool = {
    async execute(options: CodeExecutionToolOptions): Promise<ExecutionResult> {
      const validatedOptions = executionOptionsSchema.parse(options);
      
      // Create a session with per-execution strategy
      const sessionId = await engine.createSession({
        strategy: ContainerStrategy.PER_EXECUTION,
        containerConfig: {
          image: validatedOptions.language === 'python' ? 'python:3.11-alpine' : 'node:18-alpine',
          environment: {
            NODE_ENV: 'development'
          }
        }
      });

      try {
        return await engine.executeCode(sessionId, validatedOptions);
      } finally {
        await engine.cleanupSession(sessionId);
      }
    }
  };

  return {
    codeExecutionTool,
    engine
  };
} 