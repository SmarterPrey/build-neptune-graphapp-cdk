import { Handler } from "aws-lambda";
import * as gremlin from "gremlin";
import { getUrlAndHeaders } from "gremlin-aws-sigv4/lib/utils";

const Client = gremlin.driver.Client;

const BEDROCK_REGION = process.env.BEDROCK_REGION || "us-east-1";
const MODEL_ID = process.env.MODEL_ID || "amazon.nova-lite-v1:0";

const GRAPH_SCHEMA = `
Graph Schema:
- Vertex labels: person, product, conference, institution, document
- Edge labels: usage, belong_to, authored_by, affiliated_with, made_by
- All vertices have a "name" property
- Edge "usage" connects person -> product (with numeric weight)
- Edge "belong_to" connects document -> conference
- Edge "authored_by" connects document -> person
- Edge "affiliated_with" connects person -> institution
- Edge "made_by" connects product -> person/institution

Example Gremlin queries:
- Get all people: g.V().hasLabel('person').values('name').toList()
- Get products used by a person: g.V().has('person','name','Doctor1').out('usage').values('name').toList()
- Count vertices: g.V().count().next()
- Count edges: g.E().count().next()
- Get all vertex labels: g.V().label().dedup().toList()
- Get neighbors of a vertex: g.V().has('person','name','Doctor1').both().values('name').toList()
`;

const SYSTEM_PROMPT = `You are a graph database assistant for Amazon Neptune. You help users query a graph database using natural language.

${GRAPH_SCHEMA}

When a user asks a question about the graph data:
1. Determine if you need to query the graph to answer
2. If yes, generate a Gremlin query
3. Return your response as JSON

IMPORTANT RULES:
- Only generate READ queries (no mutations/drops)
- Use the Gremlin traversal language
- Always return valid JSON in this exact format:

If a query is needed:
{"needsQuery": true, "gremlinQuery": "<the gremlin traversal after g.>", "explanation": "<brief explanation of what the query does>"}

If no query is needed (general question about the schema, greetings, etc.):
{"needsQuery": false, "answer": "<your answer>", "explanation": ""}

Examples:
User: "Who are all the people in the graph?"
{"needsQuery": true, "gremlinQuery": "V().hasLabel('person').values('name').toList()", "explanation": "Lists all person vertices by name"}

User: "What products does Doctor1 use?"
{"needsQuery": true, "gremlinQuery": "V().has('person','name','Doctor1').out('usage').values('name').toList()", "explanation": "Finds products connected to Doctor1 via usage edges"}

User: "How many nodes are in the graph?"
{"needsQuery": true, "gremlinQuery": "V().count().next()", "explanation": "Counts all vertices in the graph"}

User: "What types of relationships exist?"
{"needsQuery": false, "answer": "The graph has these relationship types: usage, belong_to, authored_by, affiliated_with, and made_by.", "explanation": ""}
`;

interface BedrockMessage {
  role: string;
  content: string;
}

interface ConversationEntry {
  role: string;
  content: string;
}

async function invokeBedrock(messages: BedrockMessage[]): Promise<string> {
  // Use AWS SDK v3 - dynamically import to work with Lambda bundling
  const { BedrockRuntimeClient, ConverseCommand } = await import(
    "@aws-sdk/client-bedrock-runtime"
  );

  const client = new BedrockRuntimeClient({ region: BEDROCK_REGION });

  const command = new ConverseCommand({
    modelId: MODEL_ID,
    system: [{ text: SYSTEM_PROMPT }],
    messages: messages.map((m) => ({
      role: m.role as "user" | "assistant",
      content: [{ text: m.content }],
    })),
    inferenceConfig: {
      maxTokens: 1024,
    },
  });

  const response = await client.send(command);
  const output = response.output?.message?.content;
  if (!output || output.length === 0 || !output[0].text) {
    throw new Error("Empty response from Bedrock");
  }
  return output[0].text;
}

