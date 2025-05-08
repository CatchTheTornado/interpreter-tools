import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { createCodeExecutionTool } from '../src/ai-tool';

(async () => {
  // Create tool with default settings (per_execution strategy)  - we set it to per_session to reuse the same container for multiple executions and to have access to the generated files
  const { codeExecutionTool, cleanup, executionEngine } = createCodeExecutionTool({ defaultStrategy: 'per_session' });

  try {
    console.log('Generating python script...');
    const res = await generateText({
      model: openai('gpt-4o-mini'),
      maxSteps: 8,
      messages: [
        {
          role: 'user',
          content:
            'Write a Python script that generates some random nice looking chart and saves a PNG or SVG chart of temperature change to /workspace/weather.png, and print only "done". Then run it with the codeExecutionTool (it supports python).' // instruction for AI
        }
      ],
      tools: { codeExecutionTool },
      toolChoice: 'auto'
    });

    console.log('AI response:', res.text);
    console.log('Execution results:', res.toolResults);

    const toolRes = (res.toolResults?.[0] as any)?.result;
    if (toolRes) {
      console.log('Generated files:', toolRes.generatedFiles);
    }
  } finally {
    await cleanup();
  }
})(); 