import mongoose from 'mongoose';

// Kept as a separate collection rather than embedded on Workspace (unlike Room.members)
// because a workspace can have thousands of members across many rooms, and memberships
// are queried bidirectionally (user -> workspaces for switcher, workspace -> members for directory).
const workspaceMemberSchema = new mongoose.Schema(
  {
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    role: {
      type: String,
      enum: ['owner', 'admin', 'member', 'guest'],
      default: 'member',
      required: true,
    },
    joinedAt: {
      type: Date,
      default: Date.now,
    },
    status: {
      type: String,
      enum: ['active', 'suspended', 'invited'],
      default: 'active',
    },
  },
  {
    timestamps: true,
  }
);

workspaceMemberSchema.index({ workspace: 1, user: 1 }, { unique: true });
workspaceMemberSchema.index({ user: 1, status: 1 });

const WorkspaceMember = mongoose.model('WorkspaceMember', workspaceMemberSchema);
export default WorkspaceMember;
