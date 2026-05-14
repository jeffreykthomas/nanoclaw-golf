import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { updateContainerConfig, type ContainerConfig, type McpServerConfig } from './container-config.js';

export const COACH_PORTAL_ENV_VARS = [
  'PERPLEXITY_API_KEY',
  'PERPLEXITY_TIMEOUT_MS',
  'PERPLEXITY_BASE_URL',
  'OPENAI_API_KEY',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'TAVILY_API_KEY',
  'EXA_API_KEY',
  'BRAVE_API_KEY',
] as const;

const COACH_PORTAL_GUIDANCE_MARKER = '<!-- coach-portal-mcp -->';

const COACH_PORTAL_GUIDANCE = `${COACH_PORTAL_GUIDANCE_MARKER}

## AI Portal Tools

You are the user's primary coach portal. Claude's built-in WebSearch and WebFetch are available for general current information and URL reading.

When stronger source grounding is needed, prefer the Perplexity MCP tools if they are available. Use them for cited current-events answers, research, source discovery, and source-backed summaries. If Perplexity is unavailable, say the source-search credential is not configured and fall back to built-in web search when appropriate.

When the user asks for images, use the OpenAI image MCP tools if available. Prefer the latest configured GPT Image model for new images, edits, and visual assets. If the tool is unavailable, explain that OPENAI_API_KEY is not configured yet.

When the user asks for video generation, use the Google Veo MCP tools if they are available. Prefer Veo 2 style requests when the user specifically asks for Veo2. Ask for duration, aspect ratio, motion, subject, style, and delivery constraints when they matter. If the tool is unavailable, explain that Google Cloud auth and the mcp-veo-go binary are not configured yet.

Gemini search/source tools are intentionally not wired for now because Perplexity covers source-backed search in this portal.
`;

const COACH_PORTAL_MCP_SERVERS: Record<string, McpServerConfig> = {
  perplexity: {
    command: 'npx',
    args: ['-yq', '@perplexity-ai/mcp-server@0.9.0'],
    env: {
      PERPLEXITY_API_KEY: '${PERPLEXITY_API_KEY}',
      PERPLEXITY_TIMEOUT_MS: '600000',
    },
    instructions:
      'Use Perplexity for source-backed web search, cited answers, deep research, and current information that needs stronger grounding than a general web fetch.',
  },
  openai_image: {
    command: 'npx',
    args: ['-yq', 'openai-gpt-image-mcp-server@1.4.0'],
    env: {
      OPENAI_API_KEY: '${OPENAI_API_KEY}',
    },
    instructions:
      'Use OpenAI image tools for image generation and image editing requests. Ask for missing creative constraints when needed, and save generated artifacts in the group workspace.',
  },
  google_veo: {
    command: 'mcp-veo-go',
    args: [],
    env: {
      GOOGLE_CLOUD_PROJECT: '${GOOGLE_CLOUD_PROJECT}',
      GOOGLE_APPLICATION_CREDENTIALS: '${GOOGLE_APPLICATION_CREDENTIALS}',
    },
    instructions:
      'Use Google Veo tools for video generation requests, especially Veo2-style short-form video prompts. Ask for duration, aspect ratio, subject, motion, style, and output constraints when missing.',
  },
};

export function isCoachPortalFolder(folder: string): boolean {
  return folder === 'coach' || /^coach-\d+$/.test(folder);
}

export function applyCoachPortalMcpConfig(folder: string): ContainerConfig {
  return updateContainerConfig(folder, (config) => {
    config.mcpServers = config.mcpServers ?? {};
    for (const [name, template] of Object.entries(COACH_PORTAL_MCP_SERVERS)) {
      const existing = config.mcpServers[name];
      config.mcpServers[name] = existing
        ? {
            ...template,
            ...existing,
            env: { ...template.env, ...existing.env },
            instructions: existing.instructions || template.instructions,
          }
        : template;
    }
  });
}

export function ensureCoachPortalGuidance(folder: string, title: string): void {
  const groupDir = path.join(GROUPS_DIR, folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const claudeLocalPath = path.join(groupDir, 'CLAUDE.local.md');
  let content = '';
  if (fs.existsSync(claudeLocalPath)) {
    content = fs.readFileSync(claudeLocalPath, 'utf8');
  } else {
    content = `# ${title}\n\nYou are Jeffrey's personal golf coach and assistant. Keep replies concise, practical, and oriented toward durable improvement.\n`;
  }

  if (content.includes(COACH_PORTAL_GUIDANCE_MARKER)) return;

  const nextContent = `${content.trimEnd()}\n\n${COACH_PORTAL_GUIDANCE.trimEnd()}\n`;
  fs.writeFileSync(claudeLocalPath, nextContent);
}
