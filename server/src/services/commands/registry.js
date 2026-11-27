import { can } from '../permissions.js';

const MAX_COMMAND_INPUT_LENGTH = 2000;
const commands = new Map();
const rateBuckets = new Map();

/**
 * Quote-aware command parser supporting Unicode and escaped quotes.
 * Example: /poll "Café 🚀?" "Oui ✅" "Non ❌"
 */
export function parseCommandInput(rawText) {
  if (typeof rawText !== 'string') {
    return { error: 'Command must be a string' };
  }
  const trimmed = rawText.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }
  if (trimmed.length > MAX_COMMAND_INPUT_LENGTH) {
    return { error: `Command input too long (max ${MAX_COMMAND_INPUT_LENGTH} characters)` };
  }

  const tokens = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';
  let hadToken = false;

  for (let i = 1; i < trimmed.length; i += 1) {
    const ch = trimmed[i];

    if (inQuotes) {
      if (ch === '\\' && i + 1 < trimmed.length) {
        current += trimmed[i + 1];
        i += 1;
      } else if (ch === quoteChar) {
        inQuotes = false;
        quoteChar = '';
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inQuotes = true;
      quoteChar = ch;
      hadToken = true;
      continue;
    }

    if (/\s/.test(ch)) {
      if (hadToken || current.length > 0) {
        tokens.push(current);
        current = '';
        hadToken = false;
      }
      continue;
    }

    current += ch;
    hadToken = true;
  }

  if (inQuotes) {
    return { error: 'Unterminated quote in command arguments' };
  }
  if (hadToken || current.length > 0) {
    tokens.push(current);
  }

  const command = (tokens[0] || '').toLowerCase();
  if (!command || !/^[a-z0-9_-]{1,32}$/.test(command)) {
    return { error: 'Invalid command name' };
  }

  return {
    command,
    args: tokens.slice(1),
    rawArgs: trimmed.slice(1 + command.length).trim(),
  };
}

export function registerCommand(definition) {
  commands.set(definition.name.toLowerCase(), definition);
}

export function getRegisteredCommands() {
  return Array.from(commands.values());
}

export function getCommandsForUser(user, room = null) {
  return getRegisteredCommands()
    .filter((cmd) => !cmd.requiredPermission || can(user, cmd.requiredPermission, { room }))
    .map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
      usage: cmd.usage,
      visibility: cmd.visibility,
    }));
}

function checkCommandRateLimit(cmdName, userId, rateLimit) {
  if (!rateLimit?.max || !rateLimit?.windowMs) return true;
  const key = `${cmdName}:${userId}`;
  const now = Date.now();
  const timestamps = rateBuckets.get(key) || [];
  while (timestamps.length > 0 && now - timestamps[0] >= rateLimit.windowMs) {
    timestamps.shift();
  }
  if (timestamps.length >= rateLimit.max) {
    return false;
  }
  timestamps.push(now);
  rateBuckets.set(key, timestamps);
  return true;
}

export function emitEphemeral(io, userId, { roomId, command, text, candidates = null, isError = false }) {
  if (!io || !userId) return;
  io.to(`user:${userId}`).emit('ephemeral:message', {
    id: `eph-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    roomId,
    command,
    text,
    ...(candidates ? { candidates } : {}),
    isError,
    ephemeral: true,
    createdAt: new Date().toISOString(),
  });
}

export async function executeSlashCommand(ctx) {
  const parsed = parseCommandInput(ctx.text);
  if (!parsed) return null;

  const roomIdStr = ctx.room._id.toString();

  if (parsed.error) {
    emitEphemeral(ctx.io, ctx.userId, {
      roomId: roomIdStr,
      command: 'error',
      text: parsed.error,
      isError: true,
    });
    return { ok: true, ephemeral: true };
  }

  const cmd = commands.get(parsed.command);
  if (!cmd) {
    emitEphemeral(ctx.io, ctx.userId, {
      roomId: roomIdStr,
      command: parsed.command,
      text: `Unknown command "/${parsed.command}". Type /help to see available commands.`,
      isError: true,
    });
    return { ok: true, ephemeral: true };
  }

  if (cmd.requiredPermission && !can({ id: ctx.userId }, cmd.requiredPermission, { room: ctx.room })) {
    return { ok: false, error: `You do not have permission to run /${cmd.name}` };
  }

  if (!checkCommandRateLimit(cmd.name, ctx.userId, cmd.rateLimit)) {
    return { ok: false, error: `Rate limit exceeded for /${cmd.name}. Please try again later.` };
  }

  if (cmd.argsSchema) {
    const validated = cmd.argsSchema.safeParse({ args: parsed.args, rawArgs: parsed.rawArgs });
    if (!validated.success) {
      emitEphemeral(ctx.io, ctx.userId, {
        roomId: roomIdStr,
        command: cmd.name,
        text: `Usage: ${cmd.usage} — ${validated.error.issues[0]?.message || 'Invalid arguments'}`,
        isError: true,
      });
      return { ok: true, ephemeral: true };
    }
  }

  const result = await cmd.handler({
    ...ctx,
    args: parsed.args,
    rawArgs: parsed.rawArgs,
  });

  if (cmd.visibility === 'ephemeral' && result?.ephemeralText) {
    emitEphemeral(ctx.io, ctx.userId, {
      roomId: roomIdStr,
      command: cmd.name,
      text: result.ephemeralText,
      candidates: result.candidates || null,
    });
    return { ok: true, ephemeral: true };
  }

  return result || { ok: true };
}
