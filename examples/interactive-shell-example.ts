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
  console.log('Special commands:');
  console.log('  - "info" - Show session information and container history');
  console.log('  - "quit" - Exit the shell');
  console.log('\n');

  const prompt = () => {
    rl.question('> ', async (input) => {
      if (input.toLowerCase() === 'quit') {
        rl.close();
        return;
      }

      if (input.toLowerCase() === 'info') {
        const sessionInfo = await executionEngine.getSessionInfo(sessionId);
        console.log('\n=== Session Information ===');
        console.log('Session ID:', sessionInfo.sessionId);
        console.log('Created:', sessionInfo.createdAt);
        console.log('Last Executed:', sessionInfo.lastExecutedAt || 'Never');
        console.log('Active:', sessionInfo.isActive ? 'Yes' : 'No');
        console.log('\nCurrent Container:');
        console.log('- Image:', sessionInfo.currentContainer.container ? 
          (await sessionInfo.currentContainer.container.inspect()).Config.Image : 'None');
        console.log('- Running:', sessionInfo.currentContainer.meta?.isRunning ? 'Yes' : 'No');
        console.log('- Created:', sessionInfo.currentContainer.meta?.createdAt);
        console.log('- Last Executed:', sessionInfo.currentContainer.meta?.lastExecutedAt || 'Never');
        
        console.log('\nContainer History:');
        sessionInfo.containerHistory.forEach((meta, index) => {
          console.log(`\nContainer ${index + 1}:`);
          console.log('- Image:', meta.imageName);
          console.log('- Container ID:', meta.containerId);
          console.log('- Created:', meta.createdAt);
          console.log('- Last Executed:', meta.lastExecutedAt || 'Never');
          console.log('- Generated Files:', meta.sessionGeneratedFiles.size);
        });
        console.log('\n');
        prompt();
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

        stopSpinner(true, 'AI Response received');

        // Display execution results
        const toolResult = (result.toolResults?.[0] as any)?.result;
        if (toolResult) {
          // Show what's being executed
          const executionInfo = (result.toolCalls?.[0] as any)?.args;
          if (executionInfo) {
            console.log('\nExecuting in Docker sandbox:');
            if (executionInfo.runApp) {
              console.log(`Application: ${executionInfo.runApp.entryFile}`);
              console.log(`Working directory: ${executionInfo.runApp.cwd}`);
            } else {
              console.log(`Language: ${executionInfo.language}`);
              if (executionInfo.dependencies?.length > 0) {
                console.log(`Dependencies: ${executionInfo.dependencies.join(', ')}`);
              }
              console.log('\nCode:');
              console.log('```' + executionInfo.language);
              console.log(executionInfo.code);
              console.log('```\n');
            }
          }

          console.log('\nOutput:');
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