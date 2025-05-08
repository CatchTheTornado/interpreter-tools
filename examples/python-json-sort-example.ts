import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { createCodeExecutionTool, getImageForLanguage } from '../src/ai-tool';
import { v4 as uuidv4 } from 'uuid';
import { ContainerStrategy } from '../src/types';

// Alias generateCode to generateText – in the current SDK they are functionally equivalent for this use–case
const generateCode = generateText;

(async () => {
  // We use a fixed sessionId so that both the JSON generation step and the Python execution
  // share the same container workspace (thanks to the `per_session` strategy).
  const sessionId = `people-sort-${uuidv4()}`;

  // Create the execution tool with a per-session strategy so we can reuse the container between steps
  const { codeExecutionTool, executionEngine, cleanup } = createCodeExecutionTool({
    defaultStrategy: 'per_session',
    sessionId
  });

  const session = await executionEngine.createSession({ // we're starting a new session to be able to upload files before executing code
    sessionId,
    strategy: ContainerStrategy['PER_SESSION'],
    containerConfig: {
      image: getImageForLanguage('python')
    }
  });

  executionEngine.setVerbosity('debug');

  try {
    /**
     * STEP 1 – Ask the model to generate a JSON file containing fake data.
     * We deliberately ask for pure JSON (no markdown) so that we can write it to a file verbatim.
     */
    console.log('Generating fake data JSON …');
    const jsonRes = await generateCode({
      model: openai('gpt-4o'),
      maxSteps: 1,
      messages: [
        {
          role: 'user',
          content:
            'Create a JSON array named "people" with approx. 20 objects. Each object should have the fields "firstName", "lastName" and "salary" (number between 40000 and 120000). Respond ONLY with the raw JSON (no markdown, no comments).' // instruction for AI
        }
      ]
    });

    const jsonContent = jsonRes.text.trim();
    console.log('Fake People JSON:', jsonContent.substring(0, 120) + ' …');

    // Write the JSON into the container workspace so that subsequent code can read it.
    const jsonBase64 = Buffer.from(jsonContent, 'utf8').toString('base64');
    await executionEngine.addFileFromBase64(sessionId, 'people.json', jsonBase64);
    console.log('people.json added to container workspace');

    /**
     * STEP 2 – Generate a Python script that reads the JSON, sorts the list and saves CSV.
     */
    console.log('Generating Python script …');
    const pyRes = await generateText({
      model: openai('gpt-4o'),
      maxSteps: 1,
      messages: [
        {
          role: 'user',
          content:
            'Write a Python script that: 1) reads /workspace/people.json, 2) sorts the people by salary descending, 3) prints the sorted list in a readable table, 4) saves the sorted list as /workspace/people_sorted.csv. Use only built-in Python libraries (json, csv) so no external dependencies are required. Use the tool "codeExecutionTool"provided to execute the code.'
        }
      ],
      tools: { codeExecutionTool },
      toolChoice: 'required'
    });

    console.log('AI Python response:', pyRes.text);
    console.log('Execution results:', pyRes.toolResults);

    const toolResult = (pyRes.toolResults?.[0] as any)?.result;
    if (toolResult) {
      console.log('Generated files inside container:', toolResult.generatedFiles);
    }
  } finally {
    // Keep generated files when cleaning up; set to true so we can inspect them after the script ends if needed.
    await cleanup(true);
  }
})();
