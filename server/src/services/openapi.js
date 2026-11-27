import { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  changeMemberRoleSchema,
  createDmSchema,
  createInviteSchema,
  createPollSchema,
  createReportSchema,
  createRoomSchema,
  createWorkspaceInviteSchema,
  createWorkspaceSchema,
  draftSchema,
  loginSchema,
  moderationActionSchema,
  notificationLevelSchema,
  onboardingUpdateSchema,
  presignUploadSchema,
  registerSchema,
  roomSummarySchema,
  scheduleMessageSchema,
  transferWorkspaceSchema,
  updateRoomSchema,
  updateWorkspaceMemberSchema,
  updateWorkspaceSettingsSchema,
  userStatusSchema,
  votePollSchema,
} from '../utils/validators.js';

extendZodWithOpenApi(z);

export function generateOpenApiDocument() {
  const registry = new OpenAPIRegistry();

  registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
  });

  const jsonBody = (schema) => ({
    required: true,
    content: { 'application/json': { schema } },
  });

  const okResp = { 200: { description: 'OK' } };
  const createdResp = { 201: { description: 'Created' } };

  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/register',
    tags: ['Auth'],
    request: { body: jsonBody(registerSchema) },
    responses: createdResp,
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/login',
    tags: ['Auth'],
    request: { body: jsonBody(loginSchema) },
    responses: okResp,
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/rooms',
    tags: ['Rooms'],
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(createRoomSchema) },
    responses: createdResp,
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/rooms/dm',
    tags: ['Rooms'],
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(createDmSchema) },
    responses: createdResp,
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/v1/rooms/{id}',
    tags: ['Rooms'],
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(updateRoomSchema) },
    responses: okResp,
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/v1/rooms/{id}/members/{userId}/role',
    tags: ['Rooms'],
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(changeMemberRoleSchema) },
    responses: okResp,
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/rooms/{id}/invites',
    tags: ['Rooms'],
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(createInviteSchema) },
    responses: createdResp,
  });

  registry.registerPath({
    method: 'put',
    path: '/api/v1/rooms/{id}/draft',
    tags: ['Rooms'],
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(draftSchema) },
    responses: okResp,
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/v1/rooms/{id}/notifications',
    tags: ['Rooms'],
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(notificationLevelSchema) },
    responses: okResp,
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/rooms/{id}/summary',
    tags: ['Rooms'],
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(roomSummarySchema) },
    responses: okResp,
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/rooms/{id}/scheduled',
    tags: ['Scheduled'],
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(scheduleMessageSchema) },
    responses: createdResp,
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/rooms/{id}/polls',
    tags: ['Polls'],
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(createPollSchema) },
    responses: createdResp,
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/messages/{id}/vote',
    tags: ['Polls'],
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(votePollSchema) },
    responses: okResp,
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/uploads/presign',
    tags: ['Uploads'],
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(presignUploadSchema) },
    responses: okResp,
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/reports',
    tags: ['Moderation'],
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(createReportSchema) },
    responses: createdResp,
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/reports/{id}/action',
    tags: ['Moderation'],
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(moderationActionSchema) },
    responses: okResp,
  });

  registry.registerPath({
    method: 'put',
    path: '/api/v1/users/me/status',
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(userStatusSchema) },
    responses: okResp,
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/workspaces',
    tags: ['Workspaces'],
    security: [{ bearerAuth: [] }],
    responses: okResp,
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/workspaces',
    tags: ['Workspaces'],
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(createWorkspaceSchema) },
    responses: createdResp,
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/v1/workspaces/{id}/settings',
    tags: ['Workspaces'],
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(updateWorkspaceSettingsSchema) },
    responses: okResp,
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/v1/workspaces/{id}/members/{userId}',
    tags: ['Workspaces'],
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(updateWorkspaceMemberSchema) },
    responses: okResp,
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/workspaces/{id}/transfer',
    tags: ['Workspaces'],
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(transferWorkspaceSchema) },
    responses: okResp,
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/workspaces/{id}/invites',
    tags: ['Workspaces'],
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(createWorkspaceInviteSchema) },
    responses: createdResp,
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/workspaces/invites/{token}/redeem',
    tags: ['Workspaces'],
    security: [{ bearerAuth: [] }],
    responses: okResp,
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/v1/users/me/onboarding',
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(onboardingUpdateSchema) },
    responses: okResp,
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/workspaces/{id}/demo',
    tags: ['Workspaces'],
    security: [{ bearerAuth: [] }],
    responses: createdResp,
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/v1/workspaces/{id}/demo',
    tags: ['Workspaces'],
    security: [{ bearerAuth: [] }],
    responses: okResp,
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/commands',
    tags: ['Platform'],
    security: [{ bearerAuth: [] }],
    responses: okResp,
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/workspaces/{id}/bots',
    tags: ['Platform'],
    security: [{ bearerAuth: [] }],
    responses: createdResp,
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/bots/messages',
    tags: ['Platform'],
    security: [{ bearerAuth: [] }],
    responses: createdResp,
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/hooks/{id}/{token}',
    tags: ['Webhooks'],
    responses: createdResp,
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/rooms/{id}/webhooks',
    tags: ['Webhooks'],
    security: [{ bearerAuth: [] }],
    responses: createdResp,
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/workspaces/{id}/outgoing-webhooks',
    tags: ['Webhooks'],
    security: [{ bearerAuth: [] }],
    responses: createdResp,
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/search/semantic',
    tags: ['Search'],
    security: [{ bearerAuth: [] }],
    responses: okResp,
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/ai/ask',
    tags: ['AI'],
    security: [{ bearerAuth: [] }],
    responses: okResp,
  });

  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: '3.0.3',
    info: {
      title: 'PulseChat API',
      version: '1.0.0',
      description: 'Real-time chat application REST API (v1)',
    },
    servers: [{ url: '/' }],
  });
}
