"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const gremlin = require("gremlin");
const utils_1 = require("gremlin-aws-sigv4/lib/utils");
const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const P = gremlin.process.P;
const BEDROCK_REGION = process.env.BEDROCK_REGION || "us-east-1";
const MODEL_ID = process.env.MODEL_ID || "anthropic.claude-3-haiku-20240307-v1:0";
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
    const { BedrockRuntimeClient, InvokeModelCommand } = await Promise.resolve().then(() => require("@aws-sdk/client-bedrock-runtime"));
    const client = new BedrockRuntimeClient({ region: BEDROCK_REGION });
    const body = JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages,
    });
    const command = new InvokeModelCommand({
        modelId: MODEL_ID,
        contentType: "application/json",
        accept: "application/json",
        body: new TextEncoder().encode(body),
    });
    const response = await client.send(command);
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    return responseBody.content[0].text;
}
function createRemoteConnection() {
    const { url, headers } = (0, utils_1.getUrlAndHeaders)(process.env.NEPTUNE_ENDPOINT, process.env.NEPTUNE_PORT, {}, "/gremlin", "wss");
    const c = new DriverRemoteConnection(url, {
        mimeType: "application/vnd.gremlin-v2.0+json",
        headers: headers,
    });
    c._client._connection.on("close", (code, message) => {
        console.info(`close - ${code} ${message}`);
        if (code === 1006) {
            console.error("Connection closed prematurely");
            throw new Error("Connection closed prematurely");
        }
    });
    return c;
}
async function executeGremlin(queryString) {
    const conn = createRemoteConnection();
    const g = traversal().withRemote(conn);
    try {
        // Build the traversal dynamically by evaluating the query string
        // We use Function constructor to safely evaluate the Gremlin query
        const queryFn = new Function("g", "P", `return g.${queryString}`);
        const result = await queryFn(g, P);
        return result;
    }
    finally {
        try {
            await conn.close();
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYWlRdWVyeS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImFpUXVlcnkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQ0EsbUNBQW1DO0FBQ25DLHVEQUErRDtBQUUvRCxNQUFNLHNCQUFzQixHQUFHLE9BQU8sQ0FBQyxNQUFNLENBQUMsc0JBQXNCLENBQUM7QUFDckUsTUFBTSxTQUFTLEdBQUcsT0FBTyxDQUFDLE9BQU8sQ0FBQyx3QkFBd0IsQ0FBQyxTQUFTLENBQUM7QUFDckUsTUFBTSxDQUFDLEdBQUcsT0FBTyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7QUFFNUIsTUFBTSxjQUFjLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxjQUFjLElBQUksV0FBVyxDQUFDO0FBQ2pFLE1BQU0sUUFBUSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsUUFBUSxJQUFJLHdDQUF3QyxDQUFDO0FBRWxGLE1BQU0sWUFBWSxHQUFHOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FrQnBCLENBQUM7QUFFRixNQUFNLGFBQWEsR0FBRzs7RUFFcEIsWUFBWTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBOEJiLENBQUM7QUFZRixLQUFLLFVBQVUsYUFBYSxDQUFDLFFBQTBCO0lBQ3JELG1FQUFtRTtJQUNuRSxNQUFNLEVBQUUsb0JBQW9CLEVBQUUsa0JBQWtCLEVBQUUsR0FBRywyQ0FDbkQsaUNBQWlDLEVBQ2xDLENBQUM7SUFFRixNQUFNLE1BQU0sR0FBRyxJQUFJLG9CQUFvQixDQUFDLEVBQUUsTUFBTSxFQUFFLGNBQWMsRUFBRSxDQUFDLENBQUM7SUFFcEUsTUFBTSxJQUFJLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQztRQUMxQixpQkFBaUIsRUFBRSxvQkFBb0I7UUFDdkMsVUFBVSxFQUFFLElBQUk7UUFDaEIsTUFBTSxFQUFFLGFBQWE7UUFDckIsUUFBUTtLQUNULENBQUMsQ0FBQztJQUVILE1BQU0sT0FBTyxHQUFHLElBQUksa0JBQWtCLENBQUM7UUFD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QUFXLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDO1FBQ3ZELE9BQU8sQ0FBQyxHQUFHLENBQUMsZUFBZSxFQUFFLFNBQVMsQ0FBQyxDQUFDO1FBRXhDLHVDQUF1QztRQUN2QyxNQUFNLGVBQWUsR0FBcUI7WUFDeEMsR0FBRyxRQUFRO1lBQ1g7Z0JBQ0UsSUFBSSxFQUFFLFdBQVc7Z0JBQ2pCLE9BQU8sRUFBRSxtQ0FBbUMsWUFBWSxFQUFFO2FBQzNEO1lBQ0Q7Z0JBQ0UsSUFBSSxFQUFFLE1BQU07Z0JBQ1osT0FBTyxFQUFFLHFDQUFxQyxTQUFTLDZKQUE2SjthQUNyTjtTQUNGLENBQUM7UUFFRixNQUFNLE9BQU8sR0FBRyxNQUFNLGFBQWEsQ0FBQyxlQUFlLENBQUMsQ0FBQztRQUVyRCxPQUFPO1lBQ0wsTUFBTSxFQUFFLE9BQU87WUFDZixLQUFLLEVBQUUsS0FBSyxZQUFZLEVBQUU7WUFDMUIsSUFBSSxFQUFFLFNBQVM7U0FDaEIsQ0FBQztJQUNKLENBQUM7SUFBQyxPQUFPLEtBQWMsRUFBRSxDQUFDO1FBQ3hCLE9BQU8sQ0FBQyxLQUFLLENBQUMsaUJBQWlCLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFDeEMsTUFBTSxZQUFZLEdBQ2hCLEtBQUssWUFBWSxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUN6RCxPQUFPO1lBQ0wsTUFBTSxFQUFFLDJEQUEyRCxZQUFZLEVBQUU7WUFDakYsS0FBSyxFQUFFLElBQUk7WUFDWCxJQUFJLEVBQUUsSUFBSTtTQUNYLENBQUM7SUFDSixDQUFDO0FBQ0gsQ0FBQyxDQUFDO0FBcEhXLFFBQUEsT0FBTyxXQW9IbEIiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBIYW5kbGVyIH0gZnJvbSBcImF3cy1sYW1iZGFcIjtcbmltcG9ydCAqIGFzIGdyZW1saW4gZnJvbSBcImdyZW1saW5cIjtcbmltcG9ydCB7IGdldFVybEFuZEhlYWRlcnMgfSBmcm9tIFwiZ3JlbWxpbi1hd3Mtc2lndjQvbGliL3V0aWxzXCI7XG5cbmNvbnN0IERyaXZlclJlbW90ZUNvbm5lY3Rpb24gPSBncmVtbGluLmRyaXZlci5Ecml2ZXJSZW1vdGVDb25uZWN0aW9uO1xuY29uc3QgdHJhdmVyc2FsID0gZ3JlbWxpbi5wcm9jZXNzLkFub255bW91c1RyYXZlcnNhbFNvdXJjZS50cmF2ZXJzYWw7XG5jb25zdCBQID0gZ3JlbWxpbi5wcm9jZXNzLlA7XG5cbmNvbnN0IEJFRFJPQ0tfUkVHSU9OID0gcHJvY2Vzcy5lbnYuQkVEUk9DS19SRUdJT04gfHwgXCJ1cy1lYXN0LTFcIjtcbmNvbnN0IE1PREVMX0lEID0gcHJvY2Vzcy5lbnYuTU9ERUxfSUQgfHwgXCJhbnRocm9waWMuY2xhdWRlLTMtaGFpa3UtMjAyNDAzMDctdjE6MFwiO1xuXG5jb25zdCBHUkFQSF9TQ0hFTUEgPSBgXG5HcmFwaCBTY2hlbWE6XG4tIFZlcnRleCBsYWJlbHM6IHBlcnNvbiwgcHJvZHVjdCwgY29uZmVyZW5jZSwgaW5zdGl0dXRpb24sIGRvY3VtZW50XG4tIEVkZ2UgbGFiZWxzOiB1c2FnZSwgYmVsb25nX3RvLCBhdXRob3JlZF9ieSwgYWZmaWxpYXRlZF93aXRoLCBtYWRlX2J5XG4tIEFsbCB2ZXJ0aWNlcyBoYXZlIGEgXCJuYW1lXCIgcHJvcGVydHlcbi0gRWRnZSBcInVzYWdlXCIgY29ubmVjdHMgcGVyc29uIC0+IHByb2R1Y3QgKHdpdGggbnVtZXJpYyB3ZWlnaHQpXG4tIEVkZ2UgXCJiZWxvbmdfdG9cIiBjb25uZWN0cyBkb2N1bWVudCAtPiBjb25mZXJlbmNlXG4tIEVkZ2UgXCJhdXRob3JlZF9ieVwiIGNvbm5lY3RzIGRvY3VtZW50IC0+IHBlcnNvblxuLSBFZGdlIFwiYWZmaWxpYXRlZF93aXRoXCIgY29ubmVjdHMgcGVyc29uIC0+IGluc3RpdHV0aW9uXG4tIEVkZ2UgXCJtYWRlX2J5XCIgY29ubmVjdHMgcHJvZHVjdCAtPiBwZXJzb24vaW5zdGl0dXRpb25cblxuRXhhbXBsZSBHcmVtbGluIHF1ZXJpZXM6XG4tIEdldCBhbGwgcGVvcGxlOiBnLlYoKS5oYXNMYWJlbCgncGVyc29uJykudmFsdWVzKCduYW1lJykudG9MaXN0KClcbi0gR2V0IHByb2R1Y3RzIHVzZWQgYnkgYSBwZXJzb246IGcuVigpLmhhcygncGVyc29uJywnbmFtZScsJ0RvY3RvcjEnKS5vdXQoJ3VzYWdlJykudmFsdWVzKCduYW1lJykudG9MaXN0KClcbi0gQ291bnQgdmVydGljZXM6IGcuVigpLmNvdW50KCkubmV4dCgpXG4tIENvdW50IGVkZ2VzOiBnLkUoKS5jb3VudCgpLm5leHQoKVxuLSBHZXQgYWxsIHZlcnRleCBsYWJlbHM6IGcuVigpLmxhYmVsKCkuZGVkdXAoKS50b0xpc3QoKVxuLSBHZXQgbmVpZ2hib3JzIG9mIGEgdmVydGV4OiBnLlYoKS5oYXMoJ3BlcnNvbicsJ25hbWUnLCdEb2N0b3IxJykuYm90aCgpLnZhbHVlcygnbmFtZScpLnRvTGlzdCgpXG5gO1xuXG5jb25zdCBTWVNURU1fUFJPTVBUID0gYFlvdSBhcmUgYSBncmFwaCBkYXRhYmFzZSBhc3Npc3RhbnQgZm9yIEFtYXpvbiBOZXB0dW5lLiBZb3UgaGVscCB1c2VycyBxdWVyeSBhIGdyYXBoIGRhdGFiYXNlIHVzaW5nIG5hdHVyYWwgbGFuZ3VhZ2UuXG5cbiR7R1JBUEhfU0NIRU1BfVxuXG5XaGVuIGEgdXNlciBhc2tzIGEgcXVlc3Rpb24gYWJvdXQgdGhlIGdyYXBoIGRhdGE6XG4xLiBEZXRlcm1pbmUgaWYgeW91IG5lZWQgdG8gcXVlcnkgdGhlIGdyYXBoIHRvIGFuc3dlclxuMi4gSWYgeWVzLCBnZW5lcmF0ZSBhIEdyZW1saW4gcXVlcnlcbjMuIFJldHVybiB5b3VyIHJlc3BvbnNlIGFzIEpTT05cblxuSU1QT1JUQU5UIFJVTEVTOlxuLSBPbmx5IGdlbmVyYXRlIFJFQUQgcXVlcmllcyAobm8gbXV0YXRpb25zL2Ryb3BzKVxuLSBVc2UgdGhlIEdyZW1saW4gdHJhdmVyc2FsIGxhbmd1YWdlXG4tIEFsd2F5cyByZXR1cm4gdmFsaWQgSlNPTiBpbiB0aGlzIGV4YWN0IGZvcm1hdDpcblxuSWYgYSBxdWVyeSBpcyBuZWVkZWQ6XG57XCJuZWVkc1F1ZXJ5XCI6IHRydWUsIFwiZ3JlbWxpblF1ZXJ5XCI6IFwiPHRoZSBncmVtbGluIHRyYXZlcnNhbCBhZnRlciBnLj5cIiwgXCJleHBsYW5hdGlvblwiOiBcIjxicmllZiBleHBsYW5hdGlvbiBvZiB3aGF0IHRoZSBxdWVyeSBkb2VzPlwifVxuXG5JZiBubyBxdWVyeSBpcyBuZWVkZWQgKGdlbmVyYWwgcXVlc3Rpb24gYWJvdXQgdGhlIHNjaGVtYSwgZ3JlZXRpbmdzLCBldGMuKTpcbntcIm5lZWRzUXVlcnlcIjogZmFsc2UsIFwiYW5zd2VyXCI6IFwiPHlvdXIgYW5zd2VyPlwiLCBcImV4cGxhbmF0aW9uXCI6IFwiXCJ9XG5cbkV4YW1wbGVzOlxuVXNlcjogXCJXaG8gYXJlIGFsbCB0aGUgcGVvcGxlIGluIHRoZSBncmFwaD9cIlxue1wibmVlZHNRdWVyeVwiOiB0cnVlLCBcImdyZW1saW5RdWVyeVwiOiBcIlYoKS5oYXNMYWJlbCgncGVyc29uJykudmFsdWVzKCduYW1lJykudG9MaXN0KClcIiwgXCJleHBsYW5hdGlvblwiOiBcIkxpc3RzIGFsbCBwZXJzb24gdmVydGljZXMgYnkgbmFtZVwifVxuXG5Vc2VyOiBcIldoYXQgcHJvZHVjdHMgZG9lcyBEb2N0b3IxIHVzZT9cIlxue1wibmVlZHNRdWVyeVwiOiB0cnVlLCBcImdyZW1saW5RdWVyeVwiOiBcIlYoKS5oYXMoJ3BlcnNvbicsJ25hbWUnLCdEb2N0b3IxJykub3V0KCd1c2FnZScpLnZhbHVlcygnbmFtZScpLnRvTGlzdCgpXCIsIFwiZXhwbGFuYXRpb25cIjogXCJGaW5kcyBwcm9kdWN0cyBjb25uZWN0ZWQgdG8gRG9jdG9yMSB2aWEgdXNhZ2UgZWRnZXNcIn1cblxuVXNlcjogXCJIb3cgbWFueSBub2RlcyBhcmUgaW4gdGhlIGdyYXBoP1wiXG57XCJuZWVkc1F1ZXJ5XCI6IHRydWUsIFwiZ3JlbWxpblF1ZXJ5XCI6IFwiVigpLmNvdW50KCkubmV4dCgpXCIsIFwiZXhwbGFuYXRpb25cIjogXCJDb3VudHMgYWxsIHZlcnRpY2VzIGluIHRoZSBncmFwaFwifVxuXG5Vc2VyOiBcIldoYXQgdHlwZXMgb2YgcmVsYXRpb25zaGlwcyBleGlzdD9cIlxue1wibmVlZHNRdWVyeVwiOiBmYWxzZSwgXCJhbnN3ZXJcIjogXCJUaGUgZ3JhcGggaGFzIHRoZXNlIHJlbGF0aW9uc2hpcCB0eXBlczogdXNhZ2UsIGJlbG9uZ190bywgYXV0aG9yZWRfYnksIGFmZmlsaWF0ZWRfd2l0aCwgYW5kIG1hZGVfYnkuXCIsIFwiZXhwbGFuYXRpb25cIjogXCJcIn1cbmA7XG5cbmludGVyZmFjZSBCZWRyb2NrTWVzc2FnZSB7XG4gIHJvbGU6IHN0cmluZztcbiAgY29udGVudDogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgQ29udmVyc2F0aW9uRW50cnkge1xuICByb2xlOiBzdHJpbmc7XG4gIGNvbnRlbnQ6IHN0cmluZztcbn1cblxuYXN5bmMgZnVuY3Rpb24gaW52b2tlQmVkcm9jayhtZXNzYWdlczogQmVkcm9ja01lc3NhZ2VbXSk6IFByb21pc2U8c3RyaW5nPiB7XG4gIC8vIFVzZSBBV1MgU0RLIHYzIC0gZHluYW1pY2FsbHkgaW1wb3J0IHRvIHdvcmsgd2l0aCBMYW1iZGEgYnVuZGxpbmdcbiAgY29uc3QgeyBCZWRyb2NrUnVudGltZUNsaWVudCwgSW52b2tlTW9kZWxDb21tYW5kIH0gPSBhd2FpdCBpbXBvcnQoXG4gICAgXCJAYXdzLXNkay9jbGllbnQtYmVkcm9jay1ydW50aW1lXCJcbiAgKTtcblxuICBjb25zdCBjbGllbnQgPSBuZXcgQmVkcm9ja1J1bnRpbWVDbGllbnQoeyByZWdpb246IEJFRFJPQ0tfUkVHSU9OIH0pO1xuXG4gIGNvbnN0IGJvZHkgPSBKU09OLnN0cmluZ2lmeSh7XG4gICAgYW50aHJvcGljX3ZlcnNpb246IFwiYmVkcm9jay0yMDIzLTA1LTMxXCIsXG4gICAgbWF4X3Rva2VuczogMTAyNCxcbiAgICBzeXN0ZW06IFNZU1RFTV9QUk9NUFQsXG4gICAgbWVzc2FnZXMsXG4gIH0pO1xuXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgSW52b2tlTW9kZWxDb21tYW5kKHtcbiAgICBtb2RlbElkOiBNT0RFTF9JRCxcbiAgICBjb250ZW50VHlwZTogXCJhcHBsaWNhdGlvbi9qc29uXCIsXG4gICAgYWNjZXB0OiBcImFwcGxpY2F0aW9uL2pzb25cIixcbiAgICBib2R5OiBuZXcgVGV4dEVuY29kZXIoKS5lbmNvZGUoYm9keSksXG4gIH0pO1xuXG4gIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgY2xpZW50LnNlbmQoY29tbWFuZCk7XG4gIGNvbnN0IHJlc3BvbnNlQm9keSA9IEpTT04ucGFyc2UobmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKHJlc3BvbnNlLmJvZHkpKTtcbiAgcmV0dXJuIHJlc3BvbnNlQm9keS5jb250ZW50WzBdLnRleHQ7XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZVJlbW90ZUNvbm5lY3Rpb24oKSB7XG4gIGNvbnN0IHsgdXJsLCBoZWFkZXJzIH0gPSBnZXRVcmxBbmRIZWFkZXJzKFxuICAgIHByb2Nlc3MuZW52Lk5FUFRVTkVfRU5EUE9JTlQsXG4gICAgcHJvY2Vzcy5lbnYuTkVQVFVORV9QT1JULFxuICAgIHt9LFxuICAgIFwiL2dyZW1saW5cIixcbiAgICBcIndzc1wiXG4gICk7XG5cbiAgY29uc3QgYyA9IG5ldyBEcml2ZXJSZW1vdGVDb25uZWN0aW9uKHVybCwge1xuICAgIG1pbWVUeXBlOiBcImFwcGxpY2F0aW9uL3ZuZC5ncmVtbGluLXYyLjAranNvblwiLFxuICAgIGhlYWRlcnM6IGhlYWRlcnMsXG4gIH0pO1xuXG4gIGMuX2NsaWVudC5fY29ubmVjdGlvbi5vbihcImNsb3NlXCIsIChjb2RlOiBudW1iZXIsIG1lc3NhZ2U6IHN0cmluZykgPT4ge1xuICAgIGNvbnNvbGUuaW5mbyhgY2xvc2UgLSAke2NvZGV9ICR7bWVzc2FnZX1gKTtcbiAgICBpZiAoY29kZSA9PT0gMTAwNikge1xuICAgICAgY29uc29sZS5lcnJvcihcIkNvbm5lY3Rpb24gY2xvc2VkIHByZW1hdHVyZWx5XCIpO1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQ29ubmVjdGlvbiBjbG9zZWQgcHJlbWF0dXJlbHlcIik7XG4gICAgfVxuICB9KTtcblxuICByZXR1cm4gYztcbn1cblxuYXN5bmMgZnVuY3Rpb24gZXhlY3V0ZUdyZW1saW4ocXVlcnlTdHJpbmc6IHN0cmluZyk6IFByb21pc2U8dW5rbm93bj4ge1xuICBjb25zdCBjb25uID0gY3JlYXRlUmVtb3RlQ29ubmVjdGlvbigpO1xuICBjb25zdCBnID0gdHJhdmVyc2FsKCkud2l0aFJlbW90ZShjb25uKTtcblxuICB0cnkge1xuICAgIC8vIEJ1aWxkIHRoZSB0cmF2ZXJzYWwgZHluYW1pY2FsbHkgYnkgZXZhbHVhdGluZyB0aGUgcXVlcnkgc3RyaW5nXG4gICAgLy8gV2UgdXNlIEZ1bmN0aW9uIGNvbnN0cnVjdG9yIHRvIHNhZmVseSBldmFsdWF0ZSB0aGUgR3JlbWxpbiBxdWVyeVxuICAgIGNvbnN0IHF1ZXJ5Rm4gPSBuZXcgRnVuY3Rpb24oXG4gICAgICBcImdcIixcbiAgICAgIFwiUFwiLFxuICAgICAgYHJldHVybiBnLiR7cXVlcnlTdHJpbmd9YFxuICAgICk7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcXVlcnlGbihnLCBQKTtcbiAgICByZXR1cm4gcmVzdWx0O1xuICB9IGZpbmFsbHkge1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBjb25uLmNsb3NlKCk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgY29uc29sZS53YXJuKFwiRXJyb3IgY2xvc2luZyBjb25uZWN0aW9uOlwiLCBlKTtcbiAgICB9XG4gIH1cbn1cblxuZXhwb3J0IGNvbnN0IGhhbmRsZXI6IEhhbmRsZXIgPSBhc3luYyAoZXZlbnQpID0+IHtcbiAgY29uc29sZS5sb2coXCJBSSBRdWVyeSBldmVudDpcIiwgSlNPTi5zdHJpbmdpZnkoZXZlbnQpKTtcblxuICBjb25zdCBxdWVzdGlvbiA9IGV2ZW50LmFyZ3VtZW50cz8ucXVlc3Rpb247XG4gIGNvbnN0IGNvbnZlcnNhdGlvbkhpc3Rvcnk6IENvbnZlcnNhdGlvbkVudHJ5W10gPSBldmVudC5hcmd1bWVudHM/Lmhpc3RvcnlcbiAgICA/IEpTT04ucGFyc2UoZXZlbnQuYXJndW1lbnRzLmhpc3RvcnkpXG4gICAgOiBbXTtcblxuICBpZiAoIXF1ZXN0aW9uKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGFuc3dlcjpcbiAgICAgICAgXCJQbGVhc2UgYXNrIGEgcXVlc3Rpb24gYWJvdXQgdGhlIGdyYXBoIGRhdGEuIEZvciBleGFtcGxlOiAnV2hvIGFyZSBhbGwgdGhlIHBlb3BsZSBpbiB0aGUgZ3JhcGg/JyBvciAnV2hhdCBwcm9kdWN0cyBkb2VzIERvY3RvcjEgdXNlPydcIixcbiAgICAgIHF1ZXJ5OiBudWxsLFxuICAgICAgZGF0YTogbnVsbCxcbiAgICB9O1xuICB9XG5cbiAgdHJ5IHtcbiAgICAvLyBCdWlsZCBtZXNzYWdlcyBmb3IgQmVkcm9jayBpbmNsdWRpbmcgY29udmVyc2F0aW9uIGhpc3RvcnlcbiAgICBjb25zdCBtZXNzYWdlczogQmVkcm9ja01lc3NhZ2VbXSA9IFtdO1xuXG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiBjb252ZXJzYXRpb25IaXN0b3J5KSB7XG4gICAgICBtZXNzYWdlcy5wdXNoKHtcbiAgICAgICAgcm9sZTogZW50cnkucm9sZSA9PT0gXCJ1c2VyXCIgPyBcInVzZXJcIiA6IFwiYXNzaXN0YW50XCIsXG4gICAgICAgIGNvbnRlbnQ6IGVudHJ5LmNvbnRlbnQsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBtZXNzYWdlcy5wdXNoKHtcbiAgICAgIHJvbGU6IFwidXNlclwiLFxuICAgICAgY29udGVudDogcXVlc3Rpb24sXG4gICAgfSk7XG5cbiAgICAvLyBDYWxsIEJlZHJvY2sgdG8gaW50ZXJwcmV0IHRoZSBxdWVzdGlvblxuICAgIGNvbnN0IGJlZHJvY2tSZXNwb25zZSA9IGF3YWl0IGludm9rZUJlZHJvY2sobWVzc2FnZXMpO1xuICAgIGNvbnNvbGUubG9nKFwiQmVkcm9jayByZXNwb25zZTpcIiwgYmVkcm9ja1Jlc3BvbnNlKTtcblxuICAgIC8vIFBhcnNlIEJlZHJvY2sncyByZXNwb25zZSAtIGV4dHJhY3QgSlNPTiBmcm9tIHRoZSB0ZXh0XG4gICAgbGV0IHBhcnNlZDtcbiAgICB0cnkge1xuICAgICAgLy8gVHJ5IHRvIGV4dHJhY3QgSlNPTiBmcm9tIHRoZSByZXNwb25zZVxuICAgICAgY29uc3QganNvbk1hdGNoID0gYmVkcm9ja1Jlc3BvbnNlLm1hdGNoKC9cXHtbXFxzXFxTXSpcXH0vKTtcbiAgICAgIGlmIChqc29uTWF0Y2gpIHtcbiAgICAgICAgcGFyc2VkID0gSlNPTi5wYXJzZShqc29uTWF0Y2hbMF0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcGFyc2VkID0gSlNPTi5wYXJzZShiZWRyb2NrUmVzcG9uc2UpO1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKHBhcnNlRXJyb3IpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoXCJGYWlsZWQgdG8gcGFyc2UgQmVkcm9jayByZXNwb25zZTpcIiwgcGFyc2VFcnJvcik7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBhbnN3ZXI6IGJlZHJvY2tSZXNwb25zZSxcbiAgICAgICAgcXVlcnk6IG51bGwsXG4gICAgICAgIGRhdGE6IG51bGwsXG4gICAgICB9O1xuICAgIH1cblxuICAgIGlmICghcGFyc2VkLm5lZWRzUXVlcnkpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGFuc3dlcjogcGFyc2VkLmFuc3dlciB8fCBiZWRyb2NrUmVzcG9uc2UsXG4gICAgICAgIHF1ZXJ5OiBudWxsLFxuICAgICAgICBkYXRhOiBudWxsLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyBFeGVjdXRlIHRoZSBHcmVtbGluIHF1ZXJ5XG4gICAgY29uc3QgZ3JlbWxpblF1ZXJ5ID0gcGFyc2VkLmdyZW1saW5RdWVyeTtcbiAgICBjb25zb2xlLmxvZyhcIkV4ZWN1dGluZyBHcmVtbGluIHF1ZXJ5OlwiLCBncmVtbGluUXVlcnkpO1xuXG4gICAgbGV0IHF1ZXJ5UmVzdWx0O1xuICAgIHRyeSB7XG4gICAgICBxdWVyeVJlc3VsdCA9IGF3YWl0IGV4ZWN1dGVHcmVtbGluKGdyZW1saW5RdWVyeSk7XG4gICAgfSBjYXRjaCAocXVlcnlFcnJvcjogdW5rbm93bikge1xuICAgICAgY29uc29sZS5lcnJvcihcIkdyZW1saW4gcXVlcnkgZXJyb3I6XCIsIHF1ZXJ5RXJyb3IpO1xuICAgICAgY29uc3QgZXJyb3JNZXNzYWdlID1cbiAgICAgICAgcXVlcnlFcnJvciBpbnN0YW5jZW9mIEVycm9yID8gcXVlcnlFcnJvci5tZXNzYWdlIDogU3RyaW5nKHF1ZXJ5RXJyb3IpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgYW5zd2VyOiBgSSB0cmllZCB0byBxdWVyeSB0aGUgZ3JhcGggYnV0IGVuY291bnRlcmVkIGFuIGVycm9yLiBUaGUgcXVlcnkgd2FzOiBnLiR7Z3JlbWxpblF1ZXJ5fS4gRXJyb3I6ICR7ZXJyb3JNZXNzYWdlfWAsXG4gICAgICAgIHF1ZXJ5OiBgZy4ke2dyZW1saW5RdWVyeX1gLFxuICAgICAgICBkYXRhOiBudWxsLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyBGb3JtYXQgdGhlIHJlc3VsdFxuICAgIGNvbnN0IHJlc3VsdFN0ciA9IEpTT04uc3RyaW5naWZ5KHF1ZXJ5UmVzdWx0LCBudWxsLCAyKTtcbiAgICBjb25zb2xlLmxvZyhcIlF1ZXJ5IHJlc3VsdDpcIiwgcmVzdWx0U3RyKTtcblxuICAgIC8vIEFzayBCZWRyb2NrIHRvIHN1bW1hcml6ZSB0aGUgcmVzdWx0c1xuICAgIGNvbnN0IHN1bW1hcnlNZXNzYWdlczogQmVkcm9ja01lc3NhZ2VbXSA9IFtcbiAgICAgIC4uLm1lc3NhZ2VzLFxuICAgICAge1xuICAgICAgICByb2xlOiBcImFzc2lzdGFudFwiLFxuICAgICAgICBjb250ZW50OiBgSSBleGVjdXRlZCB0aGUgR3JlbWxpbiBxdWVyeTogZy4ke2dyZW1saW5RdWVyeX1gLFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgcm9sZTogXCJ1c2VyXCIsXG4gICAgICAgIGNvbnRlbnQ6IGBUaGUgcXVlcnkgcmV0dXJuZWQgdGhlc2UgcmVzdWx0czogJHtyZXN1bHRTdHJ9XFxuXFxuUGxlYXNlIHByb3ZpZGUgYSBjbGVhciwgY29uY2lzZSBuYXR1cmFsIGxhbmd1YWdlIHN1bW1hcnkgb2YgdGhlc2UgcmVzdWx0cyB0byBhbnN3ZXIgbXkgb3JpZ2luYWwgcXVlc3Rpb24uIERvIG5vdCByZXR1cm4gSlNPTiwganVzdCBhIHBsYWluIHRleHQgYW5zd2VyLmAsXG4gICAgICB9LFxuICAgIF07XG5cbiAgICBjb25zdCBzdW1tYXJ5ID0gYXdhaXQgaW52b2tlQmVkcm9jayhzdW1tYXJ5TWVzc2FnZXMpO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgIGFuc3dlcjogc3VtbWFyeSxcbiAgICAgIHF1ZXJ5OiBgZy4ke2dyZW1saW5RdWVyeX1gLFxuICAgICAgZGF0YTogcmVzdWx0U3RyLFxuICAgIH07XG4gIH0gY2F0Y2ggKGVycm9yOiB1bmtub3duKSB7XG4gICAgY29uc29sZS5lcnJvcihcIkFJIFF1ZXJ5IGVycm9yOlwiLCBlcnJvcik7XG4gICAgY29uc3QgZXJyb3JNZXNzYWdlID1cbiAgICAgIGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbiAgICByZXR1cm4ge1xuICAgICAgYW5zd2VyOiBgU29ycnksIEkgZW5jb3VudGVyZWQgYW4gZXJyb3IgcHJvY2Vzc2luZyB5b3VyIHF1ZXN0aW9uOiAke2Vycm9yTWVzc2FnZX1gLFxuICAgICAgcXVlcnk6IG51bGwsXG4gICAgICBkYXRhOiBudWxsLFxuICAgIH07XG4gIH1cbn07XG4iXX0=