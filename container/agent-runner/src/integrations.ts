/**
 * Google integration MCP servers (Gmail, Calendar).
 *
 * The host decides which integrations a run gets (group opt-in + owner
 * sender + credentials present) and passes them in ContainerInput. Servers
 * are only started for granted integrations.
 *
 * Note: allowedTools only auto-approves; it does not restrict. Read-only
 * access is enforced with disallowedTools (Gmail) and the server's own
 * ENABLED_TOOLS filter (Calendar).
 */

export type IntegrationAccess = 'read' | 'full';

export interface GroupIntegrations {
  gmail?: IntegrationAccess;
  calendar?: IntegrationAccess;
}

interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

// Binaries installed globally in the container image (see Dockerfile).
const GMAIL_BIN = 'gmail-mcp';
const CALENDAR_BIN = 'google-calendar-mcp';

const CALENDAR_DIR = '/home/node/.calendar-mcp';

// Gmail tools that never modify the mailbox or send anything.
// draft_email is allowed: it creates a draft the user must send themselves.
const GMAIL_READ_TOOLS = [
  'search_emails',
  'read_email',
  'list_email_labels',
  'list_filters',
  'get_filter',
  'download_attachment',
  'draft_email',
];

const GMAIL_WRITE_TOOLS = [
  'send_email',
  'modify_email',
  'delete_email',
  'batch_modify_emails',
  'batch_delete_emails',
  'create_label',
  'update_label',
  'delete_label',
  'get_or_create_label',
  'create_filter',
  'create_filter_from_template',
  'delete_filter',
];

const CALENDAR_READ_TOOLS = [
  'list-calendars',
  'list-events',
  'search-events',
  'get-event',
  'get-freebusy',
  'get-current-time',
  'list-colors',
];

export function buildIntegrationMcpServers(
  integrations: GroupIntegrations | undefined,
): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};

  if (integrations?.gmail) {
    servers.gmail = { command: GMAIL_BIN, args: [] };
  }

  if (integrations?.calendar) {
    const env: Record<string, string> = {
      GOOGLE_OAUTH_CREDENTIALS: `${CALENDAR_DIR}/gcp-oauth.keys.json`,
      GOOGLE_CALENDAR_MCP_TOKEN_PATH: `${CALENDAR_DIR}/tokens.json`,
    };
    if (integrations.calendar === 'read') {
      env.ENABLED_TOOLS = CALENDAR_READ_TOOLS.join(',');
    }
    servers.calendar = { command: CALENDAR_BIN, args: ['start'], env };
  }

  return servers;
}

export function integrationAllowedTools(
  integrations: GroupIntegrations | undefined,
): string[] {
  const tools: string[] = [];
  if (integrations?.gmail === 'full') tools.push('mcp__gmail__*');
  if (integrations?.gmail === 'read') {
    tools.push(...GMAIL_READ_TOOLS.map((t) => `mcp__gmail__${t}`));
  }
  if (integrations?.calendar) tools.push('mcp__calendar__*');
  return tools;
}

export function integrationDisallowedTools(
  integrations: GroupIntegrations | undefined,
): string[] {
  if (integrations?.gmail !== 'read') return [];
  return GMAIL_WRITE_TOOLS.map((t) => `mcp__gmail__${t}`);
}
