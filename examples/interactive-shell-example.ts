import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { createCodeExecutionTool, getImageForLanguage } from '../src/code-execution-tool';
import { v4 as uuidv4 } from 'uuid';
import { ContainerStrategy } from '../src/types';
import * as readline from 'readline';

// Simple spinner animation
const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerInterval: NodeJS.Timeout;

function startSpinner(message: string) {
  let i = 0;
  process.stdout.write('\r' + message + ' ' + spinner[0]);
  spinnerInterval = setInterval(() => {
    process.stdout.write('\r' + message + ' ' + spinner[i]);
    i = (i + 1) % spinner.length;
  }, 80);
}

function stopSpinner(success: boolean, message: string) {
  clearInterval(spinnerInterval);
  process.stdout.write('\r' + (success ? '✓' : '✗') + ' ' + message + '\n');
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const sessionId = `interactive-${uuidv4()}`;
  
  // Create the execution tool with shared workspace
  const { codeExecutionTool, executionEngine } = createCodeExecutionTool({
    defaultStrategy: 'per_session',
    sessionId,
    verbosity: 'info',
    workspaceSharing: 'shared'
  });

  // Create initial session
  await executionEngine.createSession({
    sessionId,
    strategy: ContainerStrategy.PER_SESSION,
    containerConfig: {
      image: getImageForLanguage('shell')
    }
  });

  // Get session info for workspace directory
  const sessionInfo = await executionEngine.getSessionInfo(sessionId);
  const workspaceDir = sessionInfo.currentContainer.meta?.workspaceDir;

  console.log('\n=== Interactive AI Shell ===\n');
  console.log('Workspace Directory:', workspaceDir);
  console.log('Type your commands or AI prompts below.');
  console.log('Type "quit" or press Ctrl+C to exit.\n');

  const prompt = () => {
    rl.question('> ', async (input) => {
      if (input.toLowerCase() === 'quit') {
        rl.close();
        return;
      }

      startSpinner('AI Thinking...');
      
      try {
        const result = await generateText({
          model: openai('gpt-4'),
          maxSteps: 1,
          messages: [
            {
              role: 'user',
              content: `Execute this command or prompt, if not specified difffernt try to use shell or python, if using non standard modules pass them as "dependencies" to be installed: ${input}`
            }
          ],
          tools: { codeExecutionTool },
          toolChoice: 'required'
        });

        stopSpinner(true, 'Execution complete');

        // Display AI response
        console.log('\nAI Response:');
        console.log(result.text);

        // Display execution results
        const toolResult = (result.toolResults?.[0] as any)?.result;
        if (toolResult) {
          // Display stdout directly
          if (toolResult.stdout) {
            console.log(toolResult.stdout);
          }
          
          // Display stderr in red if present
          if (toolResult.stderr) {
            console.error(toolResult.stderr);
          }

          // Show generated files in a subtle way
          if (toolResult.generatedFiles?.length > 0) {
            console.log('\n[Generated files: ' + toolResult.generatedFiles.join(', ') + ']');
          }
        }
      } catch (error) {
        stopSpinner(false, 'Error occurred');
        console.error('Error:', error);
      }

      console.log(); // Add blank line for readability
      prompt(); // Continue the loop
    });
  };

  // Start the interactive loop
  prompt();

  // Handle cleanup on exit
  rl.on('close', async () => {
    console.log('\nCleaning up...');
    await executionEngine.cleanupSession(sessionId);
    process.exit(0);
  });
}

main().catch(console.error); 