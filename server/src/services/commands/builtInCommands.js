import crypto from 'node:crypto';
import { z } from 'zod';
import Room from '../../models/Room.js';
import Message, { serializeMessage } from '../../models/Message.js';
import User from '../../models/User.js';
import Workspace from '../../models/Workspace.js';
import ScheduledMessage from '../../models/ScheduledMessage.js';
import { deliverMessage } from '../messageService.js';
import { defaultGifProvider } from '../providers/gifProvider.js';
import { defaultSummaryService } from '../summaryService.js';
import { getCommandsForUser, registerCommand } from './registry.js';

const MAX_PENDING_REMINDERS = 25;

function parseDurationOrTime(token, timezone = 'UTC', now = new Date()) {
  const rel = token.match(/^(\d+)(s|m|h|d)$/i);
  if (rel) {
    const amount = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const mult = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3600_000 : 86_400_000;
    const ms = amount * mult;
    if (ms < 10_000 || ms > 365 * 86_400_000) return null;
    return new Date(now.getTime() + ms);
  }

  const tomorrowMatch = token.match(/^tomorrow\s+(\d{1,2})(?::(\d{2}))?(am|pm)?$/i);
  if (tomorrowMatch) {
    let hour = Number(tomorrowMatch[1]);
    const minute = Number(tomorrowMatch[2] || 0);
    const ampm = tomorrowMatch[3]?.toLowerCase();
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;

    // Compute tomorrow's date in the user's timezone, then adjust for TZ offset.
    const tomorrow = new Date(now.getTime() + 86_400_000);
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = Object.fromEntries(fmt.formatToParts(tomorrow).map((p) => [p.type, p.value]));
    const utcCandidate = new Date(
      Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour, minute, 0)
    );
    const tzDate = new Date(utcCandidate.toLocaleString('en-US', { timeZone: timezone || 'UTC' }));
    const offsetMs = utcCandidate.getTime() - tzDate.getTime();
    return new Date(utcCandidate.getTime() + offsetMs);
  }

  return null;
}

let registered = false;

