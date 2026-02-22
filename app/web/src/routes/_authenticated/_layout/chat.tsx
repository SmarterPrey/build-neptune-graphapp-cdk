import { useState, useRef, useEffect } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Send, MessageSquare, User, Loader2, Code, X } from "lucide-react";
import { queryAskGraph } from "@/lib/utils";
import { toast } from "@/components/ui/use-toast";

export const Route = createFileRoute("/_authenticated/_layout/chat")({
  component: ChatPage,
});

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  query?: string | null;
  data?: string | null;
  timestamp: Date;
}

function ChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      content:
        "Hello! I can help you explore your graph data using natural language. Try asking questions like:\n\n• \"Who are all the people in the graph?\"\n• \"What products does Doctor1 use?\"\n• \"How many nodes are in the graph?\"\n• \"What types of relationships exist?\"",
      timestamp: new Date(),
    },
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [expandedQuery, setExpandedQuery] = useState<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage: ChatMessage = {
      role: "user",
      content: input.trim(),
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);

    try {
      // Build conversation history for context
      const history = messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(-10) // Keep last 10 messages for context
        .map((m) => ({
          role: m.role,
          content: m.content,
        }));

      const res = await queryAskGraph(
        userMessage.content,
        JSON.stringify(history)
      );

      const aiResponse = res.data.askGraph;

      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: aiResponse.answer || "I couldn't generate a response.",
        query: aiResponse.query,
        data: aiResponse.data,
        timestamp: new Date(),
      };

      setMessages((prev) => [...prev, assistantMessage]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      console.error("Chat error:", error);
      toast({
        variant: "destructive",
        title: "Query Error",
        description:
          error?.errors?.[0]?.message || "Failed to process your question",
      });
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Sorry, I encountered an error processing your question. Please try again.",
          timestamp: new Date(),
        },
      ]);
    }

    setIsLoading(false);
    inputRef.current?.focus();
  };

  return (
    <main className="flex flex-col h-screen max-h-screen">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b bg-background">
        <MessageSquare className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-lg font-semibold">Neptune GraphDB Chatbot</h1>
          <p className="text-sm text-muted-foreground">
            Ask questions about your graph data in natural language
          </p>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-4">
        {messages.map((message, index) => (
          <div
            key={index}
            className={`flex gap-3 ${
              message.role === "user" ? "justify-end" : "justify-start"
            }`}
          >
            {message.role === "assistant" && (
              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                <MessageSquare className="h-4 w-4 text-primary" />
              </div>
            )}
            <div
              className={`max-w-[75%] rounded-lg px-4 py-3 ${
                message.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted"
              }`}
            >
              <p className="text-sm whitespace-pre-wrap">{message.content}</p>

              {/* Show Gremlin query if available */}
              {message.query && (
                <div className="mt-2">
                  <button
                    onClick={() =>
                      setExpandedQuery(
                        expandedQuery === index ? null : index
                      )
                    }
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {expandedQuery === index ? (
                      <X className="h-3 w-3" />
                    ) : (
                      <Code className="h-3 w-3" />
                    )}
                    {expandedQuery === index ? "Hide query" : "Show query"}
                  </button>
                  {expandedQuery === index && (
                    <div className="mt-1 p-2 rounded bg-background/50 border text-xs font-mono">
                      {message.query}
                    </div>
                  )}
                </div>
              )}

              {/* Show raw data if available */}
              {message.data && expandedQuery === index && (
                <div className="mt-2">
                  <p className="text-xs text-muted-foreground mb-1">
                    Raw data:
                  </p>
                  <pre className="p-2 rounded bg-background/50 border text-xs font-mono overflow-x-auto max-h-40 overflow-y-auto">
                    {message.data}
                  </pre>
                </div>
              )}
            </div>
            {message.role === "user" && (
              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary flex items-center justify-center">
                <User className="h-4 w-4 text-primary-foreground" />
              </div>
            )}
          </div>
        ))}
        {isLoading && (
          <div className="flex gap-3 justify-start">
            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
              <MessageSquare className="h-4 w-4 text-primary" />
            </div>
            <div className="rounded-lg px-4 py-3 bg-muted">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Thinking...
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="px-4 py-4 border-t bg-background">
        <form onSubmit={handleSubmit} className="flex gap-2 max-w-4xl mx-auto">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask a question about your graph data..."
            className="flex-1 rounded-lg border bg-background px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="rounded-lg bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Send className="h-4 w-4" />
          </button>
        </form>
        <p className="text-xs text-muted-foreground text-center mt-2">
          Powered by Amazon Bedrock &amp; Neptune
        </p>
      </div>
    </main>
  );
}
