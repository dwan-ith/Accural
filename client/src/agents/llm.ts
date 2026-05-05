export type LlmJsonRequest = {
  agentName: string;
  systemPrompt: string;
  userPrompt: string;
};

export interface LlmClient {
  completeJson<T>(request: LlmJsonRequest): Promise<T>;
}

export class OpenAiResponsesClient implements LlmClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(input: { apiKey?: string; model?: string; baseUrl?: string } = {}) {
    const apiKey = input.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required for LLM agent mode.");
    }

    this.apiKey = apiKey;
    this.model = input.model ?? process.env.ACCURAL_LLM_MODEL ?? "gpt-4o";
    this.baseUrl = input.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  }

  async completeJson<T>(request: LlmJsonRequest): Promise<T> {
    const response = await fetch(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: [
          {
            role: "system",
            content: request.systemPrompt,
          },
          {
            role: "user",
            content: `${request.userPrompt}\n\nReturn only valid JSON. Do not wrap it in markdown.`,
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI Responses API failed: ${response.status} ${await response.text()}`);
    }

    const payload = (await response.json()) as { output_text?: string; output?: unknown };
    const text = payload.output_text ?? extractOutputText(payload.output);
    if (!text) {
      throw new Error("OpenAI Responses API returned no text output.");
    }

    return JSON.parse(stripJsonFence(text)) as T;
  }
}

export class StubLlmClient implements LlmClient {
  private readonly responses: unknown[];

  constructor(responses: unknown[]) {
    this.responses = [...responses];
  }

  async completeJson<T>(): Promise<T> {
    const response = this.responses.shift();
    if (!response) {
      throw new Error("StubLlmClient has no remaining responses.");
    }
    return response as T;
  }
}

function extractOutputText(output: unknown): string | undefined {
  if (!Array.isArray(output)) {
    return undefined;
  }

  const chunks: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const contentItem of content) {
      if (!contentItem || typeof contentItem !== "object") {
        continue;
      }
      const maybeText = contentItem as { text?: unknown; type?: unknown };
      if (typeof maybeText.text === "string") {
        chunks.push(maybeText.text);
      }
    }
  }

  return chunks.join("").trim() || undefined;
}

function stripJsonFence(text: string) {
  return text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}