// Gremlin steps that mutate the graph — these are not allowed in read-only mode
const MUTATION_PATTERN =
  /\b(addV|addE|addVertex|addEdge|drop|property|iterate|sideEffect|inject)\s*\(/i;

function validateGremlinQuery(queryString: string): void {
  if (MUTATION_PATTERN.test(queryString)) {
    throw new Error(
      "Query contains mutation operations which are not allowed"
    );
  }
}

async function executeGremlin(queryString: string): Promise<unknown> {
  validateGremlinQuery(queryString);

  const { url, headers } = getUrlAndHeaders(
    process.env.NEPTUNE_ENDPOINT,
    process.env.NEPTUNE_PORT,
    {},
    "/gremlin",
    "wss"
  );

  const client = new Client(url, {
    mimeType: "application/vnd.gremlin-v2.0+json",
    headers: headers,
  });

  try {
    // Submit the query string to the Gremlin server for server-side execution.
    // This avoids local JavaScript evaluation (no Function constructor / eval).
    const result = await client.submit(`g.${queryString}`);
    return result.toArray ? result.toArray() : result;
  } finally {
    try {
      await client.close();
    } catch (e) {
      console.warn("Error closing connection:", e);
    }
  }
}

export const handler: Handler = async (event) => {
  console.log("AI Query event:", JSON.stringify(event));

  const question = event.arguments?.question;
  const conversationHistory: ConversationEntry[] = event.arguments?.history
    ? JSON.parse(event.arguments.history)
    : [];

  if (!question) {
    return {
      answer:
        "Please ask a question about the graph data. For example: 'Who are all the people in the graph?' or 'What products does Doctor1 use?'",
      query: null,
      data: null,
    };
  }

  try {
    // Build messages for Bedrock including conversation history
    const messages: BedrockMessage[] = [];

    for (const entry of conversationHistory) {
      messages.push({
        role: entry.role === "user" ? "user" : "assistant",
        content: entry.content,
      });
    }

    messages.push({
      role: "user",
      content: question,
    });

    // Converse API requires first message to be from "user" — strip leading assistant messages
    while (messages.length > 0 && messages[0].role !== "user") {
      messages.shift();
    }

    console.log("Sending messages to Bedrock:", JSON.stringify(messages.map(m => ({ role: m.role, len: m.content.length }))));

    // Call Bedrock to interpret the question
    const bedrockResponse = await invokeBedrock(messages);
    console.log("Bedrock response:", bedrockResponse);

    // Parse Bedrock's response - extract JSON from the text
    let parsed;
    try {
      // Try to extract JSON from the response
      const jsonMatch = bedrockResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        parsed = JSON.parse(bedrockResponse);
      }
    } catch (parseError) {
      console.error("Failed to parse Bedrock response:", parseError);
      return {
        answer: bedrockResponse,
        query: null,
        data: null,
      };
    }

    if (!parsed.needsQuery) {
      return {
        answer: parsed.answer || bedrockResponse,
        query: null,
        data: null,
      };
    }

    // Execute the Gremlin query
    const gremlinQuery = parsed.gremlinQuery;
    console.log("Executing Gremlin query:", gremlinQuery);

    let queryResult;
    try {
      queryResult = await executeGremlin(gremlinQuery);
    } catch (queryError: unknown) {
      console.error("Gremlin query error:", queryError);
      const errorMessage =
        queryError instanceof Error ? queryError.message : String(queryError);
      return {
        answer: `I tried to query the graph but encountered an error. The query was: g.${gremlinQuery}. Error: ${errorMessage}`,
        query: `g.${gremlinQuery}`,
        data: null,
      };
    }

    // Format the result
    const resultStr = JSON.stringify(queryResult, null, 2);
    console.log("Query result:", resultStr);

    // Ask Bedrock to summarize the results
    const summaryMessages: BedrockMessage[] = [
      ...messages,
      {
        role: "assistant",
        content: `I executed the Gremlin query: g.${gremlinQuery}`,
      },
      {
        role: "user",
        content: `The query returned these results: ${resultStr}\n\nPlease provide a clear, concise natural language summary of these results to answer my original question. Do not return JSON, just a plain text answer.`,
      },
    ];

    const summary = await invokeBedrock(summaryMessages);

    return {
      answer: summary,
      query: `g.${gremlinQuery}`,
      data: resultStr,
    };
  } catch (error: unknown) {
    console.error("AI Query error:", error);
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    return {
      answer: `Sorry, I encountered an error processing your question: ${errorMessage}`,
      query: null,
      data: null,
    };
  }
};
