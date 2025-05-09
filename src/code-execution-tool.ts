import { ExecutionEngine } from './execution-engine';
import { ContainerStrategy } from './types';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { ContainerMount } from './types';
import { LanguageRegistry } from './languages';

interface CodeExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  executionTime: number;
  workspaceDir: string;
  generatedFiles: string[];
  sessionGeneratedFiles: string[];
}

interface CodeExecutionToolConfig {
  mounts?: ContainerMount[];
  sessionId?: string;
  defaultStrategy?: 'per_execution' | 'pool' | 'per_session';
  verbosity?: 'debug' | 'info';
  workspaceSharing?: 'isolated' | 'shared';
}

export function createCodeExecutionTool(config: CodeExecutionToolConfig = {}) {
  // Build Zod enum from dynamic language names once
  const languageNames = LanguageRegistry.names();
  if (languageNames.length === 0) {
    throw new Error('No languages registered');
  }
  const languageEnum = z.enum([languageNames[0], ...languageNames.slice(1)] as [string, ...string[]]);
  

  const codeExecutionSchema = z.object({
    code: z.string().describe('The code to execute.'),
    language: languageEnum.describe('The programming language of the code.'),
    dependencies: z.array(z.string()).optional().describe('List of dependencies used by the code to be installed.'),
//    sessionId: z.string().optional().describe('Custom session ID (for re-use across calls).'),
    environment: z.record(z.string()).optional().describe('Environment variables to set in the container.'),
    runApp: z.object({
      entryFile: z.string().describe('Path to the entry file relative to the mounted directory'),
      cwd: z.string().describe('Working directory path that should be mounted')
    }).optional().describe('Optional configuration for running an entire application'),
    streamOutput: z.object({
      stdout: z.function().args(z.string()).optional(),
      stderr: z.function().args(z.string()).optional(),
      stdin: z.function().args(z.string()).optional()
    }).optional().describe('Optional streaming output handlers')
  });

  const engine = new ExecutionEngine();

  engine.setVerbosity(config.verbosity ?? 'info');

  const tool = {
    description: 'Executes code in an isolated Docker container with support for multiple languages.',
    parameters: codeExecutionSchema,
    execute: async ({
      code,
      language,
      dependencies = [],
  //    sessionId,
      environment = {},
      runApp,
      streamOutput
    }: z.infer<typeof codeExecutionSchema>): Promise<CodeExecutionResult> => {
      const strategy = config.defaultStrategy ?? 'per_execution';
      const sessionId = config.sessionId ?? uuidv4();
      const session = await engine.createSession({
        sessionId,
        strategy: ContainerStrategy[strategy.toUpperCase() as keyof typeof ContainerStrategy],
        containerConfig: {
          image: getImageForLanguage(language),
          environment,
          mounts: config.mounts
        }
      });

      const result = await engine.executeCode(session, {
        language: language as any,
        code,
        dependencies,
        runApp,
        streamOutput,
        workspaceSharing: config.workspaceSharing ?? 'isolated'
      });

      // Auto cleanup for strategies other than per_session
      if (strategy !== 'per_session') {
        await engine.cleanupSession(session);
      }

      return result;
    }
  };

  async function cleanup(keepGeneratedFiles: boolean = false): Promise<void> {
    try {
      await engine.cleanup(keepGeneratedFiles);
    } catch {}
  }

  return { codeExecutionTool: tool, executionEngine: engine, cleanup };
}

// Default instance with no mounts
export const { codeExecutionTool, executionEngine, cleanup } = createCodeExecutionTool();

export function getImageForLanguage(language: string): string {
  const cfg = LanguageRegistry.get(language);
  if (!cfg) throw new Error(`Unsupported language: ${language}`);
  return cfg.defaultImage;
} 