import { AppError } from '../middleware/errorHandler.js';

export const ROOM_ROLES = ['owner', 'admin', 'moderator', 'member'];
export const GLOBAL_ROLES = ['admin', 'user'];

export const ROLE_RANK = {
  owner: 4,
  admin: 3,
  moderator: 2,
  member: 1,
};

/**
 * Declarative room-role permission matrix.
 * Global admin (`user.globalRole === 'admin'`) is intentionally NOT granted
 * automatic access to private rooms or DMs — global admins only access /api/admin/*
 * endpoints so user privacy in private conversations is preserved.
 */
export const PERMISSION_MATRIX = {
  'room.read': ['owner', 'admin', 'moderator', 'member'],
  'message.send': ['owner', 'admin', 'moderator', 'member'],
  'message.edit_own': ['owner', 'admin', 'moderator', 'member'],
  'message.delete_own': ['owner', 'admin', 'moderator', 'member'],
  'message.delete_any': ['owner', 'admin', 'moderator'],
  'room.rename': ['owner', 'admin'],
  'room.settings': ['owner', 'admin'],
  'room.summary': ['owner', 'admin', 'moderator', 'member'],
  'room.delete': ['owner'],
  'member.invite': ['owner', 'admin', 'moderator'],
  'member.remove': ['owner', 'admin'],
  'role.change': ['owner', 'admin'],
  'ownership.transfer': ['owner'],
};

function getUserId(user) {
  return (user?.id || user?._id || user)?.toString?.() || '';
}

function getMemberRole(room, userId) {
  if (!room || !Array.isArray(room.members) || !userId) return null;
  const member = room.members.find((m) => (m.user?._id || m.user)?.toString() === userId);
  return member?.role || null;
}

/**
 * Central authorization predicate used across REST routes and socket handlers.
 */
export function can(user, action, { room = null, targetUser = null, targetRole = null, message = null } = {}) {
  const userId = getUserId(user);
  if (!userId) return false;

  if (action === 'admin.audit.read') {
    return user?.globalRole === 'admin';
  }

  const allowedRoles = PERMISSION_MATRIX[action];
  if (!allowedRoles) return false;

  const actorRole = getMemberRole(room, userId);
  if (!actorRole || !allowedRoles.includes(actorRole)) {
    return false;
  }

  if (action === 'message.edit_own' || action === 'message.delete_own') {
    const senderId = (message?.sender?._id || message?.sender)?.toString();
    return Boolean(senderId && senderId === userId);
  }

  if (action === 'member.invite') {
    return room?.type === 'private';
  }

  if (action === 'member.remove') {
    if (!room || room.type === 'dm' || !targetUser) return false;
    const targetId = getUserId(targetUser);
    if (!targetId || targetId === userId) return false;
    const targetMemberRole = targetUser.role || getMemberRole(room, targetId);
    if (!targetMemberRole) return false;
    return ROLE_RANK[actorRole] > ROLE_RANK[targetMemberRole];
  }

  if (action === 'role.change') {
    if (!room || room.type === 'dm' || !targetUser) return false;
    const targetId = getUserId(targetUser);
    const currentTargetRole = targetUser.role || getMemberRole(room, targetId);
    if (!currentTargetRole) return false;

    if (targetRole && !ROOM_ROLES.includes(targetRole)) return false;

    // Last owner cannot be demoted.
    if (currentTargetRole === 'owner' && targetRole && targetRole !== 'owner') {
      const ownerCount = room.members.filter((m) => m.role === 'owner').length;
      if (ownerCount <= 1) return false;
    }

    if (actorRole === 'owner') {
      return true;
    }

    if (actorRole === 'admin') {
      // Admins can only manage moderators and members, never owners or other admins.
      const targetIsLower = ROLE_RANK[currentTargetRole] < ROLE_RANK.admin;
      const newRoleIsLower = !targetRole || ROLE_RANK[targetRole] < ROLE_RANK.admin;
      return targetIsLower && newRoleIsLower;
    }

    return false;
  }

  if (action === 'ownership.transfer') {
    if (!room || room.type === 'dm' || !targetUser) return false;
    const targetId = getUserId(targetUser);
    if (!targetId || targetId === userId) return false;
    return actorRole === 'owner' && Boolean(getMemberRole(room, targetId));
  }

  return true;
}

export function assertCan(user, action, context = {}, errorMessage = 'You do not have permission to perform this action') {
  if (!can(user, action, context)) {
    throw new AppError(errorMessage, 403);
  }
}
