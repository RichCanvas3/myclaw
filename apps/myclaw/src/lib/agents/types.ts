export type A2aAgentId = string;

export type A2aAgentConfig = {
  id: A2aAgentId;
  name: string;
  baseUrl: string; // must end with /a2a/ (or we’ll normalize)
  apiKeyHeader: string; // e.g. x-api-key
  apiKey: string;
};

export type OrchestratorContext = {
  churchId: string;
  userId: string;
  personId: string;
  householdId?: string | null;
  threadId?: string | null;
};

export type SuggestedAction =
  | {
      type: "a2a.call";
      input: {
        agent?: A2aAgentId; // default: churchcore
        endpoint: string; // e.g. chat.stream, thread.list, household.get
        stream?: boolean;
        payload: Record<string, unknown>;
      };
    }
  | {
      type: "email.send";
      input: {
        to: string[]; // one action can target multiple recipients; server will send 1 email per recipient
        subject?: string;
        text?: string;
        html?: string;
        includeHousehold?: boolean;
      };
    }
  | {
      type: "calendar.range";
      input: {
        accountAddress?: string; // if omitted, orchestrator tries to use memoryProfile.identity.email
        timeMinISO: string; // inclusive
        timeMaxISO: string; // exclusive
        query?: string;
      };
    }
  | {
      type: "mcp.tool";
      input: {
        server: string; // e.g. gym-weather, gym-sendgrid
        tool: string; // e.g. weather_current, sendEmail
        args: Record<string, unknown>;
      };
    }
  | {
      type: "memory.upsert" | "memory.query" | "memory.profile.get";
      input: Record<string, unknown>;
    }
  | {
      type: string;
      input?: Record<string, unknown>;
    };