export function registerBuiltInCommands() {
  if (registered) return;
  registered = true;

  registerCommand({
    name: 'help',
    description: 'List available slash commands',
    usage: '/help',
    argsSchema: z.object({ args: z.array(z.string()).max(1) }),
    requiredPermission: 'room.read',
    rateLimit: { max: 20, windowMs: 60_000 },
    visibility: 'ephemeral',
    async handler({ userId, room }) {
      const list = getCommandsForUser({ id: userId }, room);
      const lines = list.map((c) => `\`${c.usage}\` — ${c.description}`);
      return { ephemeralText: `Available commands:\n${lines.join('\n')}` };
    },
  });

  registerCommand({
    name: 'me',
    description: 'Send an action message',
    usage: '/me <action>',
    argsSchema: z.object({ rawArgs: z.string().min(1, 'Action text is required').max(1500) }),
    requiredPermission: 'message.send',
    rateLimit: { max: 20, windowMs: 60_000 },
    visibility: 'inChannel',
    async handler({ room, userId, username, rawArgs, io, presence, storageService, floodControl }) {
      return deliverMessage({
        room,
        userId,
        username,
        text: `_${username} ${rawArgs}_`,
        io,
        presence,
        storageService,
        floodControl,
      });
    },
  });

  registerCommand({
    name: 'shrug',
    description: 'Append ¯\\_(ツ)_/¯ to your message',
    usage: '/shrug [text]',
    argsSchema: z.object({ rawArgs: z.string().max(1500) }),
    requiredPermission: 'message.send',
    rateLimit: { max: 20, windowMs: 60_000 },
    visibility: 'inChannel',
    async handler({ room, userId, username, rawArgs, io, presence, storageService, floodControl }) {
      const text = rawArgs ? `${rawArgs} ¯\\_(ツ)_/¯` : '¯\\_(ツ)_/¯';
      return deliverMessage({
        room,
        userId,
        username,
        text,
        io,
        presence,
        storageService,
        floodControl,
      });
    },
  });

  registerCommand({
    name: 'topic',
    description: 'Update the room topic (moderators/admins/owners)',
    usage: '/topic <text>',
    argsSchema: z.object({ rawArgs: z.string().min(1, 'Topic cannot be empty').max(200) }),
    requiredPermission: 'room.rename',
    rateLimit: { max: 10, windowMs: 60_000 },
    visibility: 'inChannel',
    async handler({ room, userId, username, rawArgs, io, presence, storageService, floodControl }) {
      await Room.updateOne(
        { _id: room._id, workspace: room.workspace },
        { $set: { topic: rawArgs } }
      );
      io?.to(`room:${room._id.toString()}`).emit('room:updated', {
        roomId: room._id.toString(),
        topic: rawArgs,
      });
      return deliverMessage({
        room,
        userId,
        username,
        text: `Topic updated to: ${rawArgs}`,
        io,
        presence,
        storageService,
        floodControl,
      });
    },
  });

  registerCommand({
    name: 'poll',
    description: 'Create an interactive poll',
    usage: '/poll "Question" "Opt A" "Opt B"',
    argsSchema: z.object({
      args: z.array(z.string().min(1).max(200)).min(3, 'Provide a question and at least 2 options').max(7),
    }),
    requiredPermission: 'message.send',
    rateLimit: { max: 10, windowMs: 60_000 },
    visibility: 'inChannel',
    async handler({ room, userId, username, args, io }) {
      const [question, ...optionTexts] = args;
      const options = optionTexts.slice(0, 6).map((t) => ({
        id: crypto.randomBytes(4).toString('hex'),
        text: t.slice(0, 80),
        votes: [],
      }));

      const msg = await Message.create({
        workspace: room.workspace,
        room: room._id,
        sender: userId,
        senderName: username,
        kind: 'poll',
        text: question.slice(0, 200),
        poll: {
          question: question.slice(0, 200),
          options,
          multiple: false,
          anonymous: false,
        },
        readBy: [userId],
      });

      const serialized = serializeMessage(msg.toObject());
      io?.to(`room:${room._id.toString()}`).emit('message:new', serialized);
      return { ok: true, id: serialized._id };
    },
  });

  registerCommand({
    name: 'remind',
    description: 'Schedule a reminder (e.g. /remind 2h Check deploy)',
    usage: '/remind <duration|tomorrow 9am> <text>',
    argsSchema: z.object({
      args: z.array(z.string().min(1)).min(2, 'Provide a time and reminder text'),
    }),
    requiredPermission: 'message.send',
    rateLimit: { max: 15, windowMs: 60_000 },
    visibility: 'ephemeral',
    async handler({ room, userId, args }) {
      const pendingCount = await ScheduledMessage.countDocuments({
        sender: userId,
        status: 'pending',
      });
      if (pendingCount >= MAX_PENDING_REMINDERS) {
        return {
          ephemeralText: `You have reached the max pending reminders cap (${MAX_PENDING_REMINDERS}).`,
        };
      }

      const userDoc = await User.findById(userId, { timezone: 1 }).lean();
      const tz = userDoc?.timezone || 'UTC';

      let timeToken = args[0];
      let reminderParts = args.slice(1);
      if (args[0].toLowerCase() === 'tomorrow' && args.length >= 3) {
        timeToken = `${args[0]} ${args[1]}`;
        reminderParts = args.slice(2);
      }

      const sendAt = parseDurationOrTime(timeToken, tz);
      if (!sendAt || reminderParts.length === 0) {
        return {
          ephemeralText:
            'Could not parse reminder time. Examples: `/remind 2h Check deploy` or `/remind "tomorrow 9am" Standup`.',
        };
      }

      const reminderText = `⏰ Reminder: ${reminderParts.join(' ').slice(0, 1800)}`;
      await ScheduledMessage.create({
        room: room._id,
        sender: userId,
        senderName: 'Reminder Bot',
        isBot: true,
        text: reminderText,
        sendAt,
      });

      return {
        ephemeralText: `Reminder scheduled for ${sendAt.toISOString()} (${tz}): "${reminderParts.join(' ')}"`,
      };
    },
  });

  registerCommand({
    name: 'giphy',
    description: 'Search GIFs and pick one to post',
    usage: '/giphy <query>',
    argsSchema: z.object({ rawArgs: z.string().min(1, 'Search query is required').max(80) }),
    requiredPermission: 'message.send',
    rateLimit: { max: 10, windowMs: 60_000 },
    visibility: 'ephemeral',
    async handler({ room, rawArgs, gifProvider = defaultGifProvider }) {
      if (gifProvider.name !== 'mock-gif') {
        const ws = await Workspace.findById(room.workspace, { settings: 1 }).lean();
        if (!ws?.settings?.allowExternalProcessing) {
          return {
            ephemeralText:
              'External GIF search is disabled because "Allow external processing" is off in workspace settings.',
          };
        }
      }

      const candidates = await gifProvider.search(rawArgs, { rating: 'pg', limit: 3 });
      if (candidates.length === 0) {
        return { ephemeralText: `No G/PG GIFs found for "${rawArgs}".` };
      }
      return {
        ephemeralText: `Pick a GIF for "${rawArgs}":`,
        candidates,
      };
    },
  });

  registerCommand({
    name: 'summarize',
    description: 'Summarize recent room messages',
    usage: '/summarize [count]',
    argsSchema: z.object({ args: z.array(z.string()).max(1) }),
    requiredPermission: 'room.summary',
    rateLimit: { max: 5, windowMs: 3600_000 },
    visibility: 'ephemeral',
    async handler({ room, userId, args }) {
      const n = args[0] ? Math.min(Math.max(Number(args[0]) || 50, 5), 100) : 50;
      const result = await defaultSummaryService.summarizeRoom({
        roomId: room._id.toString(),
        workspaceId: room.workspace.toString(),
        userId,
        limit: n,
      });
      return {
        ephemeralText: `Summary (${result.messageCount} messages):\n${result.summary}`,
      };
    },
  });
}
