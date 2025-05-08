import { generateText } from 'ai';
import { openai } from "@ai-sdk/openai";
import { createCodeExecutionTool } from '../src/ai-tool';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

async function main() {
  try {
    // First, ask AI to generate a complete Node.js project structure
    console.log('Generating project structure...');
    const result = await generateText({
      model: openai('gpt-4'),
      maxSteps: 10,
      messages: [
        {
          role: 'user',
          content: `Create a simple Node.js project with the following structure:
1. A main server file (server.js) that creates an Express server
2. A package.json with necessary dependencies
3. A README.md with setup instructions
4. A simple route that returns "Hello World"
5. Include a console log message "Listening on port 3000"

Please format your response as follows:
FILE: filename
\`\`\`
file contents
\`\`\`

Separate each file with a blank line.`
        }
      ],
      tools: { codeExecutionTool: createCodeExecutionTool().codeExecutionTool },
      toolChoice: 'auto'
    });

    console.log('AI Response:', result.text);

    // Create a temporary directory for the project
    const projectDir = path.join('/tmp', uuidv4());
    fs.mkdirSync(projectDir, { recursive: true });

    console.log('** Project Directory:', projectDir); 

    // Parse the response and create files
    const fileRegex = /FILE: ([^\n]+)\n```(?:[^\n]*)\n([\s\S]*?)```/g;
    let match;
    const files: { name: string; content: string }[] = [];

    while ((match = fileRegex.exec(result.text)) !== null) {
      const fileName = match[1].trim();
      const content = match[2].trim();
      files.push({ name: fileName, content });
      
      // Write file to temp directory
      const filePath = path.join(projectDir, fileName);
      fs.writeFileSync(filePath, content);
      console.log(`** Created file: ${fileName}`);
    }

    console.log('** Created files:', files.map(f => f.name).join(', '));

    // Create a code execution tool with the project directory mounted
    const { codeExecutionTool } = createCodeExecutionTool({
      mounts: [{
        type: 'directory',
        source: projectDir,
        target: '/project'
      }]
    });

    console.log('Executing project...');
    
    // Execute the project using codeExecutionTool
    const executionResult = await codeExecutionTool.execute({
      language: 'javascript',
      code: '',
      runApp: {
        entryFile: 'server.js',
        cwd: '/project'
      },
      dependencies: ['express'],
      streamOutput: {
        stdout: (data) => {
          console.log('Container stdout:', data);
        },
        stderr: (data) => {
          console.error('Container stderr:', data);
        }
      }
    });

    console.log('Project Execution Result:');
    console.log('Exit Code:', executionResult.exitCode);
    console.log('Execution Time:', executionResult.executionTime, 'ms');

  } catch (error) {
    console.error('Error:', error);
  }
}

main(); 