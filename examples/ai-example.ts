import { generateText } from 'ai';
import { openai } from "@ai-sdk/openai";
import { codeExecutionTool } from '../src/ai-tool';

async function main() {
  try {
    // Use generateText with codeExecutionTool to generate and execute Fibonacci code
    const result = await generateText({
      model: openai('gpt-4o'),
      maxSteps: 10,
      messages: [
        {
          role: 'user',
          content: 'Write a Python function to calculate the Fibonacci sequence up to n numbers and print the result. Make sure to include a test case that prints the first 10 numbers. Print the code and call the tool to execute it and print the result.'
        }
      ],
      tools: { codeExecutionTool },
      toolChoice: 'auto'
    });

    console.log('AI Response:', result.text);
    console.log('AI Tool Results:', result.toolResults);

  } catch (error) {
    console.error('Error:', error);
  }
}

main(); 