import { LanguageRegistry, LanguageConfig } from '../src/languages';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { createCodeExecutionTool } from '../src/ai-tool';

// Dynamically register Ruby language support
const rubyConfig: LanguageConfig = {
  language: 'ruby',
  defaultImage: 'ruby:3.2-alpine',
  codeFilename: 'code.rb',
  prepareFiles: (options, dir) => {
    const fs = require('fs');
    const path = require('path');
    fs.writeFileSync(path.join(dir, 'code.rb'), options.code);
  },
  buildInlineCommand: () => ['sh', '-c', 'ruby code.rb'],
  buildRunAppCommand: (entry) => ['sh', '-c', `ruby ${entry}`]
};


async function main() {
  LanguageRegistry.register(rubyConfig);

  const tool = createCodeExecutionTool();

  // Ask AI to generate a simple Ruby script
  const result = await generateText({
    model: openai('gpt-4'),
    maxSteps: 5,
    messages: [
      {
        role: 'user',
        content: 'Write a Ruby script that: prints "Hello from Ruby" plus calculating fibonacci, then call the fib(10), take the current time and return it as a nice string. Run the script using the tool provided. Show the result output.'
      }
    ],
    tools: { codeExecutionTool: tool },
    toolChoice: 'required'
  });

  console.log('AI returned:', result.text);
  console.log('Execution results:', result.toolResults);
}

main(); 