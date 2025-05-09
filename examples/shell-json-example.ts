import { generateText } from 'ai';
import { openai } from "@ai-sdk/openai";
import { createCodeExecutionTool } from '../src/code-execution-tool';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

async function main() {
  try {
    // First, ask AI to generate a shell script that creates folders and JSON files
    console.log('Generating shell script...');
    const result = await generateText({
      model: openai('gpt-4'),
      maxSteps: 10,
      messages: [
        {
          role: 'user',
          content: `Create a shell script that:
1. Creates 3 directories: data1, data2, and data3
2. Creates a JSON file in each directory with different data
3. Uses jq to read and display one node from each JSON file
4. Include the necessary Alpine package installation command for jq

The script should:
- Install jq using apk
- Create directories and JSON files
- Use jq to extract and display data from each file
- Handle errors appropriately

Please format your response as a shell script with comments explaining each step.`
        }
      ],
      tools: { codeExecutionTool: createCodeExecutionTool().codeExecutionTool },
      toolChoice: 'auto'
    });

    console.log('AI Response:', result.text);

    // Extract the actual script content from between the markdown code block markers
    const scriptContent = result.text.match(/```(?:sh|bash)?\n([\s\S]*?)```/)?.[1];
    if (!scriptContent) {
      throw new Error('Failed to extract script content from AI response');
    }

    // Create a temporary directory for the script
    const scriptDir = path.join('/tmp', uuidv4());
    fs.mkdirSync(scriptDir, { recursive: true });

    // Write the shell script to a file
    const scriptPath = path.join(scriptDir, 'process_json.sh');
    fs.writeFileSync(scriptPath, scriptContent);
    fs.chmodSync(scriptPath, '755');

    console.log('** Script Directory:', scriptDir);
    console.log('** Created script file:', scriptPath);

    // Create a code execution tool with the script directory mounted
    const { codeExecutionTool }= createCodeExecutionTool({
      mounts: [{
        type: 'directory',
        source: scriptDir,
        target: '/project'
      }]
    });

    console.log('Executing script...');
    
    // Execute the script using codeExecutionTool
    const executionResult = await codeExecutionTool.execute({
      language: 'shell',
      code: '',
      runApp: {
        entryFile: 'process_json.sh',
        cwd: '/project'
      },
      dependencies: ['jq'],
      streamOutput: {
        stdout: (data) => {
          console.log('Container stdout:', data);
        },
        stderr: (data) => {
          console.error('Container stderr:', data);
        }
      }
    });

    console.log('Script Execution Result:');
    console.log('Exit Code:', executionResult.exitCode);
    console.log('Execution Time:', executionResult.executionTime, 'ms');

  } catch (error) {
    console.error('Error:', error);
  }
}

main(); 