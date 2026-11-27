import User from '../../models/User.js';
import Workspace from '../../models/Workspace.js';
import PushSubscription from '../../models/PushSubscription.js';
import { decryptField } from '../cryptoService.js';
import { defaultPushProvider } from '../providers/pushProvider.js';
import { defaultEmailProvider } from '../providers/emailProvider.js';

export function createNotificationDispatcher({
  pushProvider = defaultPushProvider,
  emailProvider = defaultEmailProvider,
} = {}) {
  async function sendPushToUser({ workspaceId, userId, title, body }) {
    if (pushProvider.name !== 'mock-push') {
      const ws = await Workspace.findById(workspaceId, { settings: 1 }).lean();
      if (!ws?.settings?.allowExternalProcessing) {
        return { skipped: true, reason: 'allowExternalProcessing is false', sent: 0 };
      }
    }

    const user = await User.findById(userId, { dnd: 1, globalMute: 1 }).lean();
    if (!user || user.globalMute || user.dnd?.enabled) {
      return { skipped: true, reason: 'User DND or globalMute enabled', sent: 0 };
    }

    const subs = await PushSubscription.find({ user: userId }).lean();
    if (subs.length === 0) {
      return { skipped: false, sent: 0 };
    }

    let sent = 0;
    for (const sub of subs) {
      const keys = JSON.parse(decryptField(sub.keysEnc));
      await pushProvider.send({
        endpoint: sub.endpoint,
        keys,
        payload: { title, body },
      });
      sent += 1;
    }
    return { skipped: false, sent };
  }

  async function sendEmailDigest({ workspaceId, userId, unreadCount, roomNames = [] }) {
    if (emailProvider.name !== 'mock-email') {
      const ws = await Workspace.findById(workspaceId, { settings: 1 }).lean();
      if (!ws?.settings?.allowExternalProcessing) {
        return { skipped: true, reason: 'allowExternalProcessing is false', sent: false };
      }
    }

    const user = await User.findById(userId, { email: 1, username: 1 }).lean();
    if (!user?.email) {
      return { skipped: true, reason: 'No email on user profile', sent: false };
    }

    await emailProvider.send({
      to: user.email,
      subject: `PulseChat Digest: ${unreadCount} unread message(s)`,
      text: `Hi ${user.username}, you have ${unreadCount} unread message(s) across ${roomNames.join(', ') || 'your rooms'}.`,
    });

    return { skipped: false, sent: true };
  }

  return {
    sendPushToUser,
    sendEmailDigest,
  };
}

export const defaultNotificationDispatcher = createNotificationDispatcher();
