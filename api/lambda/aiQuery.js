"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const gremlin = require("gremlin");
const utils_1 = require("gremlin-aws-sigv4/lib/utils");
const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const P = gremlin.process.P;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYWlRdWVyeS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImFpUXVlcnkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQ0EsbUNBQW1DO0FBQ25DLHVEQUErRDtBQUUvRCxNQUFNLHNCQUFzQixHQUFHLE9BQU8sQ0FBQyxNQUFNLENBQUMsc0JBQXNCLENBQUM7QUFDckUsTUFBTSxTQUFTLEdBQUcsT0FBTyxDQUFDLE9BQU8sQ0FBQyx3QkFBd0IsQ0FBQyxTQUFTLENBQUM7QUFDckUsTUFBTSxDQUFDLEdBQUcsT0FBTyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7QUFFNUIsTUFBTSxjQUFjLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxjQUFjLElBQUksV0FBVyxDQUFDO0FBQ2pFLE1BQU0sUUFBUSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsUUFBUSxJQUFJLHVCQUF1QixDQUFDO0FBRWpFLE1BQU0sWUFBWSxHQUFHOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FrQnBCLENBQUM7QUFFRixNQUFNLGFBQWEsR0FBRzs7RUFFcEIsWUFBWTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBOEJiLENBQUM7QUFZRixLQUFLLFVBQVUsYUFBYSxDQUFDLFFBQTBCO0lBQ3JELG1FQUFtRTtJQUNuRSxNQUFNLEVBQUUsb0JBQW9CLEVBQUUsZUFBZSxFQUFFLEdBQUcsMkNBQ2hELGlDQUFpQyxFQUNsQyxDQUFDO0lBRUYsTUFBTSxNQUFNLEdBQUcsSUFBSSxvQkFBb0IsQ0FBQyxFQUFFLE1BQU0sRUFBRSxjQUFjLEVBQUUsQ0FBQyxDQUFDO0lBRXBFLE1BQU0sT0FBTyxHQUFHLElBQUksZUFBZSxDQUFDO1FBQ2xDLE9BQU8sRUFBRSxRQUFRO1FBQ2pCLE1BQU0sRUFBRSxDQUFDLEVBQUUsSUFBSSxFQUFFLGFBQWEsRUFBRSxDQUFDO1FBQ2pDLFFBQVEsRUFBRSxRQUFRLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1lB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O0lBQ0osQ0FBQztJQUFDLE9BQU8sS0FBYyxFQUFFLENBQUM7UUFDeEIsT0FBTyxDQUFDLEtBQUssQ0FBQyxpQkFBaUIsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUN4QyxNQUFNLFlBQVksR0FDaEIsS0FBSyxZQUFZLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ3pELE9BQU87WUFDTCxNQUFNLEVBQUUsMkRBQTJELFlBQVksRUFBRTtZQUNqRixLQUFLLEVBQUUsSUFBSTtZQUNYLElBQUksRUFBRSxJQUFJO1NBQ1gsQ0FBQztJQUNKLENBQUM7QUFDSCxDQUFDLENBQUM7QUEzSFcsUUFBQSxPQUFPLFdBMkhsQiIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IEhhbmRsZXIgfSBmcm9tIFwiYXdzLWxhbWJkYVwiO1xuaW1wb3J0ICogYXMgZ3JlbWxpbiBmcm9tIFwiZ3JlbWxpblwiO1xuaW1wb3J0IHsgZ2V0VXJsQW5kSGVhZGVycyB9IGZyb20gXCJncmVtbGluLWF3cy1zaWd2NC9saWIvdXRpbHNcIjtcblxuY29uc3QgRHJpdmVyUmVtb3RlQ29ubmVjdGlvbiA9IGdyZW1saW4uZHJpdmVyLkRyaXZlclJlbW90ZUNvbm5lY3Rpb247XG5jb25zdCB0cmF2ZXJzYWwgPSBncmVtbGluLnByb2Nlc3MuQW5vbnltb3VzVHJhdmVyc2FsU291cmNlLnRyYXZlcnNhbDtcbmNvbnN0IFAgPSBncmVtbGluLnByb2Nlc3MuUDtcblxuY29uc3QgQkVEUk9DS19SRUdJT04gPSBwcm9jZXNzLmVudi5CRURST0NLX1JFR0lPTiB8fCBcInVzLWVhc3QtMVwiO1xuY29uc3QgTU9ERUxfSUQgPSBwcm9jZXNzLmVudi5NT0RFTF9JRCB8fCBcImFtYXpvbi5ub3ZhLWxpdGUtdjE6MFwiO1xuXG5jb25zdCBHUkFQSF9TQ0hFTUEgPSBgXG5HcmFwaCBTY2hlbWE6XG4tIFZlcnRleCBsYWJlbHM6IHBlcnNvbiwgcHJvZHVjdCwgY29uZmVyZW5jZSwgaW5zdGl0dXRpb24sIGRvY3VtZW50XG4tIEVkZ2UgbGFiZWxzOiB1c2FnZSwgYmVsb25nX3RvLCBhdXRob3JlZF9ieSwgYWZmaWxpYXRlZF93aXRoLCBtYWRlX2J5XG4tIEFsbCB2ZXJ0aWNlcyBoYXZlIGEgXCJuYW1lXCIgcHJvcGVydHlcbi0gRWRnZSBcInVzYWdlXCIgY29ubmVjdHMgcGVyc29uIC0+IHByb2R1Y3QgKHdpdGggbnVtZXJpYyB3ZWlnaHQpXG4tIEVkZ2UgXCJiZWxvbmdfdG9cIiBjb25uZWN0cyBkb2N1bWVudCAtPiBjb25mZXJlbmNlXG4tIEVkZ2UgXCJhdXRob3JlZF9ieVwiIGNvbm5lY3RzIGRvY3VtZW50IC0+IHBlcnNvblxuLSBFZGdlIFwiYWZmaWxpYXRlZF93aXRoXCIgY29ubmVjdHMgcGVyc29uIC0+IGluc3RpdHV0aW9uXG4tIEVkZ2UgXCJtYWRlX2J5XCIgY29ubmVjdHMgcHJvZHVjdCAtPiBwZXJzb24vaW5zdGl0dXRpb25cblxuRXhhbXBsZSBHcmVtbGluIHF1ZXJpZXM6XG4tIEdldCBhbGwgcGVvcGxlOiBnLlYoKS5oYXNMYWJlbCgncGVyc29uJykudmFsdWVzKCduYW1lJykudG9MaXN0KClcbi0gR2V0IHByb2R1Y3RzIHVzZWQgYnkgYSBwZXJzb246IGcuVigpLmhhcygncGVyc29uJywnbmFtZScsJ0RvY3RvcjEnKS5vdXQoJ3VzYWdlJykudmFsdWVzKCduYW1lJykudG9MaXN0KClcbi0gQ291bnQgdmVydGljZXM6IGcuVigpLmNvdW50KCkubmV4dCgpXG4tIENvdW50IGVkZ2VzOiBnLkUoKS5jb3VudCgpLm5leHQoKVxuLSBHZXQgYWxsIHZlcnRleCBsYWJlbHM6IGcuVigpLmxhYmVsKCkuZGVkdXAoKS50b0xpc3QoKVxuLSBHZXQgbmVpZ2hib3JzIG9mIGEgdmVydGV4OiBnLlYoKS5oYXMoJ3BlcnNvbicsJ25hbWUnLCdEb2N0b3IxJykuYm90aCgpLnZhbHVlcygnbmFtZScpLnRvTGlzdCgpXG5gO1xuXG5jb25zdCBTWVNURU1fUFJPTVBUID0gYFlvdSBhcmUgYSBncmFwaCBkYXRhYmFzZSBhc3Npc3RhbnQgZm9yIEFtYXpvbiBOZXB0dW5lLiBZb3UgaGVscCB1c2VycyBxdWVyeSBhIGdyYXBoIGRhdGFiYXNlIHVzaW5nIG5hdHVyYWwgbGFuZ3VhZ2UuXG5cbiR7R1JBUEhfU0NIRU1BfVxuXG5XaGVuIGEgdXNlciBhc2tzIGEgcXVlc3Rpb24gYWJvdXQgdGhlIGdyYXBoIGRhdGE6XG4xLiBEZXRlcm1pbmUgaWYgeW91IG5lZWQgdG8gcXVlcnkgdGhlIGdyYXBoIHRvIGFuc3dlclxuMi4gSWYgeWVzLCBnZW5lcmF0ZSBhIEdyZW1saW4gcXVlcnlcbjMuIFJldHVybiB5b3VyIHJlc3BvbnNlIGFzIEpTT05cblxuSU1QT1JUQU5UIFJVTEVTOlxuLSBPbmx5IGdlbmVyYXRlIFJFQUQgcXVlcmllcyAobm8gbXV0YXRpb25zL2Ryb3BzKVxuLSBVc2UgdGhlIEdyZW1saW4gdHJhdmVyc2FsIGxhbmd1YWdlXG4tIEFsd2F5cyByZXR1cm4gdmFsaWQgSlNPTiBpbiB0aGlzIGV4YWN0IGZvcm1hdDpcblxuSWYgYSBxdWVyeSBpcyBuZWVkZWQ6XG57XCJuZWVkc1F1ZXJ5XCI6IHRydWUsIFwiZ3JlbWxpblF1ZXJ5XCI6IFwiPHRoZSBncmVtbGluIHRyYXZlcnNhbCBhZnRlciBnLj5cIiwgXCJleHBsYW5hdGlvblwiOiBcIjxicmllZiBleHBsYW5hdGlvbiBvZiB3aGF0IHRoZSBxdWVyeSBkb2VzPlwifVxuXG5JZiBubyBxdWVyeSBpcyBuZWVkZWQgKGdlbmVyYWwgcXVlc3Rpb24gYWJvdXQgdGhlIHNjaGVtYSwgZ3JlZXRpbmdzLCBldGMuKTpcbntcIm5lZWRzUXVlcnlcIjogZmFsc2UsIFwiYW5zd2VyXCI6IFwiPHlvdXIgYW5zd2VyPlwiLCBcImV4cGxhbmF0aW9uXCI6IFwiXCJ9XG5cbkV4YW1wbGVzOlxuVXNlcjogXCJXaG8gYXJlIGFsbCB0aGUgcGVvcGxlIGluIHRoZSBncmFwaD9cIlxue1wibmVlZHNRdWVyeVwiOiB0cnVlLCBcImdyZW1saW5RdWVyeVwiOiBcIlYoKS5oYXNMYWJlbCgncGVyc29uJykudmFsdWVzKCduYW1lJykudG9MaXN0KClcIiwgXCJleHBsYW5hdGlvblwiOiBcIkxpc3RzIGFsbCBwZXJzb24gdmVydGljZXMgYnkgbmFtZVwifVxuXG5Vc2VyOiBcIldoYXQgcHJvZHVjdHMgZG9lcyBEb2N0b3IxIHVzZT9cIlxue1wibmVlZHNRdWVyeVwiOiB0cnVlLCBcImdyZW1saW5RdWVyeVwiOiBcIlYoKS5oYXMoJ3BlcnNvbicsJ25hbWUnLCdEb2N0b3IxJykub3V0KCd1c2FnZScpLnZhbHVlcygnbmFtZScpLnRvTGlzdCgpXCIsIFwiZXhwbGFuYXRpb25cIjogXCJGaW5kcyBwcm9kdWN0cyBjb25uZWN0ZWQgdG8gRG9jdG9yMSB2aWEgdXNhZ2UgZWRnZXNcIn1cblxuVXNlcjogXCJIb3cgbWFueSBub2RlcyBhcmUgaW4gdGhlIGdyYXBoP1wiXG57XCJuZWVkc1F1ZXJ5XCI6IHRydWUsIFwiZ3JlbWxpblF1ZXJ5XCI6IFwiVigpLmNvdW50KCkubmV4dCgpXCIsIFwiZXhwbGFuYXRpb25cIjogXCJDb3VudHMgYWxsIHZlcnRpY2VzIGluIHRoZSBncmFwaFwifVxuXG5Vc2VyOiBcIldoYXQgdHlwZXMgb2YgcmVsYXRpb25zaGlwcyBleGlzdD9cIlxue1wibmVlZHNRdWVyeVwiOiBmYWxzZSwgXCJhbnN3ZXJcIjogXCJUaGUgZ3JhcGggaGFzIHRoZXNlIHJlbGF0aW9uc2hpcCB0eXBlczogdXNhZ2UsIGJlbG9uZ190bywgYXV0aG9yZWRfYnksIGFmZmlsaWF0ZWRfd2l0aCwgYW5kIG1hZGVfYnkuXCIsIFwiZXhwbGFuYXRpb25cIjogXCJcIn1cbmA7XG5cbmludGVyZmFjZSBCZWRyb2NrTWVzc2FnZSB7XG4gIHJvbGU6IHN0cmluZztcbiAgY29udGVudDogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgQ29udmVyc2F0aW9uRW50cnkge1xuICByb2xlOiBzdHJpbmc7XG4gIGNvbnRlbnQ6IHN0cmluZztcbn1cblxuYXN5bmMgZnVuY3Rpb24gaW52b2tlQmVkcm9jayhtZXNzYWdlczogQmVkcm9ja01lc3NhZ2VbXSk6IFByb21pc2U8c3RyaW5nPiB7XG4gIC8vIFVzZSBBV1MgU0RLIHYzIC0gZHluYW1pY2FsbHkgaW1wb3J0IHRvIHdvcmsgd2l0aCBMYW1iZGEgYnVuZGxpbmdcbiAgY29uc3QgeyBCZWRyb2NrUnVudGltZUNsaWVudCwgQ29udmVyc2VDb21tYW5kIH0gPSBhd2FpdCBpbXBvcnQoXG4gICAgXCJAYXdzLXNkay9jbGllbnQtYmVkcm9jay1ydW50aW1lXCJcbiAgKTtcblxuICBjb25zdCBjbGllbnQgPSBuZXcgQmVkcm9ja1J1bnRpbWVDbGllbnQoeyByZWdpb246IEJFRFJPQ0tfUkVHSU9OIH0pO1xuXG4gIGNvbnN0IGNvbW1hbmQgPSBuZXcgQ29udmVyc2VDb21tYW5kKHtcbiAgICBtb2RlbElkOiBNT0RFTF9JRCxcbiAgICBzeXN0ZW06IFt7IHRleHQ6IFNZU1RFTV9QUk9NUFQgfV0sXG4gICAgbWVzc2FnZXM6IG1lc3NhZ2VzLm1hcCgobSkgPT4gKHtcbiAgICAgIHJvbGU6IG0ucm9sZSBhcyBcInVzZXJcIiB8IFwiYXNzaXN0YW50XCIsXG4gICAgICBjb250ZW50OiBbeyB0ZXh0OiBtLmNvbnRlbnQgfV0sXG4gICAgfSkpLFxuICAgIGluZmVyZW5jZUNvbmZpZzoge1xuICAgICAgbWF4VG9rZW5zOiAxMDI0LFxuICAgIH0sXG4gIH0pO1xuXG4gIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgY2xpZW50LnNlbmQoY29tbWFuZCk7XG4gIGNvbnN0IG91dHB1dCA9IHJlc3BvbnNlLm91dHB1dD8ubWVzc2FnZT8uY29udGVudDtcbiAgaWYgKCFvdXRwdXQgfHwgb3V0cHV0Lmxlbmd0aCA9PT0gMCB8fCAhb3V0cHV0WzBdLnRleHQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJFbXB0eSByZXNwb25zZSBmcm9tIEJlZHJvY2tcIik7XG4gIH1cbiAgcmV0dXJuIG91dHB1dFswXS50ZXh0O1xufVxuXG5mdW5jdGlvbiBjcmVhdGVSZW1vdGVDb25uZWN0aW9uKCkge1xuICBjb25zdCB7IHVybCwgaGVhZGVycyB9ID0gZ2V0VXJsQW5kSGVhZGVycyhcbiAgICBwcm9jZXNzLmVudi5ORVBUVU5FX0VORFBPSU5ULFxuICAgIHByb2Nlc3MuZW52Lk5FUFRVTkVfUE9SVCxcbiAgICB7fSxcbiAgICBcIi9ncmVtbGluXCIsXG4gICAgXCJ3c3NcIlxuICApO1xuXG4gIGNvbnN0IGMgPSBuZXcgRHJpdmVyUmVtb3RlQ29ubmVjdGlvbih1cmwsIHtcbiAgICBtaW1lVHlwZTogXCJhcHBsaWNhdGlvbi92bmQuZ3JlbWxpbi12Mi4wK2pzb25cIixcbiAgICBoZWFkZXJzOiBoZWFkZXJzLFxuICB9KTtcblxuICBjLl9jbGllbnQuX2Nvbm5lY3Rpb24ub24oXCJjbG9zZVwiLCAoY29kZTogbnVtYmVyLCBtZXNzYWdlOiBzdHJpbmcpID0+IHtcbiAgICBjb25zb2xlLmluZm8oYGNsb3NlIC0gJHtjb2RlfSAke21lc3NhZ2V9YCk7XG4gICAgaWYgKGNvZGUgPT09IDEwMDYpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoXCJDb25uZWN0aW9uIGNsb3NlZCBwcmVtYXR1cmVseVwiKTtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkNvbm5lY3Rpb24gY2xvc2VkIHByZW1hdHVyZWx5XCIpO1xuICAgIH1cbiAgfSk7XG5cbiAgcmV0dXJuIGM7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGV4ZWN1dGVHcmVtbGluKHF1ZXJ5U3RyaW5nOiBzdHJpbmcpOiBQcm9taXNlPHVua25vd24+IHtcbiAgY29uc3QgY29ubiA9IGNyZWF0ZVJlbW90ZUNvbm5lY3Rpb24oKTtcbiAgY29uc3QgZyA9IHRyYXZlcnNhbCgpLndpdGhSZW1vdGUoY29ubik7XG5cbiAgdHJ5IHtcbiAgICAvLyBCdWlsZCB0aGUgdHJhdmVyc2FsIGR5bmFtaWNhbGx5IGJ5IGV2YWx1YXRpbmcgdGhlIHF1ZXJ5IHN0cmluZ1xuICAgIC8vIFdlIHVzZSBGdW5jdGlvbiBjb25zdHJ1Y3RvciB0byBzYWZlbHkgZXZhbHVhdGUgdGhlIEdyZW1saW4gcXVlcnlcbiAgICBjb25zdCBxdWVyeUZuID0gbmV3IEZ1bmN0aW9uKFxuICAgICAgXCJnXCIsXG4gICAgICBcIlBcIixcbiAgICAgIGByZXR1cm4gZy4ke3F1ZXJ5U3RyaW5nfWBcbiAgICApO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHF1ZXJ5Rm4oZywgUCk7XG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfSBmaW5hbGx5IHtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgY29ubi5jbG9zZSgpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnNvbGUud2FybihcIkVycm9yIGNsb3NpbmcgY29ubmVjdGlvbjpcIiwgZSk7XG4gICAgfVxuICB9XG59XG5cbmV4cG9ydCBjb25zdCBoYW5kbGVyOiBIYW5kbGVyID0gYXN5bmMgKGV2ZW50KSA9PiB7XG4gIGNvbnNvbGUubG9nKFwiQUkgUXVlcnkgZXZlbnQ6XCIsIEpTT04uc3RyaW5naWZ5KGV2ZW50KSk7XG5cbiAgY29uc3QgcXVlc3Rpb24gPSBldmVudC5hcmd1bWVudHM/LnF1ZXN0aW9uO1xuICBjb25zdCBjb252ZXJzYXRpb25IaXN0b3J5OiBDb252ZXJzYXRpb25FbnRyeVtdID0gZXZlbnQuYXJndW1lbnRzPy5oaXN0b3J5XG4gICAgPyBKU09OLnBhcnNlKGV2ZW50LmFyZ3VtZW50cy5oaXN0b3J5KVxuICAgIDogW107XG5cbiAgaWYgKCFxdWVzdGlvbikge1xuICAgIHJldHVybiB7XG4gICAgICBhbnN3ZXI6XG4gICAgICAgIFwiUGxlYXNlIGFzayBhIHF1ZXN0aW9uIGFib3V0IHRoZSBncmFwaCBkYXRhLiBGb3IgZXhhbXBsZTogJ1dobyBhcmUgYWxsIHRoZSBwZW9wbGUgaW4gdGhlIGdyYXBoPycgb3IgJ1doYXQgcHJvZHVjdHMgZG9lcyBEb2N0b3IxIHVzZT8nXCIsXG4gICAgICBxdWVyeTogbnVsbCxcbiAgICAgIGRhdGE6IG51bGwsXG4gICAgfTtcbiAgfVxuXG4gIHRyeSB7XG4gICAgLy8gQnVpbGQgbWVzc2FnZXMgZm9yIEJlZHJvY2sgaW5jbHVkaW5nIGNvbnZlcnNhdGlvbiBoaXN0b3J5XG4gICAgY29uc3QgbWVzc2FnZXM6IEJlZHJvY2tNZXNzYWdlW10gPSBbXTtcblxuICAgIGZvciAoY29uc3QgZW50cnkgb2YgY29udmVyc2F0aW9uSGlzdG9yeSkge1xuICAgICAgbWVzc2FnZXMucHVzaCh7XG4gICAgICAgIHJvbGU6IGVudHJ5LnJvbGUgPT09IFwidXNlclwiID8gXCJ1c2VyXCIgOiBcImFzc2lzdGFudFwiLFxuICAgICAgICBjb250ZW50OiBlbnRyeS5jb250ZW50LFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgbWVzc2FnZXMucHVzaCh7XG4gICAgICByb2xlOiBcInVzZXJcIixcbiAgICAgIGNvbnRlbnQ6IHF1ZXN0aW9uLFxuICAgIH0pO1xuXG4gICAgLy8gQ29udmVyc2UgQVBJIHJlcXVpcmVzIGZpcnN0IG1lc3NhZ2UgdG8gYmUgZnJvbSBcInVzZXJcIiDigJQgc3RyaXAgbGVhZGluZyBhc3Npc3RhbnQgbWVzc2FnZXNcbiAgICB3aGlsZSAobWVzc2FnZXMubGVuZ3RoID4gMCAmJiBtZXNzYWdlc1swXS5yb2xlICE9PSBcInVzZXJcIikge1xuICAgICAgbWVzc2FnZXMuc2hpZnQoKTtcbiAgICB9XG5cbiAgICBjb25zb2xlLmxvZyhcIlNlbmRpbmcgbWVzc2FnZXMgdG8gQmVkcm9jazpcIiwgSlNPTi5zdHJpbmdpZnkobWVzc2FnZXMubWFwKG0gPT4gKHsgcm9sZTogbS5yb2xlLCBsZW46IG0uY29udGVudC5sZW5ndGggfSkpKSk7XG5cbiAgICAvLyBDYWxsIEJlZHJvY2sgdG8gaW50ZXJwcmV0IHRoZSBxdWVzdGlvblxuICAgIGNvbnN0IGJlZHJvY2tSZXNwb25zZSA9IGF3YWl0IGludm9rZUJlZHJvY2sobWVzc2FnZXMpO1xuICAgIGNvbnNvbGUubG9nKFwiQmVkcm9jayByZXNwb25zZTpcIiwgYmVkcm9ja1Jlc3BvbnNlKTtcblxuICAgIC8vIFBhcnNlIEJlZHJvY2sncyByZXNwb25zZSAtIGV4dHJhY3QgSlNPTiBmcm9tIHRoZSB0ZXh0XG4gICAgbGV0IHBhcnNlZDtcbiAgICB0cnkge1xuICAgICAgLy8gVHJ5IHRvIGV4dHJhY3QgSlNPTiBmcm9tIHRoZSByZXNwb25zZVxuICAgICAgY29uc3QganNvbk1hdGNoID0gYmVkcm9ja1Jlc3BvbnNlLm1hdGNoKC9cXHtbXFxzXFxTXSpcXH0vKTtcbiAgICAgIGlmIChqc29uTWF0Y2gpIHtcbiAgICAgICAgcGFyc2VkID0gSlNPTi5wYXJzZShqc29uTWF0Y2hbMF0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcGFyc2VkID0gSlNPTi5wYXJzZShiZWRyb2NrUmVzcG9uc2UpO1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKHBhcnNlRXJyb3IpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoXCJGYWlsZWQgdG8gcGFyc2UgQmVkcm9jayByZXNwb25zZTpcIiwgcGFyc2VFcnJvcik7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBhbnN3ZXI6IGJlZHJvY2tSZXNwb25zZSxcbiAgICAgICAgcXVlcnk6IG51bGwsXG4gICAgICAgIGRhdGE6IG51bGwsXG4gICAgICB9O1xuICAgIH1cblxuICAgIGlmICghcGFyc2VkLm5lZWRzUXVlcnkpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGFuc3dlcjogcGFyc2VkLmFuc3dlciB8fCBiZWRyb2NrUmVzcG9uc2UsXG4gICAgICAgIHF1ZXJ5OiBudWxsLFxuICAgICAgICBkYXRhOiBudWxsLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyBFeGVjdXRlIHRoZSBHcmVtbGluIHF1ZXJ5XG4gICAgY29uc3QgZ3JlbWxpblF1ZXJ5ID0gcGFyc2VkLmdyZW1saW5RdWVyeTtcbiAgICBjb25zb2xlLmxvZyhcIkV4ZWN1dGluZyBHcmVtbGluIHF1ZXJ5OlwiLCBncmVtbGluUXVlcnkpO1xuXG4gICAgbGV0IHF1ZXJ5UmVzdWx0O1xuICAgIHRyeSB7XG4gICAgICBxdWVyeVJlc3VsdCA9IGF3YWl0IGV4ZWN1dGVHcmVtbGluKGdyZW1saW5RdWVyeSk7XG4gICAgfSBjYXRjaCAocXVlcnlFcnJvcjogdW5rbm93bikge1xuICAgICAgY29uc29sZS5lcnJvcihcIkdyZW1saW4gcXVlcnkgZXJyb3I6XCIsIHF1ZXJ5RXJyb3IpO1xuICAgICAgY29uc3QgZXJyb3JNZXNzYWdlID1cbiAgICAgICAgcXVlcnlFcnJvciBpbnN0YW5jZW9mIEVycm9yID8gcXVlcnlFcnJvci5tZXNzYWdlIDogU3RyaW5nKHF1ZXJ5RXJyb3IpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgYW5zd2VyOiBgSSB0cmllZCB0byBxdWVyeSB0aGUgZ3JhcGggYnV0IGVuY291bnRlcmVkIGFuIGVycm9yLiBUaGUgcXVlcnkgd2FzOiBnLiR7Z3JlbWxpblF1ZXJ5fS4gRXJyb3I6ICR7ZXJyb3JNZXNzYWdlfWAsXG4gICAgICAgIHF1ZXJ5OiBgZy4ke2dyZW1saW5RdWVyeX1gLFxuICAgICAgICBkYXRhOiBudWxsLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyBGb3JtYXQgdGhlIHJlc3VsdFxuICAgIGNvbnN0IHJlc3VsdFN0ciA9IEpTT04uc3RyaW5naWZ5KHF1ZXJ5UmVzdWx0LCBudWxsLCAyKTtcbiAgICBjb25zb2xlLmxvZyhcIlF1ZXJ5IHJlc3VsdDpcIiwgcmVzdWx0U3RyKTtcblxuICAgIC8vIEFzayBCZWRyb2NrIHRvIHN1bW1hcml6ZSB0aGUgcmVzdWx0c1xuICAgIGNvbnN0IHN1bW1hcnlNZXNzYWdlczogQmVkcm9ja01lc3NhZ2VbXSA9IFtcbiAgICAgIC4uLm1lc3NhZ2VzLFxuICAgICAge1xuICAgICAgICByb2xlOiBcImFzc2lzdGFudFwiLFxuICAgICAgICBjb250ZW50OiBgSSBleGVjdXRlZCB0aGUgR3JlbWxpbiBxdWVyeTogZy4ke2dyZW1saW5RdWVyeX1gLFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgcm9sZTogXCJ1c2VyXCIsXG4gICAgICAgIGNvbnRlbnQ6IGBUaGUgcXVlcnkgcmV0dXJuZWQgdGhlc2UgcmVzdWx0czogJHtyZXN1bHRTdHJ9XFxuXFxuUGxlYXNlIHByb3ZpZGUgYSBjbGVhciwgY29uY2lzZSBuYXR1cmFsIGxhbmd1YWdlIHN1bW1hcnkgb2YgdGhlc2UgcmVzdWx0cyB0byBhbnN3ZXIgbXkgb3JpZ2luYWwgcXVlc3Rpb24uIERvIG5vdCByZXR1cm4gSlNPTiwganVzdCBhIHBsYWluIHRleHQgYW5zd2VyLmAsXG4gICAgICB9LFxuICAgIF07XG5cbiAgICBjb25zdCBzdW1tYXJ5ID0gYXdhaXQgaW52b2tlQmVkcm9jayhzdW1tYXJ5TWVzc2FnZXMpO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgIGFuc3dlcjogc3VtbWFyeSxcbiAgICAgIHF1ZXJ5OiBgZy4ke2dyZW1saW5RdWVyeX1gLFxuICAgICAgZGF0YTogcmVzdWx0U3RyLFxuICAgIH07XG4gIH0gY2F0Y2ggKGVycm9yOiB1bmtub3duKSB7XG4gICAgY29uc29sZS5lcnJvcihcIkFJIFF1ZXJ5IGVycm9yOlwiLCBlcnJvcik7XG4gICAgY29uc3QgZXJyb3JNZXNzYWdlID1cbiAgICAgIGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbiAgICByZXR1cm4ge1xuICAgICAgYW5zd2VyOiBgU29ycnksIEkgZW5jb3VudGVyZWQgYW4gZXJyb3IgcHJvY2Vzc2luZyB5b3VyIHF1ZXN0aW9uOiAke2Vycm9yTWVzc2FnZX1gLFxuICAgICAgcXVlcnk6IG51bGwsXG4gICAgICBkYXRhOiBudWxsLFxuICAgIH07XG4gIH1cbn07XG4iXX0=