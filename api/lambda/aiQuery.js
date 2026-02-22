"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const gremlin = require("gremlin");
const utils_1 = require("gremlin-aws-sigv4/lib/utils");
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
async function invokeBedrock(messages) {
    // Use AWS SDK v3 - dynamically import to work with Lambda bundling
    const { BedrockRuntimeClient, ConverseCommand } = await Promise.resolve().then(() => require("@aws-sdk/client-bedrock-runtime"));
    const client = new BedrockRuntimeClient({ region: BEDROCK_REGION });
    const command = new ConverseCommand({
        modelId: MODEL_ID,
        system: [{ text: SYSTEM_PROMPT }],
        messages: messages.map((m) => ({
            role: m.role,
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
const MUTATION_PATTERN = /\b(addV|addE|addVertex|addEdge|drop|property|iterate|sideEffect|inject)\s*\(/i;
function validateGremlinQuery(queryString) {
    if (MUTATION_PATTERN.test(queryString)) {
        throw new Error("Query contains mutation operations which are not allowed");
    }
}
async function executeGremlin(queryString) {
    validateGremlinQuery(queryString);
    const { url, headers } = (0, utils_1.getUrlAndHeaders)(process.env.NEPTUNE_ENDPOINT, process.env.NEPTUNE_PORT, {}, "/gremlin", "wss");
    const client = new Client(url, {
        mimeType: "application/vnd.gremlin-v2.0+json",
        headers: headers,
    });
    try {
        // Submit the query string to the Gremlin server for server-side execution.
        // This avoids local JavaScript evaluation (no Function constructor / eval).
        const result = await client.submit(`g.${queryString}`);
        return result.toArray ? result.toArray() : result;
    }
    finally {
        try {
            await client.close();
        }
        catch (e) {
            console.warn("Error closing connection:", e);
        }
    }
}
const handler = async (event) => {
    console.log("AI Query event:", JSON.stringify(event));
    const question = event.arguments?.question;
    const conversationHistory = event.arguments?.history
        ? JSON.parse(event.arguments.history)
        : [];
    if (!question) {
        return {
            answer: "Please ask a question about the graph data. For example: 'Who are all the people in the graph?' or 'What products does Doctor1 use?'",
            query: null,
            data: null,
        };
    }
    try {
        // Build messages for Bedrock including conversation history
        const messages = [];
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
            }
            else {
                parsed = JSON.parse(bedrockResponse);
            }
        }
        catch (parseError) {
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
        }
        catch (queryError) {
            console.error("Gremlin query error:", queryError);
            const errorMessage = queryError instanceof Error ? queryError.message : String(queryError);
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
        const summaryMessages = [
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
    }
    catch (error) {
        console.error("AI Query error:", error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
            answer: `Sorry, I encountered an error processing your question: ${errorMessage}`,
            query: null,
            data: null,
        };
    }
};
exports.handler = handler;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYWlRdWVyeS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImFpUXVlcnkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQ0EsbUNBQW1DO0FBQ25DLHVEQUErRDtBQUUvRCxNQUFNLE1BQU0sR0FBRyxPQUFPLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQztBQUVyQyxNQUFNLGNBQWMsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGNBQWMsSUFBSSxXQUFXLENBQUM7QUFDakUsTUFBTSxRQUFRLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxRQUFRLElBQUksdUJBQXVCLENBQUM7QUFFakUsTUFBTSxZQUFZLEdBQUc7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQWtCcEIsQ0FBQztBQUVGLE1BQU0sYUFBYSxHQUFHOztFQUVwQixZQUFZOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0E4QmIsQ0FBQztBQVlGLEtBQUssVUFBVSxhQUFhLENBQUMsUUFBMEI7SUFDckQsbUVBQW1FO0lBQ25FLE1BQU0sRUFBRSxvQkFBb0IsRUFBRSxlQUFlLEVBQUUsR0FBRywyQ0FDaEQsaUNBQWlDLEVBQ2xDLENBQUM7SUFFRixNQUFNLE1BQU0sR0FBRyxJQUFJLG9CQUFvQixDQUFDLEVBQUUsTUFBTSxFQUFFLGNBQWMsRUFBRSxDQUFDLENBQUM7SUFFcEUsTUFBTSxPQUFPLEdBQUcsSUFBSSxlQUFlLENBQUM7UUFDbEMsT0FBTyxFQUFFLFFBQVE7UUFDakIsTUFBTSxFQUFFLENBQUMsRUFBRSxJQUFJLEVBQUUsYUFBYSxFQUFFLENBQUM7UUFDakMsUUFBUSxFQUFFLFFBQVEsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUM7WUFDN0IsSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUE0QjtZQUNwQyxPQUFPLEVBQUUsQ0FBQyxFQUFFLElBQUksRUFBRSxDQUFDLENBQUMsT0FBTyxFQUFFLENBQUM7U0FDL0IsQ0FBQyxDQUFDO1FBQ0gsZUFBZSxF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c0NvbnRlbnQiOlsiaW1wb3J0IHsgSGFuZGxlciB9IGZyb20gXCJhd3MtbGFtYmRhXCI7XG5pbXBvcnQgKiBhcyBncmVtbGluIGZyb20gXCJncmVtbGluXCI7XG5pbXBvcnQgeyBnZXRVcmxBbmRIZWFkZXJzIH0gZnJvbSBcImdyZW1saW4tYXdzLXNpZ3Y0L2xpYi91dGlsc1wiO1xuXG5jb25zdCBDbGllbnQgPSBncmVtbGluLmRyaXZlci5DbGllbnQ7XG5cbmNvbnN0IEJFRFJPQ0tfUkVHSU9OID0gcHJvY2Vzcy5lbnYuQkVEUk9DS19SRUdJT04gfHwgXCJ1cy1lYXN0LTFcIjtcbmNvbnN0IE1PREVMX0lEID0gcHJvY2Vzcy5lbnYuTU9ERUxfSUQgfHwgXCJhbWF6b24ubm92YS1saXRlLXYxOjBcIjtcblxuY29uc3QgR1JBUEhfU0NIRU1BID0gYFxuR3JhcGggU2NoZW1hOlxuLSBWZXJ0ZXggbGFiZWxzOiBwZXJzb24sIHByb2R1Y3QsIGNvbmZlcmVuY2UsIGluc3RpdHV0aW9uLCBkb2N1bWVudFxuLSBFZGdlIGxhYmVsczogdXNhZ2UsIGJlbG9uZ190bywgYXV0aG9yZWRfYnksIGFmZmlsaWF0ZWRfd2l0aCwgbWFkZV9ieVxuLSBBbGwgdmVydGljZXMgaGF2ZSBhIFwibmFtZVwiIHByb3BlcnR5XG4tIEVkZ2UgXCJ1c2FnZVwiIGNvbm5lY3RzIHBlcnNvbiAtPiBwcm9kdWN0ICh3aXRoIG51bWVyaWMgd2VpZ2h0KVxuLSBFZGdlIFwiYmVsb25nX3RvXCIgY29ubmVjdHMgZG9jdW1lbnQgLT4gY29uZmVyZW5jZVxuLSBFZGdlIFwiYXV0aG9yZWRfYnlcIiBjb25uZWN0cyBkb2N1bWVudCAtPiBwZXJzb25cbi0gRWRnZSBcImFmZmlsaWF0ZWRfd2l0aFwiIGNvbm5lY3RzIHBlcnNvbiAtPiBpbnN0aXR1dGlvblxuLSBFZGdlIFwibWFkZV9ieVwiIGNvbm5lY3RzIHByb2R1Y3QgLT4gcGVyc29uL2luc3RpdHV0aW9uXG5cbkV4YW1wbGUgR3JlbWxpbiBxdWVyaWVzOlxuLSBHZXQgYWxsIHBlb3BsZTogZy5WKCkuaGFzTGFiZWwoJ3BlcnNvbicpLnZhbHVlcygnbmFtZScpLnRvTGlzdCgpXG4tIEdldCBwcm9kdWN0cyB1c2VkIGJ5IGEgcGVyc29uOiBnLlYoKS5oYXMoJ3BlcnNvbicsJ25hbWUnLCdEb2N0b3IxJykub3V0KCd1c2FnZScpLnZhbHVlcygnbmFtZScpLnRvTGlzdCgpXG4tIENvdW50IHZlcnRpY2VzOiBnLlYoKS5jb3VudCgpLm5leHQoKVxuLSBDb3VudCBlZGdlczogZy5FKCkuY291bnQoKS5uZXh0KClcbi0gR2V0IGFsbCB2ZXJ0ZXggbGFiZWxzOiBnLlYoKS5sYWJlbCgpLmRlZHVwKCkudG9MaXN0KClcbi0gR2V0IG5laWdoYm9ycyBvZiBhIHZlcnRleDogZy5WKCkuaGFzKCdwZXJzb24nLCduYW1lJywnRG9jdG9yMScpLmJvdGgoKS52YWx1ZXMoJ25hbWUnKS50b0xpc3QoKVxuYDtcblxuY29uc3QgU1lTVEVNX1BST01QVCA9IGBZb3UgYXJlIGEgZ3JhcGggZGF0YWJhc2UgYXNzaXN0YW50IGZvciBBbWF6b24gTmVwdHVuZS4gWW91IGhlbHAgdXNlcnMgcXVlcnkgYSBncmFwaCBkYXRhYmFzZSB1c2luZyBuYXR1cmFsIGxhbmd1YWdlLlxuXG4ke0dSQVBIX1NDSEVNQX1cblxuV2hlbiBhIHVzZXIgYXNrcyBhIHF1ZXN0aW9uIGFib3V0IHRoZSBncmFwaCBkYXRhOlxuMS4gRGV0ZXJtaW5lIGlmIHlvdSBuZWVkIHRvIHF1ZXJ5IHRoZSBncmFwaCB0byBhbnN3ZXJcbjIuIElmIHllcywgZ2VuZXJhdGUgYSBHcmVtbGluIHF1ZXJ5XG4zLiBSZXR1cm4geW91ciByZXNwb25zZSBhcyBKU09OXG5cbklNUE9SVEFOVCBSVUxFUzpcbi0gT25seSBnZW5lcmF0ZSBSRUFEIHF1ZXJpZXMgKG5vIG11dGF0aW9ucy9kcm9wcylcbi0gVXNlIHRoZSBHcmVtbGluIHRyYXZlcnNhbCBsYW5ndWFnZVxuLSBBbHdheXMgcmV0dXJuIHZhbGlkIEpTT04gaW4gdGhpcyBleGFjdCBmb3JtYXQ6XG5cbklmIGEgcXVlcnkgaXMgbmVlZGVkOlxue1wibmVlZHNRdWVyeVwiOiB0cnVlLCBcImdyZW1saW5RdWVyeVwiOiBcIjx0aGUgZ3JlbWxpbiB0cmF2ZXJzYWwgYWZ0ZXIgZy4+XCIsIFwiZXhwbGFuYXRpb25cIjogXCI8YnJpZWYgZXhwbGFuYXRpb24gb2Ygd2hhdCB0aGUgcXVlcnkgZG9lcz5cIn1cblxuSWYgbm8gcXVlcnkgaXMgbmVlZGVkIChnZW5lcmFsIHF1ZXN0aW9uIGFib3V0IHRoZSBzY2hlbWEsIGdyZWV0aW5ncywgZXRjLik6XG57XCJuZWVkc1F1ZXJ5XCI6IGZhbHNlLCBcImFuc3dlclwiOiBcIjx5b3VyIGFuc3dlcj5cIiwgXCJleHBsYW5hdGlvblwiOiBcIlwifVxuXG5FeGFtcGxlczpcblVzZXI6IFwiV2hvIGFyZSBhbGwgdGhlIHBlb3BsZSBpbiB0aGUgZ3JhcGg/XCJcbntcIm5lZWRzUXVlcnlcIjogdHJ1ZSwgXCJncmVtbGluUXVlcnlcIjogXCJWKCkuaGFzTGFiZWwoJ3BlcnNvbicpLnZhbHVlcygnbmFtZScpLnRvTGlzdCgpXCIsIFwiZXhwbGFuYXRpb25cIjogXCJMaXN0cyBhbGwgcGVyc29uIHZlcnRpY2VzIGJ5IG5hbWVcIn1cblxuVXNlcjogXCJXaGF0IHByb2R1Y3RzIGRvZXMgRG9jdG9yMSB1c2U/XCJcbntcIm5lZWRzUXVlcnlcIjogdHJ1ZSwgXCJncmVtbGluUXVlcnlcIjogXCJWKCkuaGFzKCdwZXJzb24nLCduYW1lJywnRG9jdG9yMScpLm91dCgndXNhZ2UnKS52YWx1ZXMoJ25hbWUnKS50b0xpc3QoKVwiLCBcImV4cGxhbmF0aW9uXCI6IFwiRmluZHMgcHJvZHVjdHMgY29ubmVjdGVkIHRvIERvY3RvcjEgdmlhIHVzYWdlIGVkZ2VzXCJ9XG5cblVzZXI6IFwiSG93IG1hbnkgbm9kZXMgYXJlIGluIHRoZSBncmFwaD9cIlxue1wibmVlZHNRdWVyeVwiOiB0cnVlLCBcImdyZW1saW5RdWVyeVwiOiBcIlYoKS5jb3VudCgpLm5leHQoKVwiLCBcImV4cGxhbmF0aW9uXCI6IFwiQ291bnRzIGFsbCB2ZXJ0aWNlcyBpbiB0aGUgZ3JhcGhcIn1cblxuVXNlcjogXCJXaGF0IHR5cGVzIG9mIHJlbGF0aW9uc2hpcHMgZXhpc3Q/XCJcbntcIm5lZWRzUXVlcnlcIjogZmFsc2UsIFwiYW5zd2VyXCI6IFwiVGhlIGdyYXBoIGhhcyB0aGVzZSByZWxhdGlvbnNoaXAgdHlwZXM6IHVzYWdlLCBiZWxvbmdfdG8sIGF1dGhvcmVkX2J5LCBhZmZpbGlhdGVkX3dpdGgsIGFuZCBtYWRlX2J5LlwiLCBcImV4cGxhbmF0aW9uXCI6IFwiXCJ9XG5gO1xuXG5pbnRlcmZhY2UgQmVkcm9ja01lc3NhZ2Uge1xuICByb2xlOiBzdHJpbmc7XG4gIGNvbnRlbnQ6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIENvbnZlcnNhdGlvbkVudHJ5IHtcbiAgcm9sZTogc3RyaW5nO1xuICBjb250ZW50OiBzdHJpbmc7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGludm9rZUJlZHJvY2sobWVzc2FnZXM6IEJlZHJvY2tNZXNzYWdlW10pOiBQcm9taXNlPHN0cmluZz4ge1xuICAvLyBVc2UgQVdTIFNESyB2MyAtIGR5bmFtaWNhbGx5IGltcG9ydCB0byB3b3JrIHdpdGggTGFtYmRhIGJ1bmRsaW5nXG4gIGNvbnN0IHsgQmVkcm9ja1J1bnRpbWVDbGllbnQsIENvbnZlcnNlQ29tbWFuZCB9ID0gYXdhaXQgaW1wb3J0KFxuICAgIFwiQGF3cy1zZGsvY2xpZW50LWJlZHJvY2stcnVudGltZVwiXG4gICk7XG5cbiAgY29uc3QgY2xpZW50ID0gbmV3IEJlZHJvY2tSdW50aW1lQ2xpZW50KHsgcmVnaW9uOiBCRURST0NLX1JFR0lPTiB9KTtcblxuICBjb25zdCBjb21tYW5kID0gbmV3IENvbnZlcnNlQ29tbWFuZCh7XG4gICAgbW9kZWxJZDogTU9ERUxfSUQsXG4gICAgc3lzdGVtOiBbeyB0ZXh0OiBTWVNURU1fUFJPTVBUIH1dLFxuICAgIG1lc3NhZ2VzOiBtZXNzYWdlcy5tYXAoKG0pID0+ICh7XG4gICAgICByb2xlOiBtLnJvbGUgYXMgXCJ1c2VyXCIgfCBcImFzc2lzdGFudFwiLFxuICAgICAgY29udGVudDogW3sgdGV4dDogbS5jb250ZW50IH1dLFxuICAgIH0pKSxcbiAgICBpbmZlcmVuY2VDb25maWc6IHtcbiAgICAgIG1heFRva2VuczogMTAyNCxcbiAgICB9LFxuICB9KTtcblxuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGNsaWVudC5zZW5kKGNvbW1hbmQpO1xuICBjb25zdCBvdXRwdXQgPSByZXNwb25zZS5vdXRwdXQ/Lm1lc3NhZ2U/LmNvbnRlbnQ7XG4gIGlmICghb3V0cHV0IHx8IG91dHB1dC5sZW5ndGggPT09IDAgfHwgIW91dHB1dFswXS50ZXh0KSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiRW1wdHkgcmVzcG9uc2UgZnJvbSBCZWRyb2NrXCIpO1xuICB9XG4gIHJldHVybiBvdXRwdXRbMF0udGV4dDtcbn1cblxuLy8gR3JlbWxpbiBzdGVwcyB0aGF0IG11dGF0ZSB0aGUgZ3JhcGgg4oCUIHRoZXNlIGFyZSBub3QgYWxsb3dlZCBpbiByZWFkLW9ubHkgbW9kZVxuY29uc3QgTVVUQVRJT05fUEFUVEVSTiA9XG4gIC9cXGIoYWRkVnxhZGRFfGRyb3B8cHJvcGVydHlcXHMqXFwofGl0ZXJhdGVcXHMqXFwofHNpZGVFZmZlY3RcXHMqXFwofGluamVjdFxccypcXCgpXFxiL2k7XG5cbmZ1bmN0aW9uIHZhbGlkYXRlR3JlbWxpblF1ZXJ5KHF1ZXJ5U3RyaW5nOiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKE1VVEFUSU9OX1BBVFRFUk4udGVzdChxdWVyeVN0cmluZykpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIlF1ZXJ5IGNvbnRhaW5zIG11dGF0aW9uIG9wZXJhdGlvbnMgd2hpY2ggYXJlIG5vdCBhbGxvd2VkXCJcbiAgICApO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGV4ZWN1dGVHcmVtbGluKHF1ZXJ5U3RyaW5nOiBzdHJpbmcpOiBQcm9taXNlPHVua25vd24+IHtcbiAgdmFsaWRhdGVHcmVtbGluUXVlcnkocXVlcnlTdHJpbmcpO1xuXG4gIGNvbnN0IHsgdXJsLCBoZWFkZXJzIH0gPSBnZXRVcmxBbmRIZWFkZXJzKFxuICAgIHByb2Nlc3MuZW52Lk5FUFRVTkVfRU5EUE9JTlQsXG4gICAgcHJvY2Vzcy5lbnYuTkVQVFVORV9QT1JULFxuICAgIHt9LFxuICAgIFwiL2dyZW1saW5cIixcbiAgICBcIndzc1wiXG4gICk7XG5cbiAgY29uc3QgY2xpZW50ID0gbmV3IENsaWVudCh1cmwsIHtcbiAgICBtaW1lVHlwZTogXCJhcHBsaWNhdGlvbi92bmQuZ3JlbWxpbi12Mi4wK2pzb25cIixcbiAgICBoZWFkZXJzOiBoZWFkZXJzLFxuICB9KTtcblxuICB0cnkge1xuICAgIC8vIFN1Ym1pdCB0aGUgcXVlcnkgc3RyaW5nIHRvIHRoZSBHcmVtbGluIHNlcnZlciBmb3Igc2VydmVyLXNpZGUgZXhlY3V0aW9uLlxuICAgIC8vIFRoaXMgYXZvaWRzIGxvY2FsIEphdmFTY3JpcHQgZXZhbHVhdGlvbiAobm8gRnVuY3Rpb24gY29uc3RydWN0b3IgLyBldmFsKS5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBjbGllbnQuc3VibWl0KGBnLiR7cXVlcnlTdHJpbmd9YCk7XG4gICAgcmV0dXJuIHJlc3VsdC50b0FycmF5ID8gcmVzdWx0LnRvQXJyYXkoKSA6IHJlc3VsdDtcbiAgfSBmaW5hbGx5IHtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgY2xpZW50LmNsb3NlKCk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgY29uc29sZS53YXJuKFwiRXJyb3IgY2xvc2luZyBjb25uZWN0aW9uOlwiLCBlKTtcbiAgICB9XG4gIH1cbn1cblxuZXhwb3J0IGNvbnN0IGhhbmRsZXI6IEhhbmRsZXIgPSBhc3luYyAoZXZlbnQpID0+IHtcbiAgY29uc29sZS5sb2coXCJBSSBRdWVyeSBldmVudDpcIiwgSlNPTi5zdHJpbmdpZnkoZXZlbnQpKTtcblxuICBjb25zdCBxdWVzdGlvbiA9IGV2ZW50LmFyZ3VtZW50cz8ucXVlc3Rpb247XG4gIGNvbnN0IGNvbnZlcnNhdGlvbkhpc3Rvcnk6IENvbnZlcnNhdGlvbkVudHJ5W10gPSBldmVudC5hcmd1bWVudHM/Lmhpc3RvcnlcbiAgICA/IEpTT04ucGFyc2UoZXZlbnQuYXJndW1lbnRzLmhpc3RvcnkpXG4gICAgOiBbXTtcblxuICBpZiAoIXF1ZXN0aW9uKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGFuc3dlcjpcbiAgICAgICAgXCJQbGVhc2UgYXNrIGEgcXVlc3Rpb24gYWJvdXQgdGhlIGdyYXBoIGRhdGEuIEZvciBleGFtcGxlOiAnV2hvIGFyZSBhbGwgdGhlIHBlb3BsZSBpbiB0aGUgZ3JhcGg/JyBvciAnV2hhdCBwcm9kdWN0cyBkb2VzIERvY3RvcjEgdXNlPydcIixcbiAgICAgIHF1ZXJ5OiBudWxsLFxuICAgICAgZGF0YTogbnVsbCxcbiAgICB9O1xuICB9XG5cbiAgdHJ5IHtcbiAgICAvLyBCdWlsZCBtZXNzYWdlcyBmb3IgQmVkcm9jayBpbmNsdWRpbmcgY29udmVyc2F0aW9uIGhpc3RvcnlcbiAgICBjb25zdCBtZXNzYWdlczogQmVkcm9ja01lc3NhZ2VbXSA9IFtdO1xuXG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiBjb252ZXJzYXRpb25IaXN0b3J5KSB7XG4gICAgICBtZXNzYWdlcy5wdXNoKHtcbiAgICAgICAgcm9sZTogZW50cnkucm9sZSA9PT0gXCJ1c2VyXCIgPyBcInVzZXJcIiA6IFwiYXNzaXN0YW50XCIsXG4gICAgICAgIGNvbnRlbnQ6IGVudHJ5LmNvbnRlbnQsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBtZXNzYWdlcy5wdXNoKHtcbiAgICAgIHJvbGU6IFwidXNlclwiLFxuICAgICAgY29udGVudDogcXVlc3Rpb24sXG4gICAgfSk7XG5cbiAgICAvLyBDb252ZXJzZSBBUEkgcmVxdWlyZXMgZmlyc3QgbWVzc2FnZSB0byBiZSBmcm9tIFwidXNlclwiIOKAlCBzdHJpcCBsZWFkaW5nIGFzc2lzdGFudCBtZXNzYWdlc1xuICAgIHdoaWxlIChtZXNzYWdlcy5sZW5ndGggPiAwICYmIG1lc3NhZ2VzWzBdLnJvbGUgIT09IFwidXNlclwiKSB7XG4gICAgICBtZXNzYWdlcy5zaGlmdCgpO1xuICAgIH1cblxuICAgIGNvbnNvbGUubG9nKFwiU2VuZGluZyBtZXNzYWdlcyB0byBCZWRyb2NrOlwiLCBKU09OLnN0cmluZ2lmeShtZXNzYWdlcy5tYXAobSA9PiAoeyByb2xlOiBtLnJvbGUsIGxlbjogbS5jb250ZW50Lmxlbmd0aCB9KSkpKTtcblxuICAgIC8vIENhbGwgQmVkcm9jayB0byBpbnRlcnByZXQgdGhlIHF1ZXN0aW9uXG4gICAgY29uc3QgYmVkcm9ja1Jlc3BvbnNlID0gYXdhaXQgaW52b2tlQmVkcm9jayhtZXNzYWdlcyk7XG4gICAgY29uc29sZS5sb2coXCJCZWRyb2NrIHJlc3BvbnNlOlwiLCBiZWRyb2NrUmVzcG9uc2UpO1xuXG4gICAgLy8gUGFyc2UgQmVkcm9jaydzIHJlc3BvbnNlIC0gZXh0cmFjdCBKU09OIGZyb20gdGhlIHRleHRcbiAgICBsZXQgcGFyc2VkO1xuICAgIHRyeSB7XG4gICAgICAvLyBUcnkgdG8gZXh0cmFjdCBKU09OIGZyb20gdGhlIHJlc3BvbnNlXG4gICAgICBjb25zdCBqc29uTWF0Y2ggPSBiZWRyb2NrUmVzcG9uc2UubWF0Y2goL1xce1tcXHNcXFNdKlxcfS8pO1xuICAgICAgaWYgKGpzb25NYXRjaCkge1xuICAgICAgICBwYXJzZWQgPSBKU09OLnBhcnNlKGpzb25NYXRjaFswXSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBwYXJzZWQgPSBKU09OLnBhcnNlKGJlZHJvY2tSZXNwb25zZSk7XG4gICAgICB9XG4gICAgfSBjYXRjaCAocGFyc2VFcnJvcikge1xuICAgICAgY29uc29sZS5lcnJvcihcIkZhaWxlZCB0byBwYXJzZSBCZWRyb2NrIHJlc3BvbnNlOlwiLCBwYXJzZUVycm9yKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGFuc3dlcjogYmVkcm9ja1Jlc3BvbnNlLFxuICAgICAgICBxdWVyeTogbnVsbCxcbiAgICAgICAgZGF0YTogbnVsbCxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgaWYgKCFwYXJzZWQubmVlZHNRdWVyeSkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgYW5zd2VyOiBwYXJzZWQuYW5zd2VyIHx8IGJlZHJvY2tSZXNwb25zZSxcbiAgICAgICAgcXVlcnk6IG51bGwsXG4gICAgICAgIGRhdGE6IG51bGwsXG4gICAgICB9O1xuICAgIH1cblxuICAgIC8vIEV4ZWN1dGUgdGhlIEdyZW1saW4gcXVlcnlcbiAgICBjb25zdCBncmVtbGluUXVlcnkgPSBwYXJzZWQuZ3JlbWxpblF1ZXJ5O1xuICAgIGNvbnNvbGUubG9nKFwiRXhlY3V0aW5nIEdyZW1saW4gcXVlcnk6XCIsIGdyZW1saW5RdWVyeSk7XG5cbiAgICBsZXQgcXVlcnlSZXN1bHQ7XG4gICAgdHJ5IHtcbiAgICAgIHF1ZXJ5UmVzdWx0ID0gYXdhaXQgZXhlY3V0ZUdyZW1saW4oZ3JlbWxpblF1ZXJ5KTtcbiAgICB9IGNhdGNoIChxdWVyeUVycm9yOiB1bmtub3duKSB7XG4gICAgICBjb25zb2xlLmVycm9yKFwiR3JlbWxpbiBxdWVyeSBlcnJvcjpcIiwgcXVlcnlFcnJvcik7XG4gICAgICBjb25zdCBlcnJvck1lc3NhZ2UgPVxuICAgICAgICBxdWVyeUVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBxdWVyeUVycm9yLm1lc3NhZ2UgOiBTdHJpbmcocXVlcnlFcnJvcik7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBhbnN3ZXI6IGBJIHRyaWVkIHRvIHF1ZXJ5IHRoZSBncmFwaCBidXQgZW5jb3VudGVyZWQgYW4gZXJyb3IuIFRoZSBxdWVyeSB3YXM6IGcuJHtncmVtbGluUXVlcnl9LiBFcnJvcjogJHtlcnJvck1lc3NhZ2V9YCxcbiAgICAgICAgcXVlcnk6IGBnLiR7Z3JlbWxpblF1ZXJ5fWAsXG4gICAgICAgIGRhdGE6IG51bGwsXG4gICAgICB9O1xuICAgIH1cblxuICAgIC8vIEZvcm1hdCB0aGUgcmVzdWx0XG4gICAgY29uc3QgcmVzdWx0U3RyID0gSlNPTi5zdHJpbmdpZnkocXVlcnlSZXN1bHQsIG51bGwsIDIpO1xuICAgIGNvbnNvbGUubG9nKFwiUXVlcnkgcmVzdWx0OlwiLCByZXN1bHRTdHIpO1xuXG4gICAgLy8gQXNrIEJlZHJvY2sgdG8gc3VtbWFyaXplIHRoZSByZXN1bHRzXG4gICAgY29uc3Qgc3VtbWFyeU1lc3NhZ2VzOiBCZWRyb2NrTWVzc2FnZVtdID0gW1xuICAgICAgLi4ubWVzc2FnZXMsXG4gICAgICB7XG4gICAgICAgIHJvbGU6IFwiYXNzaXN0YW50XCIsXG4gICAgICAgIGNvbnRlbnQ6IGBJIGV4ZWN1dGVkIHRoZSBHcmVtbGluIHF1ZXJ5OiBnLiR7Z3JlbWxpblF1ZXJ5fWAsXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICByb2xlOiBcInVzZXJcIixcbiAgICAgICAgY29udGVudDogYFRoZSBxdWVyeSByZXR1cm5lZCB0aGVzZSByZXN1bHRzOiAke3Jlc3VsdFN0cn1cXG5cXG5QbGVhc2UgcHJvdmlkZSBhIGNsZWFyLCBjb25jaXNlIG5hdHVyYWwgbGFuZ3VhZ2Ugc3VtbWFyeSBvZiB0aGVzZSByZXN1bHRzIHRvIGFuc3dlciBteSBvcmlnaW5hbCBxdWVzdGlvbi4gRG8gbm90IHJldHVybiBKU09OLCBqdXN0IGEgcGxhaW4gdGV4dCBhbnN3ZXIuYCxcbiAgICAgIH0sXG4gICAgXTtcblxuICAgIGNvbnN0IHN1bW1hcnkgPSBhd2FpdCBpbnZva2VCZWRyb2NrKHN1bW1hcnlNZXNzYWdlcyk7XG5cbiAgICByZXR1cm4ge1xuICAgICAgYW5zd2VyOiBzdW1tYXJ5LFxuICAgICAgcXVlcnk6IGBnLiR7Z3JlbWxpblF1ZXJ5fWAsXG4gICAgICBkYXRhOiByZXN1bHRTdHIsXG4gICAgfTtcbiAgfSBjYXRjaCAoZXJyb3I6IHVua25vd24pIHtcbiAgICBjb25zb2xlLmVycm9yKFwiQUkgUXVlcnkgZXJyb3I6XCIsIGVycm9yKTtcbiAgICBjb25zdCBlcnJvck1lc3NhZ2UgPVxuICAgICAgZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xuICAgIHJldHVybiB7XG4gICAgICBhbnN3ZXI6IGBTb3JyeSwgSSBlbmNvdW50ZXJlZCBhbiBlcnJvciBwcm9jZXNzaW5nIHlvdXIgcXVlc3Rpb246ICR7ZXJyb3JNZXNzYWdlfWAsXG4gICAgICBxdWVyeTogbnVsbCxcbiAgICAgIGRhdGE6IG51bGwsXG4gICAgfTtcbiAgfVxufTtcbiJdfQ==
